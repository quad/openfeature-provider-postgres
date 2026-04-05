# Research: Postgres-backed OpenFeature Provider

## 1. OpenFeature Provider Interface (JS Server SDK)

The OpenFeature JS Server SDK defines the `Provider` interface that all
server-side providers must implement. The key types and contracts are:

### Provider Interface

```typescript
interface Provider extends CommonProvider<ServerProviderStatus> {
  readonly hooks?: Hook[];

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<boolean>>;

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<string>>;

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<number>>;

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger,
  ): Promise<ResolutionDetails<T>>;
}
```

### ResolutionDetails

```typescript
type ResolutionDetails<U> = {
  value: U;
  variant?: string;
  flagMetadata?: FlagMetadata;
  reason?: ResolutionReason; // STATIC | DEFAULT | TARGETING_MATCH | SPLIT | CACHED | DISABLED | STALE | ERROR
  errorCode?: ErrorCode;
  errorMessage?: string;
};
```

### EvaluationContext

```typescript
type EvaluationContext = {
  targetingKey?: string; // uniquely identifies the subject of evaluation
} & Record<string, EvaluationContextValue>;
```

### Provider Events

Providers can emit events to signal state changes:

- `PROVIDER_READY` - provider is ready to evaluate
- `PROVIDER_ERROR` - provider is in error state
- `PROVIDER_CONFIGURATION_CHANGED` - flag config has changed in the source
- `PROVIDER_STALE` - cached state may be out of date

### Error Types

The SDK provides specific error classes: `FlagNotFoundError`, `ParseError`,
`TypeMismatchError`, `GeneralError`, `TargetingKeyMissingError`,
`InvalidContextError`, `ProviderNotReadyError`, `ProviderFatalError`.

### Provider Lifecycle

Providers implement `metadata: { name: string }` and `runsOn: 'server'`. They
can optionally implement `initialize()` and `onClose()` lifecycle methods.

---

## 2. Reference: Env-Var Provider (simplest provider)

The env-var provider is the simplest possible reference implementation. Key
takeaways:

- Reads flag values from `process.env`
- No events, no caching, no lifecycle hooks
- Each `resolve*Evaluation` method delegates to a shared
  `evaluateEnvironmentVariable` method that:
  1. Transforms the flag key (e.g., `is-banner-enabled` -> `IS_BANNER_ENABLED`)
  2. Looks up the env var
  3. Throws `FlagNotFoundError` if missing
  4. Parses the string value into the appropriate type
  5. Throws `ParseError` if parsing fails
  6. Returns `{ value, reason: 'STATIC' }`
- The `defaultValue` and `context` parameters are **not used** in this simple
  provider

---

## 3. Reference: In-Memory Provider (event-emitting provider)

The SDK's built-in in-memory provider shows how to support dynamic
configuration:

- Stores flags as a `FlagConfiguration` object (variants + contextEvaluator
  functions)
- Emits `ConfigurationChanged` events when `putConfiguration()` is called
- Supports variant-based resolution and context-based targeting
- Returns `reason: 'TARGETING_MATCH'` when context evaluation is used, otherwise
  `'STATIC'`
- Returns `reason: 'DISABLED'` with the default value for disabled flags

---

## 4. GO Feature Flag - PostgreSQL Store

GO Feature Flag stores flag configuration as JSON in PostgreSQL.

### Schema

```sql
CREATE TABLE IF NOT EXISTS go_feature_flag (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flag_name VARCHAR(255) NOT NULL,
    flagset VARCHAR(255) NOT NULL,
    config JSONB NOT NULL
);
```

Key design choices:

- Flag configuration is stored as a single **JSONB blob** per flag
- Supports flagsets for grouping/filtering flags
- Indexes on `flag_name`, `flagset`, and a composite unique constraint
- The retriever simply reads the config column and deserializes the JSON

This is a **simple key-value** approach: one row per flag, the full evaluation
config is in JSONB.

---

