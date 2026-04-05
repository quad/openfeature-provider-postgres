import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ResolutionDetails,
} from "@openfeature/server-sdk";
import {
  FlagNotFoundError,
  GeneralError,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { NotifyListener } from "./listener.ts";
import type {
  FlagData,
  PostgresProviderOptions,
  RolloutEntry,
} from "./types.ts";
import {
  DEFAULT_CHANNEL,
  DEFAULT_SCHEMA,
  DEFAULT_SYNC_INTERVAL_MS,
} from "./types.ts";

export class PostgresProvider implements Provider {
  readonly metadata = { name: "openfeature-provider-postgres" };
  readonly runsOn = "server" as const;
  events = new OpenFeatureEventEmitter();

  private cache = new Map<string, FlagData>();
  private readonly pool: PostgresProviderOptions["pool"];
  private readonly schema: string;
  private readonly channelName: string;
  private readonly syncIntervalMs: number;
  private readonly listenerOptions: ConstructorParameters<
    typeof NotifyListener
  >[0];
  private listener: NotifyListener | null = null;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: PostgresProviderOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_SCHEMA;
    this.channelName = options.channelName ?? DEFAULT_CHANNEL;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.listenerOptions = {
      pool: this.pool,
      channelName: this.channelName,
      ...(options.createClient ? { createClient: options.createClient } : {}),
    };
  }

  async initialize(): Promise<void> {
    await this.syncCache();

    this.listener = new NotifyListener(this.listenerOptions);
    await this.listener.start({
      onNotification: () => {
        this.syncCache().then(() => {
          this.events.emit(ProviderEvents.ConfigurationChanged);
        });
      },
      onReconnect: () => {
        this.syncCache().then(() => {
          this.events.emit(ProviderEvents.ConfigurationChanged);
        });
      },
      onDisconnect: () => {
        this.events.emit(ProviderEvents.Stale);
      },
    });

    this.syncInterval = setInterval(() => {
      this.syncCache().then(() => {
        this.events.emit(ProviderEvents.ConfigurationChanged);
      });
    }, this.syncIntervalMs);
  }

  async onClose(): Promise<void> {
    await this[Symbol.asyncDispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    if (this.listener) {
      await this.listener.stop();
      this.listener = null;
    }
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    return await this.resolve<boolean>(flagKey, defaultValue, "boolean", context);
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    return await this.resolve<string>(flagKey, defaultValue, "string", context);
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    return await this.resolve<number>(flagKey, defaultValue, "number", context);
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    return await this.resolve<T>(flagKey, defaultValue, "object", context);
  }

  private async resolve<T>(
    flagKey: string,
    defaultValue: T,
    expectedType: FlagData["flagType"],
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    const flag = this.cache.get(flagKey);
    if (!flag) throw new FlagNotFoundError(`Flag "${flagKey}" not found`);

    if (!flag.enabled) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.DISABLED,
      };
    }

    if (flag.flagType !== expectedType) {
      throw new TypeMismatchError(
        `Flag "${flagKey}" is type "${flag.flagType}", requested "${expectedType}"`,
      );
    }

    let chosenVariant: string;
    let reason: string;

    if (flag.rollout && context.targetingKey) {
      chosenVariant = await this.pickRolloutVariant(flag, context.targetingKey);
      reason = "SPLIT";
    } else {
      chosenVariant = flag.defaultVariant;
      reason = StandardResolutionReasons.STATIC;
    }

    const value = flag.variants.get(chosenVariant);
    if (value === undefined) {
      throw new GeneralError(
        `Variant "${chosenVariant}" not found for flag "${flagKey}"`,
      );
    }

    return { value: value as T, variant: chosenVariant, reason };
  }

  private async pickRolloutVariant(
    flag: FlagData,
    targetingKey: string,
  ): Promise<string> {
    const data = new TextEncoder().encode(targetingKey + flag.flagKey);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const bucket = new DataView(buf).getUint32(0, false) % 100;

    let cumulative = 0;
    for (const entry of flag.rollout ?? []) {
      cumulative += entry.percentage;
      if (bucket < cumulative) {
        return entry.variant;
      }
    }

    return flag.defaultVariant;
  }

  private async syncCache(): Promise<void> {
    try {
      const s = quoteIdent(this.schema);
      const result = await this.pool.query(`
        SELECT
          ff.flag_key,
          ff.flag_type,
          ff.default_variant,
          ff.enabled,
          fv.variant,
          fv.value,
          fr.percentage
        FROM ${s}.feature_flags ff
        JOIN ${s}.flag_variants fv USING (flag_key, flag_type)
        LEFT JOIN ${s}.flag_rollouts fr USING (flag_key, variant)
      `);

      const grouped = new Map<string, FlagData>();

      for (const row of result.rows) {
        let flag = grouped.get(row.flag_key);
        if (!flag) {
          flag = {
            flagKey: row.flag_key,
            flagType: row.flag_type,
            defaultVariant: row.default_variant,
            enabled: row.enabled,
            variants: new Map(),
            rollout: null,
          };
          grouped.set(row.flag_key, flag);
        }

        flag.variants.set(row.variant, row.value);

        if (row.percentage != null) {
          if (!flag.rollout) flag.rollout = [];
          // Avoid duplicate rollout entries when JOIN produces multiple rows
          if (
            !flag.rollout.some((r: RolloutEntry) => r.variant === row.variant)
          ) {
            flag.rollout.push({
              variant: row.variant,
              percentage: row.percentage,
            });
          }
        }
      }

      // Validate default variants
      for (const flag of grouped.values()) {
        if (!flag.variants.has(flag.defaultVariant)) {
          console.warn(
            `Flag "${flag.flagKey}": default_variant "${flag.defaultVariant}" not found in variants`,
          );
        }
        // Warn if rollout percentages exceed 100
        if (flag.rollout) {
          const total = flag.rollout.reduce(
            (sum: number, r: RolloutEntry) => sum + r.percentage,
            0,
          );
          if (total > 100) {
            console.warn(
              `Flag "${flag.flagKey}": rollout percentages sum to ${total} (>100)`,
            );
          }
        }
      }

      this.cache = grouped;
    } catch (err) {
      console.error("Failed to sync flag cache:", err);
    }
  }
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
