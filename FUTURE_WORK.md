**Must fix (spec violations / bugs):**

1. **`syncCache` errors swallowed during `initialize()`** — if the DB query
   fails on startup, the error is caught and logged, but `initialize()` returns
   normally. The SDK never learns the provider failed, so it marks it READY with
   an empty cache. Every flag evaluation then throws `FlagNotFoundError`. The
   error must propagate from `initialize()` so the SDK can set ERROR state.

2. **Unhandled rejections in callbacks** — the `setInterval`, `onNotification`,
   and `onReconnect` callbacks all do `syncCache().then(...)` with no
   `.catch()`. Since `syncCache` never rejects (it swallows), this is currently
   harmless — but once you fix #1, these will start producing unhandled
   rejections. They need `.catch()` branches that emit `ProviderEvents.Stale`.

3. **`initialize()` not guarded against double-call** — calling it twice leaks
   both the old `NotifyListener` (overwritten without stopping) and the old
   `setInterval` (overwritten without clearing).

**Should fix:**

4. **`setInterval` not unref'd** — keeps the Deno process alive if `onClose()`
   is never called. Use `setInterval` from `"node:timers"` and call `.unref()`,
   or document clearly that `onClose()` / `await using` is required.

5. **`FlagData` and `RolloutEntry` should not be exported** — they expose the
   internal cache shape as public API, committing you to the
   `Map<string, unknown>` representation forever. Consumers have no use for
   them.

6. **Periodic sync emits `ConfigurationChanged` unconditionally** — fires on
   every interval tick even when nothing changed. Compare the new snapshot to
   the current cache and only emit when they differ.

7. **`initialize()` should accept `context?: EvaluationContext`** — the
   OpenFeature spec defines this optional parameter; any context passed at
   registration time is currently silently discarded.

8. **Background sync failure should emit `Stale`** — currently a DB hiccup
   during a periodic sync is silently ignored. It should emit
   `ProviderEvents.Stale`.

**Worth addressing:**

9. **Use `StandardResolutionReasons.SPLIT`** instead of the string literal
   `"SPLIT"`.

10. **`createClient` fallback casts `pool.options` unsafely**
    (`as unknown as Record<string, unknown>`) — breaks with connection string
    URLs and is fragile across `pg` versions. Consider requiring `createClient`
    when not using the default client factory.

11. **`migration.sql` UPDATE triggers lack
    `WHEN (OLD.* IS DISTINCT FROM NEW.*)`** — causes spurious notifications on
    no-op updates (e.g. touching a row without changing it). The research notes
    called this out as a best practice.

12. **No FK from `default_variant` → `flag_variants`** — the DB won't catch a
    `default_variant` pointing to a nonexistent variant; only a runtime
    `console.warn` does. A deferrable FK would enforce this.

13. **SHA-256 for rollout hashing is async and heavyweight** — a synchronous
    non-cryptographic hash (FNV-1a, etc.) is the standard for percentage
    bucketing and avoids the extra `await` on every targeting evaluation.
