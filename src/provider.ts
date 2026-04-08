import { clearInterval, setInterval } from "node:timers";
import { debounce } from "@std/async/debounce";
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
import { backOff } from "exponential-backoff";
import pg from "pg";

interface FlagData {
  flagType: "boolean" | "string" | "number" | "object";
  defaultVariant: string;
  enabled: boolean;
  variants: Map<string, unknown>;
  rollout: { variant: string; percentage: number }[] | null;
}

export interface PostgresProviderOptions {
  pool: pg.Pool;
  schema?: string;
  channelName?: string;
  syncIntervalMs?: number;
}

const DEFAULT_SCHEMA = "openfeature";
const DEFAULT_CHANNEL = "flag_change";
const DEFAULT_SYNC_INTERVAL_MS = 300_000;

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
  private debouncedSync: ReturnType<typeof debounce> | null = null;
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

    const sync = this.debouncedSync = debounce(() => {
      this.syncCache().then((changed) => {
        if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
      }).catch(() => {
        this.events.emit(ProviderEvents.Stale);
      });
    }, 100);

    this.listener = await startNotifyListener(
      this.pool,
      this.channelName,
      sync,
      sync,
      () => this.events.emit(ProviderEvents.Stale),
    );

    this.syncInterval = setInterval(sync, this.syncIntervalMs).unref();
    this.state = "ready";
  }

  async onClose(): Promise<void> {
    if (this.state !== "ready") return;
    this.state = "disposed";

    this.debouncedSync?.clear();
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
      chosenVariant = await this.pickRolloutVariant(flagKey, flag, context.targetingKey);
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
    flagKey: string,
    flag: FlagData,
    targetingKey: string,
  ): Promise<string> {
    const data = new TextEncoder().encode(`${targetingKey}\0${flagKey}`);
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
        fv.percentage
      FROM ${s}.feature_flags ff
      JOIN ${s}.flag_variants fv USING (flag_key, flag_type)
      ORDER BY ff.flag_key, fv.variant
    `);

    const resultJson = JSON.stringify(result.rows);
    if (resultJson === this.lastResultJson) return false;
    this.lastResultJson = resultJson;

    const grouped = new Map<string, FlagData>();

    for (const row of result.rows) {
      const flag = getOrInsertComputed(grouped, row.flag_key, () => ({
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
        flag.rollout ||= [];
        flag.rollout.push({
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

async function startNotifyListener(
  pool: pg.Pool,
  channelName: string,
  onNotification: () => void,
  onReconnect: () => void,
  onConnectionLost: () => void,
): Promise<Disposable> {
  let state: "listening" | "reconnecting" | "stopped" = "stopped";

  async function connect(): Promise<pg.PoolClient> {
    const c = await pool.connect();
    c.on("notification", onNotification);
    c.on("error", handleConnectionLost);
    c.on("end", handleConnectionLost);
    await c.query(`LISTEN ${pg.escapeIdentifier(channelName)}`);
    state = "listening";
    return c;
  }

  function handleConnectionLost(): void {
    if (state === "stopped" || state === "reconnecting") return;
    state = "reconnecting";
    client.release(true);
    onConnectionLost();
    backOff(async () => { client = await connect(); }, {
      numOfAttempts: Infinity,
      maxDelay: 30_000,
      jitter: "full",
      retry: () => state !== "stopped",
    })
      .then(() => onReconnect())
      .catch(() => {
        // stopped during reconnection — nothing to do
      });
  }

  let client = await connect();

  return {
    [Symbol.dispose]() {
      const wasListening = state === "listening";
      state = "stopped";
      if (wasListening) client.release(true);
    },
  };
}

