import { clearInterval, setInterval } from "node:timers";
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
  events: OpenFeatureEventEmitter = new OpenFeatureEventEmitter();

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
  private initialized = false;

  constructor(options: PostgresProviderOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_SCHEMA;
    this.channelName = options.channelName ?? DEFAULT_CHANNEL;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.listenerOptions = {
      pool: this.pool,
      channelName: this.channelName,
      ...(options.createClient ? { createClient: options.createClient } : {}),
      ...(options.listenerClientConfig
        ? { clientConfig: options.listenerClientConfig }
        : {}),
    };
  }

  async initialize(_context?: EvaluationContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.syncCache();

    this.listener = new NotifyListener(this.listenerOptions);
    await this.listener.start({
      onNotification: () => {
        this.syncCache().then((changed) => {
          if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
        }).catch(() => {
          this.events.emit(ProviderEvents.Stale);
        });
      },
      onReconnect: () => {
        this.syncCache().then((changed) => {
          if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
        }).catch(() => {
          this.events.emit(ProviderEvents.Stale);
        });
      },
      onDisconnect: () => {
        this.events.emit(ProviderEvents.Stale);
      },
    });

    this.syncInterval = setInterval(() => {
      this.syncCache().then((changed) => {
        if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
      }).catch(() => {
        this.events.emit(ProviderEvents.Stale);
      });
    }, this.syncIntervalMs);
    this.syncInterval.unref();
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
    return await this.resolve<boolean>(
      flagKey,
      defaultValue,
      "boolean",
      context,
    );
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
      reason = StandardResolutionReasons.SPLIT;
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

    // Bucket divisor: Math.max(total, 100)
    //
    // When percentages sum to ≤ 100: divisor is 100. Unallocated traffic
    // (100 − total) falls through the loop and returns the default variant.
    //
    // When percentages sum to > 100 (misconfiguration): divisor is the actual
    // total, giving proportional normalization — e.g. 70/70 produces a 50/50
    // split rather than silently skewing the distribution toward earlier entries.
    const rollout = flag.rollout ?? [];
    const total = rollout.reduce((sum, r) => sum + r.percentage, 0);
    const bucket = new DataView(buf).getUint32(0, false) % Math.max(total, 100);

    let cumulative = 0;
    for (const entry of rollout) {
      cumulative += entry.percentage;
      if (bucket < cumulative) {
        return entry.variant;
      }
    }

    return flag.defaultVariant;
  }

  private async syncCache(): Promise<boolean> {
    const s = quoteIdent(this.schema);
    const result = await this.pool.query(`
      SELECT
        ff.flag_key,
        ff.flag_type,
        ff.enabled,
        fv.variant,
        fv.value,
        fv.is_default,
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
          defaultVariant: "",
          enabled: row.enabled,
          variants: new Map(),
          rollout: null,
        };
        grouped.set(row.flag_key, flag);
      }

      flag.variants.set(row.variant, row.value);

      if (row.is_default === true) {
        flag.defaultVariant = row.variant;
      }

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

    const changed = serializeCache(grouped) !== serializeCache(this.cache);
    this.cache = grouped;
    return changed;
  }
}

function serializeCache(cache: Map<string, FlagData>): string {
  return JSON.stringify(
    [...cache.entries()]
      .sort(([a], [b]) => a < b ? -1 : 1)
      .map(([k, f]) => [
        k,
        {
          ...f,
          variants: [...f.variants.entries()].sort(([a], [b]) =>
            a < b ? -1 : 1
          ),
          rollout: f.rollout
            ? [...f.rollout].sort((a, b) => a.variant < b.variant ? -1 : 1)
            : null,
        },
      ]),
  );
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
