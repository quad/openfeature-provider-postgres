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
import pg from "pg";
import { startNotifyListener } from "./listener.ts";
import type {
  FlagData,
  PostgresProviderOptions,
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
  private lastResultJson = "";
  private readonly pool: PostgresProviderOptions["pool"];
  private readonly schema: string;
  private readonly channelName: string;
  private readonly syncIntervalMs: number;
  private listener: Disposable | null = null;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private state: "uninitialized" | "ready" | "disposed" = "uninitialized";

  constructor(options: PostgresProviderOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_SCHEMA;
    this.channelName = options.channelName ?? DEFAULT_CHANNEL;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  }

  async initialize(_context?: EvaluationContext): Promise<void> {
    if (this.state !== "uninitialized") return;

    await this.syncCache();

    this.listener = await startNotifyListener({
      pool: this.pool,
      channelName: this.channelName,
      onNotification: () => this.syncAndEmit(),
      onReconnect: () => this.syncAndEmit(),
      onConnectionLost: () => {
        this.events.emit(ProviderEvents.Stale);
      },
    });

    this.syncInterval = setInterval(() => this.syncAndEmit(), this.syncIntervalMs).unref();
    this.state = "ready";
  }

  async onClose(): Promise<void> {
    if (this.state !== "ready") return;
    this.state = "disposed";

    if (this.syncInterval) clearInterval(this.syncInterval);
    this.listener?.[Symbol.dispose]();
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
    // Big-endian read for consistent bucketing across architectures
    const bucket = new DataView(buf).getUint32(0) % Math.max(total, 100);

    let cumulative = 0;
    for (const entry of rollout) {
      cumulative += entry.percentage;
      if (bucket < cumulative) {
        return entry.variant;
      }
    }

    return flag.defaultVariant;
  }

  private syncAndEmit(): void {
    this.syncCache().then((changed) => {
      if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
    }).catch(() => {
      this.events.emit(ProviderEvents.Stale);
    });
  }

  private async syncCache(): Promise<boolean> {
    const s = pg.escapeIdentifier(this.schema);
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
      ORDER BY ff.flag_key, fv.variant
    `);

    const resultJson = JSON.stringify(result.rows);
    if (resultJson === this.lastResultJson) return false;
    this.lastResultJson = resultJson;

    const grouped = new Map<string, FlagData>();

    for (const row of result.rows) {
      const flag = getOrInsertComputed(grouped, row.flag_key, () => ({
        flagKey: row.flag_key,
        flagType: row.flag_type,
        defaultVariant: "",
        enabled: row.enabled,
        variants: new Map(),
        rollout: null,
      }));

      flag.variants.set(row.variant, row.value);

      if (row.is_default === true) {
        flag.defaultVariant = row.variant;
      }

      if (row.percentage != null) {
        (flag.rollout ||= []).push({
          variant: row.variant,
          percentage: row.percentage,
        });
      }
    }

    this.cache = grouped;
    return true;
  }
}

function getOrInsertComputed<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let val = map.get(key);
  if (val === undefined) {
    val = create();
    map.set(key, val);
  }
  return val;
}

