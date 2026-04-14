import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ResolutionDetails,
} from "@openfeature/server-sdk";
import {
  FlagNotFoundError,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { abortable } from "@std/async/abortable";
import { delay } from "@std/async/delay";
import { retry } from "@std/async/retry";
import pg from "pg";
import { xxh32 } from "xxh32";

interface FlagData {
  flagType: "boolean" | "string" | "number" | "object";
  enabled: boolean;
  variants: { id: number; variant: string; value: unknown; weight: number }[];
}

/** Options for {@linkcode PostgresProvider}. */
export interface PostgresProviderOptions {
  /** Connection pool used for flag queries and evaluation tracking. */
  pool: pg.Pool;
  /** Schema containing the flag tables. Defaults to `"openfeature"`. */
  schema?: string;
  /** Apply jitter to sync timers. Set to `false` for deterministic timing. */
  jitter?: boolean;
}

const DEFAULT_SCHEMA = "openfeature";
const CHANNEL = "openfeature_flag_change";

// All jittered delays use Equal Jitter: max/2 + random * max/2
// https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
//
// Periodic: computed once per instance for stable, debuggable scheduling.
// https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
const PERIODIC_SYNC_MAX_MS = 600_000;
// NOTIFY: re-randomized on each event to spread cross-instance thundering herd.
const NOTIFY_SYNC_MAX_MS = 1_000;
// Reconnect: exponential backoff with full jitter, capped at this delay.
const RECONNECT_MAX_MS = 30_000;

/**
 * PostgreSQL-backed OpenFeature provider.
 *
 * Flags are cached in memory and refreshed via `LISTEN`/`NOTIFY` with a
 * periodic full sync as a fallback. Each instance holds one dedicated
 * connection from the pool for `LISTEN`.
 */
export class PostgresProvider implements Provider {
  readonly metadata = { name: "openfeature-provider-postgres" };
  readonly runsOn = "server" as const;
  readonly events: OpenFeatureEventEmitter = new OpenFeatureEventEmitter();

  private cache = new Map<string, FlagData>();
  private evaluatedVariantIds = new Set<number>();
  private lastResultHash = NaN;
  private readonly jitter: (max: number) => number;
  private readonly periodicSyncMs: number;
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly stop = new AbortController();
  private readonly syncSignal = createEvent<"notify" | "sync">();
  private done: Promise<void> | null = null;

  constructor(options: PostgresProviderOptions) {
    this.jitter = options.jitter === false
      ? (max) => max
      : (max) => max / 2 + Math.random() * max / 2;
    this.periodicSyncMs = this.jitter(PERIODIC_SYNC_MAX_MS);
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_SCHEMA;
  }

  async initialize(_context?: EvaluationContext): Promise<void> {
    if (this.done) return;

    await this.loadFlags();

    const listenerDone = await startNotifyListener(
      this.pool,
      CHANNEL,
      this.stop.signal,
      () => this.syncSignal.set("notify"),
      () => this.syncSignal.set("sync"),
      () =>
        this.events.emit(ProviderEvents.Stale, {
          message: "LISTEN connection lost",
        }),
    );

    this.done = this.lifecycle()
      .finally(() => this.flushEvaluations())
      .finally(listenerDone);
  }

  async onClose(): Promise<void> {
    if (!this.done) return;

    this.stop.abort();
    await this.done;
  }

  private async lifecycle(): Promise<void> {
    const sleep = (ms: number) =>
      delay(ms, { signal: this.stop.signal, persistent: false }).catch(
        () => {},
      );

    while (true) {
      const reason = await abortable(
        Promise.race([
          sleep(this.periodicSyncMs).then(() => "sync" as const),
          this.syncSignal.wait(),
        ]),
        this.stop.signal,
      ).catch(() => "stop" as const);
      this.syncSignal.reset();
      if (reason === "stop") break;
      if (reason === "notify") await sleep(this.jitter(NOTIFY_SYNC_MAX_MS));
      await this.refreshCache();
      if (reason === "sync") await this.flushEvaluations();
    }
  }

  private async refreshCache(): Promise<void> {
    let changed: boolean;
    try {
      changed = await this.loadFlags();
    } catch (err) {
      this.events.emit(ProviderEvents.Stale, {
        message: `${err}`,
      });
      return;
    }
    if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
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

    const chosen = this.pickVariant(
      flagKey,
      flag,
      context.targetingKey ?? flagKey,
    );
    if (!chosen) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.DISABLED,
      };
    }

    this.evaluatedVariantIds.add(chosen.id);
    const reason = context.targetingKey
      ? StandardResolutionReasons.SPLIT
      : StandardResolutionReasons.STATIC;
    return { value: chosen.value as T, variant: chosen.variant, reason };
  }

  private pickVariant(
    flagKey: string,
    flag: FlagData,
    targetingKey: string,
  ): FlagData["variants"][number] | null {
    const total = flag.variants.reduce((sum, v) => sum + v.weight, 0);
    if (total === 0) return null;

    const hash = xxh32(`${targetingKey}\0${flagKey}`);
    const bucket = hash % total;

    let cumulative = 0;
    for (const v of flag.variants) {
      cumulative += v.weight;
      if (bucket < cumulative) return v;
    }
    return flag.variants[flag.variants.length - 1];
  }

  private async loadFlags(): Promise<boolean> {
    const s = pg.escapeIdentifier(this.schema);
    const result = await this.pool.query(`
      SELECT f.flag_key, f.flag_type, f.enabled, fv.id, fv.variant, fv.value, fv.weight
      FROM ${s}.flags f
      JOIN ${s}.flag_variants fv USING (flag_key, flag_type)
      ORDER BY f.flag_key, fv.variant
    `);

    const resultHash = xxh32(JSON.stringify(result.rows));
    if (resultHash === this.lastResultHash) return false;
    this.lastResultHash = resultHash;

    const grouped = new Map<string, FlagData>();

    for (const row of result.rows) {
      const flag = getOrInsertComputed(grouped, row.flag_key, () => ({
        flagType: row.flag_type,
        enabled: row.enabled,
        variants: [],
      }));
      flag.variants.push({
        id: row.id,
        variant: row.variant,
        value: row.value,
        weight: row.weight,
      });
    }

    this.cache = grouped;
    return true;
  }

  private async flushEvaluations(): Promise<void> {
    if (this.evaluatedVariantIds.size === 0) return;
    const ids = [...this.evaluatedVariantIds];
    this.evaluatedVariantIds.clear();
    const s = pg.escapeIdentifier(this.schema);
    try {
      await this.pool.query(
        `INSERT INTO ${s}.flag_evaluations AS fe (flag_variant_id)
         SELECT fv.id FROM unnest($1::int[]) AS v
         JOIN ${s}.flag_variants fv ON fv.id = v
         ON CONFLICT (flag_variant_id) DO UPDATE SET last_evaluated_at = GREATEST(fe.last_evaluated_at, now())`,
        [ids],
      );
    } catch (err) {
      for (const id of ids) this.evaluatedVariantIds.add(id);
      this.events.emit(ProviderEvents.Stale, {
        message: `flush evaluations failed: ${err}`,
      });
    }
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

function createEvent<T = void>() {
  let signaled = false;
  let { resolve, promise } = Promise.withResolvers<T>();
  return {
    get signaled() {
      return signaled;
    },
    wait() {
      return promise;
    },
    set(v: T) {
      signaled = true;
      resolve(v);
    },
    reset() {
      if (!signaled) return;
      signaled = false;
      ({ resolve, promise } = Promise.withResolvers<T>());
    },
  };
}

async function startNotifyListener(
  pool: pg.Pool,
  channelName: string,
  signal: AbortSignal,
  onNotification: () => void,
  onReconnect: () => void,
  onConnectionLost: () => void,
): Promise<() => Promise<void>> {
  async function* session() {
    const lost = createEvent();
    const c = await pool.connect();
    try {
      c.on("notification", onNotification);
      c.on("error", () => lost.set());
      c.on("end", () => lost.set());
      await c.query(`LISTEN ${pg.escapeIdentifier(channelName)}`);
      yield;
      await abortable(lost.wait(), signal).catch(() => {});
    } finally {
      c.release(true);
    }
  }

  let s = session();
  await s.next();

  async function lifecycle() {
    while (true) {
      await s.next();
      if (signal.aborted) break;

      onConnectionLost();
      try {
        s = await retry(async () => {
          const fresh = session();
          await fresh.next();
          return fresh;
        }, {
          maxAttempts: Infinity,
          maxTimeout: RECONNECT_MAX_MS,
          jitter: 1,
          signal,
        });
      } catch {
        break;
      }
      onReconnect();
    }
  }

  const done = lifecycle();
  return () => done;
}