## 5. Neon Guide - Full Feature Flag System in PostgreSQL

This guide describes a comprehensive feature flag system with segments and
rules.

### Schema (4 tables)

```sql
-- Core flag definitions
CREATE TABLE feature_flags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP, updated_at TIMESTAMP
);

-- User groups for targeting
CREATE TABLE segments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT
);

-- Associates flags with segments + percentage rollout
CREATE TABLE rules (
    id SERIAL PRIMARY KEY,
    flag_id INTEGER REFERENCES feature_flags(id),
    segment_id INTEGER REFERENCES segments(id),
    percentage INTEGER NOT NULL DEFAULT 100,
    CONSTRAINT percentage_range CHECK (percentage >= 0 AND percentage <= 100),
    UNIQUE(flag_id, segment_id)
);

-- Defines conditions for segment membership
CREATE TABLE segment_conditions (
    id SERIAL PRIMARY KEY,
    segment_id INTEGER REFERENCES segments(id),
    attribute VARCHAR(100) NOT NULL,
    operator VARCHAR(20) NOT NULL,  -- equals, contains, startsWith, endsWith
    value TEXT NOT NULL
);
```

### Evaluation Logic

1. Check if flag exists and is globally enabled
2. Fetch rules for the flag (with segment joins)
3. If no rules exist, flag is enabled for all users
4. For each rule: check if user matches segment conditions
5. If user matches segment, apply percentage rollout using FNV-1a hash of
   `userID + flagName`
6. Return true on first matching rule

### Key Patterns

- **Consistent hashing** for percentage rollouts:
  `fnv32a(userID + flagName) % 100`
- **All-AND segment conditions**: user must match ALL conditions in a segment
- **No caching**: every evaluation hits the database directly
- **Boolean-only**: the system only supports enabled/disabled, no typed values

---

## 6. Railway Blog - Feature Flags from Scratch

Uses **Redis** (not Postgres) for flag storage, with three flag patterns:

1. **Random cohort (A/B test)**: Redis Sets storing user IDs for a % sample
2. **Global toggle**: Redis String for banner/announcement content
3. **Geo-targeting**: IP-to-country lookup in Postgres, cached in Redis

Key insights:

- Evaluates flags at three layers: UI rendering, page access, server actions
- Redis chosen for speed with non-structured data
- Same-network deployment reduces latency vs third-party providers

Not directly applicable to a Postgres-only approach, but validates the pattern
of **local evaluation with a backing store**.

---

## 7. Brandur - Instant Feature Flags (Postgres LISTEN/NOTIFY)

This is the most relevant architecture for a Postgres-backed provider. The
system uses **local in-memory caching with instant invalidation via Postgres
LISTEN/NOTIFY**.

### Architecture

1. On startup, load all flags from Postgres into an in-process cache
2. Use Postgres `LISTEN/NOTIFY` to get instant notifications when flags change
3. On notification, re-sync the cache from the database
4. Flag checks hit the local cache (zero DB queries per evaluation)

### Flag Modes

- Fully enabled/disabled
- Randomly enabled (percentage of checks or users)
- Enabled by token (account ID, team ID, cluster ID)

### Schema Design

Separate tables per token type for data integrity:

- `flag` - core flag state (on/off, randomization percentage)
- `flag_account`, `flag_cluster`, `flag_team` - token-specific overrides

### Postgres Triggers

```sql
CREATE OR REPLACE FUNCTION flag_notify_pflagwake() RETURNS TRIGGER AS $$
    BEGIN
        NOTIFY pflagwake;
        RETURN NULL;
    END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_pflagwake_insert AFTER INSERT ON flag
    FOR EACH ROW EXECUTE FUNCTION flag_notify_pflagwake();
CREATE TRIGGER notify_pflagwake_update AFTER UPDATE ON flag
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION flag_notify_pflagwake();
CREATE TRIGGER notify_pflagwake_delete AFTER DELETE ON flag
    FOR EACH ROW EXECUTE FUNCTION flag_notify_pflagwake();
```

