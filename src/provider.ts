import { clearTimeout, setTimeout } from "node:timers";
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
import { debounce } from "@std/async/debounce";
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
  private evaluatedVariantIds = new Set<number>();
  private lastResultHash = NaN;
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private stopListener: () => Promise<void> = () => Promise.resolve();
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
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

    const scheduleSync = () => {
      this.syncTimeout = setTimeout(() => {
        this.debouncedSync();
        this.flushEvaluations();
        scheduleSync();
      }, Math.random() * SYNC_INTERVAL_MS).unref();
    };
    scheduleSync();
    this.state = "ready";
  }

  async onClose(): Promise<void> {
    if (this.state !== "ready") return;
    this.state = "disposed";

    await this.stopListener();
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.debouncedSync.clear();
    await this.flushEvaluations();
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

function getOrInsertComputed<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let val = map.get(key);
  if (val === undefined) {
    val = create();
    map.set(key, val);
  }
  return val;
}

function createSignal() {
  const { resolve, promise } = Promise.withResolvers<void>();
  return {
    fired: false,
    fire() {
      this.fired = true;
      resolve();
    },
    promise,
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
