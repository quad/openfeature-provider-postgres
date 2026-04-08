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
import { debounce } from "@std/async/debounce";
import { backOff } from "exponential-backoff";
import pg from "pg";
import { xxh32 } from "xxh32";

interface FlagData {
  // Must match openfeature.flag_type enum in schema.sql.
  flagType: "boolean" | "string" | "number" | "object";
  defaultVariant: string;
  enabled: boolean;
  variants: Map<string, unknown>;
  rollout: { variant: string; percentage: number }[] | null;
}

export interface PostgresProviderOptions {
  pool: pg.Pool;
  schema?: string;
}

const DEFAULT_SCHEMA = "openfeature";
const CHANNEL = "openfeature_flag_change";
const SYNC_INTERVAL_MS = 300_000;
const DEBOUNCE_MS = 100;
const RECONNECT_MAX_DELAY_MS = 30_000;

export class PostgresProvider implements Provider {
  readonly metadata = { name: "openfeature-provider-postgres" };
  readonly runsOn = "server" as const;
  events: OpenFeatureEventEmitter = new OpenFeatureEventEmitter();

  private cache = new Map<string, FlagData>();
  private evaluatedKeys = new Set<string>();
  private lastResultJson = "";
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private stopListener = () => {};
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private state: "uninitialized" | "ready" | "disposed" = "uninitialized";

  private readonly debouncedSync = debounce(() => {
    this.syncCache().then((changed) => {
      if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
    }).catch(() => {
      this.events.emit(ProviderEvents.Stale);
    });
  }, DEBOUNCE_MS);

  constructor(options: PostgresProviderOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_SCHEMA;
  }

  async initialize(_context?: EvaluationContext): Promise<void> {
    if (this.state !== "uninitialized") return;

    await this.syncCache();

    this.stopListener = await startNotifyListener(
      this.pool,
      CHANNEL,
      this.debouncedSync,
      this.debouncedSync,
      () => this.events.emit(ProviderEvents.Stale),
    );

    this.syncInterval = setInterval(() => {
      this.debouncedSync();
      this.flushEvaluations().catch(() => {});
    }, SYNC_INTERVAL_MS).unref();
    this.state = "ready";
  }

  async onClose(): Promise<void> {
    if (this.state !== "ready") return;
    this.state = "disposed";

    this.stopListener();
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.debouncedSync.clear();
    await this.flushEvaluations().catch(() => {});
  }

  // deno-lint-ignore require-await -- Provider interface requires Promise return
  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolve(flagKey, defaultValue, "boolean", context);
  }

  // deno-lint-ignore require-await -- Provider interface requires Promise return
  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    return this.resolve(flagKey, defaultValue, "string", context);
  }

  // deno-lint-ignore require-await -- Provider interface requires Promise return
  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    return this.resolve(flagKey, defaultValue, "number", context);
  }

  // deno-lint-ignore require-await -- Provider interface requires Promise return
  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    return this.resolve(flagKey, defaultValue, "object", context);
  }

  private resolve<T>(
    flagKey: string,
    defaultValue: T,
    expectedType: FlagData["flagType"],
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    const flag = this.cache.get(flagKey);
    if (!flag) throw new FlagNotFoundError(`Flag "${flagKey}" not found`);

    if (flag.flagType !== expectedType) {
      throw new TypeMismatchError(
        `Flag "${flagKey}" is type "${flag.flagType}", requested "${expectedType}"`,
      );
    }

    this.evaluatedKeys.add(flagKey);

    if (!flag.enabled) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.DISABLED,
      };
    }

    let chosenVariant: string;
    let reason: string;

    if (flag.rollout && context.targetingKey) {
      chosenVariant = this.pickRolloutVariant(
        flagKey,
        flag,
        context.targetingKey,
      );
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

  private pickRolloutVariant(
    flagKey: string,
    flag: FlagData,
    targetingKey: string,
  ): string {
    const hash = xxh32(`${targetingKey}\0${flagKey}`);

    // When percentages sum to ≤ 100, unallocated traffic falls through to the
    // default variant. When > 100 (misconfiguration), the actual total is used
    // as divisor, giving proportional normalization — e.g. 70/70 → 50/50.
    const rollout = flag.rollout ?? [];
    const total = rollout.reduce((sum, r) => sum + r.percentage, 0);
    const bucket = hash % Math.max(total, 100);

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

      if (row.percentage == null) {
        flag.defaultVariant = row.variant;
      } else {
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

  private async flushEvaluations(): Promise<void> {
    if (this.evaluatedKeys.size === 0) return;
    const keys = [...this.evaluatedKeys];
    this.evaluatedKeys.clear();
    const s = pg.escapeIdentifier(this.schema);
    await this.pool.query(
      `INSERT INTO ${s}.flag_evaluations (flag_key)
       SELECT unnest($1::text[])
       ON CONFLICT (flag_key) DO UPDATE SET last_evaluated_at = now()`,
      [keys],
    );
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
): Promise<() => void> {
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
    backOff(async () => {
      client = await connect();
    }, {
      numOfAttempts: Infinity,
      maxDelay: RECONNECT_MAX_DELAY_MS,
      jitter: "full",
      retry: () => state !== "stopped",
    })
      .then(() => onReconnect())
      .catch(() => {
        // stopped during reconnection — nothing to do
      });
  }

  let client = await connect();

  return () => {
    const shouldRelease = state === "listening";
    state = "stopped";
    if (shouldRelease) client.release(true);
  };
}