### Listener Pattern

```go
sync("initial")
sub := b.notifier.Listen("pflagwake")
ticker := time.NewTicker(5 * time.Minute)
for {
    select {
    case <-ctx.Done(): return
    case _, ok := <-sub.C():
        if ok { sync("notification wake") }
    case <-ticker.C:
        sync("periodic")
    }
}
```

### Key Design Decisions

- **Row-level triggers** (not statement-level) to avoid false notifications
- **`WHEN (OLD.* IS DISTINCT FROM NEW.*)`** on UPDATE triggers to skip no-op
  updates
- **Transaction deduplication**: Postgres deduplicates NOTIFY within a
  transaction, so bulk updates trigger only one re-sync
- **Periodic fallback sync** (5 min) in case notifications are missed
- **Millisecond activation**: changes propagate before you can switch browser
  tabs

---

## 8. Brandur - Typed Feature Flags

Describes a system for **compile-time type safety** of flag references.

### Approach

1. Flags defined in YAML as the single source of truth
2. Go backend generates OpenAPI schema with flag names as an enum
3. TypeScript frontend gets generated types from OpenAPI
4. Compile-time errors for invalid flag references

### Key Types

```typescript
// Generated enum from OpenAPI
export const FlagName = {
  AnalyticsEnable: "analytics_enable",
  MetricViewsAllowUnlimitedRaw: "metric_views_allow_unlimited_raw",
} as const;
export type FlagName = typeof FlagName[keyof typeof FlagName];
```

### Takeaway

Type safety is achieved through code generation from a flag registry, not
through the database schema. This is a **complementary concern** - the DB stores
runtime state, the type system ensures correct references.

---

## 9. TypeScript Postgres Client LISTEN/NOTIFY Support

Two main Node.js Postgres clients support LISTEN/NOTIFY:

### `pg` (node-postgres)

The most established Node.js Postgres client. LISTEN/NOTIFY uses a **dedicated
`Client` connection** (not a pool):

```typescript
import pg from "pg";

const client = new pg.Client();
await client.connect();

await client.query("LISTEN flag_change");

client.on("notification", (msg) => {
  console.log(msg.channel); // 'flag_change'
  console.log(msg.payload); // optional payload string
  console.log(msg.processId); // originating PG backend PID
});
```

**Caveat**: LISTEN requires a dedicated, long-lived `Client` connection — it
does **not** work with `Pool` (pooled connections may be released/reused). The
provider will need both a `Pool` for queries and a separate `Client` for the
listener.

### `postgres` (postgres.js)

A newer, TypeScript-first client. LISTEN/NOTIFY is built in with automatic
reconnection:

```typescript
import postgres from "postgres";

const sql = postgres(connectionString);

await sql.listen("flag_change", (payload) => {
  // Automatically handles dedicated connection
  // Reconnects with backoff on disconnect
  resyncCache();
});
```

**Advantages**: `sql.listen()` automatically manages a dedicated connection,
handles reconnection with backoff, and provides an `onlisten` callback for
re-initialization after reconnects:

```typescript
await sql.listen(
  "flag_change",
  () => resyncCache(),
  () => resyncCache(), // also re-sync on reconnect
);
```

### Recommendation

**`pg` (node-postgres)** — the application already uses `pg`, so we should stay
consistent. The provider will need to manage two connections:

1. A `Pool` for flag queries (loading/syncing the cache)
2. A dedicated `Client` for the LISTEN connection (long-lived, handles
   notifications)

The provider should handle reconnection of the listener `Client` manually (e.g.,
on `error`/`end` events, reconnect with backoff and re-issue `LISTEN`).

---

## Design Considerations for Our Provider

### Minimal Approach (v1)

Based on the research, the simplest viable Postgres-backed OpenFeature provider
would:

1. **Schema**: Single table with `flag_key`, `flag_type`, and `flag_value`
   (text, parsed per type)
