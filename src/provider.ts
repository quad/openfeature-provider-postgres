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
import { delay } from "@std/async/delay";
import { backOff } from "exponential-backoff";
import pg from "pg";
import { xxh32 } from "xxh32";

interface FlagData {
  flagType: "boolean" | "string" | "number" | "object";
  enabled: boolean;
  variants: { id: number; variant: string; value: unknown; weight: number }[];
}

export interface PostgresProviderOptions {
  pool: pg.Pool;
  schema?: string;
  jitter?: boolean;
}

const DEFAULT_SCHEMA = "openfeature";
const CHANNEL = "openfeature_flag_change";
const PERIODIC_SYNC_MAX_MS = 600_000;
const NOTIFY_DELAY_MAX_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

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
  private readonly stopSignal = createSignal<"stop">();
  private readonly syncSignal = createSignal<SyncReason>();
  private done: Promise<void> | null = null;

  constructor(options: PostgresProviderOptions) {
    this.jitter = options.jitter === false
      ? (max) => max
      : (max) => Math.random() * max;
    this.periodicSyncMs = this.jitter(PERIODIC_SYNC_MAX_MS);
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_SCHEMA;
  }

  async initialize(_context?: EvaluationContext): Promise<void> {
    if (this.done) return;

    await this.syncCache();

    const stopListener = await startNotifyListener(
      this.pool,
      CHANNEL,
      () => this.syncSignal.fire("notify"),
      () => this.syncSignal.fire("reconnect"),
      () => this.events.emit(ProviderEvents.Stale),
    );

    this.done = this.lifecycle(stopListener);
  }

  async onClose(): Promise<void> {
    if (!this.done || this.stopSignal.fired) return;

    this.stopSignal.fire("stop");
    await this.done;
  }

  private async lifecycle(
    stopListener: () => Promise<void>,
  ): Promise<void> {
    await using stack = new AsyncDisposableStack();
    const timers = stack.adopt(new AbortController(), (c) => c.abort());
    stack.defer(() => this.flushEvaluations());
    stack.defer(stopListener);

    const sleep = (ms: number) =>
      delay(ms, { signal: timers.signal, persistent: false }).catch(() => {});

    while (true) {
      const reason = await Promise.race([
        sleep(this.periodicSyncMs).then(() => "periodic" as const),
        this.syncSignal.promise.then(async (r) => {
          if (r === "notify") await sleep(this.jitter(NOTIFY_DELAY_MAX_MS));
          return r;
        }),
        this.stopSignal.promise,
      ]);
      if (reason === "stop") break;
      await this.performSync(reason);
    }
  }

  private async performSync(reason: SyncReason | "periodic"): Promise<void> {
    let changed: boolean;
    try {
      changed = await this.syncCache();
    } catch {
      this.events.emit(ProviderEvents.Stale);
      return;
    }
    if (changed) this.events.emit(ProviderEvents.ConfigurationChanged);
    if (reason === "periodic") this.flushEvaluations();
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

  private async syncCache(): Promise<boolean> {
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
         SELECT unnest($1::int[])
         ON CONFLICT (flag_variant_id) DO UPDATE SET last_evaluated_at = GREATEST(fe.last_evaluated_at, now())`,
        [ids],
      );
    } catch {
      for (const id of ids) this.evaluatedVariantIds.add(id);
    }
  }
}

type SyncReason = "notify" | "reconnect";

function getOrInsertComputed<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let val = map.get(key);
  if (val === undefined) {
    val = create();
    map.set(key, val);
  }
  return val;
}

function createSignal<T = void>() {
  let { resolve, promise } = Promise.withResolvers<T>();
  return {
    fired: false,
    get promise() {
      return promise;
    },
    fire(value: T) {
      this.fired = true;
      resolve(value);
      ({ resolve, promise } = Promise.withResolvers<T>());
    },
  };
}

async function startNotifyListener(
  pool: pg.Pool,
  channelName: string,
  onNotification: () => void,
  onReconnect: () => void,
  onConnectionLost: () => void,
): Promise<() => Promise<void>> {
  const stop = createSignal();

  async function* session() {
    const lost = createSignal();
    const c = await pool.connect();
    try {
      c.on("notification", onNotification);
      c.on("error", () => lost.fire());
      c.on("end", () => lost.fire());
      await c.query(`LISTEN ${pg.escapeIdentifier(channelName)}`);
      yield;
      await Promise.race([lost.promise, stop.promise]);
    } finally {
      c.release(true);
    }
  }

  let s = session();
  await s.next();

  async function lifecycle() {
    while (true) {
      await s.next();
      if (stop.fired) break;

      onConnectionLost();
      try {
        s = await backOff(async () => {
          const fresh = session();
          await fresh.next();
          return fresh;
        }, {
          numOfAttempts: Infinity,
          maxDelay: RECONNECT_MAX_DELAY_MS,
          jitter: "full",
          retry: () => !stop.fired,
        });
      } catch {
        break;
      }
      onReconnect();
    }
  }

  const done = lifecycle();
  return async () => {
    stop.fire();
    await done;
  };
}