2. **Evaluation**: Query Postgres for the flag key, parse the value to the
   requested type
3. **Errors**: `FlagNotFoundError` for missing keys,
   `ParseError`/`TypeMismatchError` for type issues
4. **Reason**: Return `STATIC` for simple lookups

### Enhanced Approach (v2)

Add caching and change notification:

1. **In-memory cache**: Load all flags on `initialize()`, serve from cache
2. **LISTEN/NOTIFY**: Use Postgres triggers + LISTEN to invalidate cache
   instantly
3. **Events**: Emit `ConfigurationChanged` when cache refreshes
4. **Periodic fallback**: Re-sync every N minutes as a safety net
5. **Reason**: Return `CACHED` for cache hits, `STATIC` for direct DB reads

### Full Approach (v3)

Add targeting and variants:

1. **Schema**: Flags table + variants table + rules/conditions tables
2. **Context evaluation**: Use `EvaluationContext` (targetingKey, attributes)
   for rule matching
3. **Percentage rollouts**: Consistent hashing on `targetingKey + flagKey`
4. **Reason**: Return `TARGETING_MATCH` when rules apply, `SPLIT` for percentage
   rollouts

### Recommended Starting Point

Start with **v1 plus the LISTEN/NOTIFY cache from v2**. This gives:

- Zero-latency evaluations (in-memory cache)
- Instant flag updates (Postgres notifications)
- Simple schema (easy to set up and reason about)
- Full OpenFeature compliance
- A solid foundation for adding targeting rules later

### Schema Proposal

```sql
CREATE TABLE IF NOT EXISTS feature_flags (
    flag_key VARCHAR(255) PRIMARY KEY,
    flag_type VARCHAR(20) NOT NULL CHECK (flag_type IN ('boolean', 'string', 'number', 'object')),
    flag_value TEXT NOT NULL,
    variant VARCHAR(255),
    disabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger for LISTEN/NOTIFY
CREATE OR REPLACE FUNCTION notify_flag_change() RETURNS TRIGGER AS $$
BEGIN
    NOTIFY flag_change;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flag_change_insert AFTER INSERT ON feature_flags
    FOR EACH ROW EXECUTE FUNCTION notify_flag_change();
CREATE TRIGGER flag_change_update AFTER UPDATE ON feature_flags
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION notify_flag_change();
CREATE TRIGGER flag_change_delete AFTER DELETE ON feature_flags
    FOR EACH ROW EXECUTE FUNCTION notify_flag_change();
```

### Provider Skeleton

```typescript
class PostgresProvider implements Provider {
  metadata = { name: "postgres" };
  runsOn = "server" as const;
  events = new OpenFeatureEventEmitter();

  private cache: Map<string, FlagRow>;
  private pool: Pool;

  async initialize(): Promise<void> {
    // 1. Load all flags into cache
    // 2. Start LISTEN on 'flag_change' channel
    // 3. On notification: re-sync cache, emit ConfigurationChanged
    // 4. Start periodic fallback sync
  }

  async onClose(): Promise<void> {
    // Clean up listener and pool
  }

  async resolveBooleanEvaluation(flagKey, defaultValue, context, logger) {
    return this.resolve(flagKey, "boolean", (v) => {
      if (v === "true") return true;
      if (v === "false") return false;
      throw new ParseError(`Cannot parse '${v}' as boolean`);
    });
  }

  // ... resolveString, resolveNumber, resolveObject similarly

  private resolve<T>(
    flagKey: string,
    expectedType: string,
    parse: (v: string) => T,
  ): ResolutionDetails<T> {
    const flag = this.cache.get(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);
    if (flag.disabled) return { value: defaultValue, reason: "DISABLED" };
    if (flag.flag_type !== expectedType) throw new TypeMismatchError();
    return {
      value: parse(flag.flag_value),
      reason: "CACHED",
      variant: flag.variant,
    };
  }
}
```
