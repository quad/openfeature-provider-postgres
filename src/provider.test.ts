import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  DefaultLogger,
  FlagNotFoundError,
  ProviderEvents,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { describe, it } from "@std/testing/bdd";
import { deadline } from "@std/async/deadline";
import type pg from "pg";
import {
  clearTargeting,
  insertFlag,
  setTargeting,
  withDb,
} from "./pglite-helper.test.ts";
import { PostgresProvider } from "./provider.ts";

const logger = new DefaultLogger();

async function withProvider(
  fn: (pool: pg.Pool, provider: PostgresProvider) => Promise<void>,
) {
  await withDb(async (pool) => {
    const provider = new PostgresProvider({ pool, jitter: false });
    try {
      await fn(pool, provider);
    } finally {
      await provider.onClose();
    }
  });
}

/** Wraps pool.connect to capture the listener's internal client for testing. */
function interceptListenerClient(pool: pg.Pool) {
  let client: { emit: (event: string, ...args: unknown[]) => void } | null =
    null;
  const origConnect = pool.connect.bind(pool);
  // deno-lint-ignore no-explicit-any -- monkey-patching a method requires `as any`
  (pool as any).connect = async () => {
    const c = await origConnect();
    client = c;
    return c;
  };
  return () => {
    if (!client) throw new Error("pool.connect() was not called");
    return client;
  };
}

describe("flag resolution", () => {
  // One row per OpenFeature value type. `value` is the JSONB literal
  // inserted into flag_variants; `expected` is the value the resolver
  // must return after JSONB decode.
  const typeCases = [
    {
      type: "boolean" as const,
      value: "true",
      expected: true,
      default: false,
      resolve: (p: PostgresProvider, k: string) =>
        p.resolveBooleanEvaluation(k, false, {}, logger),
    },
    {
      type: "string" as const,
      value: '"Hello, world!"',
      expected: "Hello, world!",
      default: "",
      resolve: (p: PostgresProvider, k: string) =>
        p.resolveStringEvaluation(k, "", {}, logger),
    },
    {
      type: "number" as const,
      value: "100",
      expected: 100,
      default: 0,
      resolve: (p: PostgresProvider, k: string) =>
        p.resolveNumberEvaluation(k, 0, {}, logger),
    },
    {
      type: "object" as const,
      value: '{"theme": "dark", "limit": 10}',
      expected: { theme: "dark", limit: 10 },
      default: {},
      resolve: (p: PostgresProvider, k: string) =>
        p.resolveObjectEvaluation(k, {}, {}, logger),
    },
  ];

  for (const tc of typeCases) {
    it(`resolves ${tc.type} flags`, () =>
      withProvider(async (pool, provider) => {
        await insertFlag(pool, `${tc.type}-flag`, tc.type, [{
          name: "v",
          value: tc.value,
        }]);
        await provider.initialize();
        const result = await tc.resolve(provider, `${tc.type}-flag`);
        assertEquals(result.value, tc.expected);
        assertStrictEquals(result.variant, "v");
      }));
  }

  it("all-zero-weight flag returns default value", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "disabled-flag", "boolean", [
        { name: "on", value: "true", weight: 0 },
      ]);

      await provider.initialize();

      const result = await provider.resolveBooleanEvaluation(
        "disabled-flag",
        false,
        {},
        logger,
      );
      assertStrictEquals(result.value, false);
      assertStrictEquals(result.reason, StandardResolutionReasons.DISABLED);
    }));

  it("enabled=false returns default value preserving variant weights", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "kill-switched", "boolean", [
        { name: "on", value: "true" },
      ], { enabled: false });

      await provider.initialize();

      const result = await provider.resolveBooleanEvaluation(
        "kill-switched",
        false,
        { targetingKey: "user-1" },
        logger,
      );
      assertStrictEquals(result.value, false);
      assertStrictEquals(result.reason, StandardResolutionReasons.DISABLED);
      assertStrictEquals(result.variant, undefined);
    }));

  it("disabled flag returns default even with wrong type", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "typed-disabled", "boolean", [
        { name: "on", value: "true" },
      ], { enabled: false });

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "typed-disabled",
        "fallback",
        {},
        logger,
      );
      assertStrictEquals(result.value, "fallback");
      assertStrictEquals(result.reason, StandardResolutionReasons.DISABLED);
    }));

  it("resolves multiple flags", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "flag-a", "boolean", [
        { name: "on", value: "true" },
      ]);
      await insertFlag(pool, "flag-b", "string", [
        { name: "hello", value: '"world"' },
      ]);

      await provider.initialize();

      const a = await provider.resolveBooleanEvaluation(
        "flag-a",
        false,
        {},
        logger,
      );
      assertStrictEquals(a.value, true);

      const b = await provider.resolveStringEvaluation(
        "flag-b",
        "",
        {},
        logger,
      );
      assertStrictEquals(b.value, "world");
    }));
});

describe("error handling", () => {
  it("missing flag throws FlagNotFoundError", () =>
    withProvider(async (_pool, provider) => {
      await provider.initialize();

      await assertRejects(
        () =>
          provider.resolveBooleanEvaluation("nonexistent", false, {}, logger),
        FlagNotFoundError,
      );
    }));

  it("wrong type throws TypeMismatchError", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "bool-flag", "boolean", [
        { name: "on", value: "true" },
      ]);

      await provider.initialize();

      await assertRejects(
        () => provider.resolveStringEvaluation("bool-flag", "", {}, logger),
        TypeMismatchError,
      );
    }));
});

describe("rollouts", () => {
  // Backwards-compat lock-in for the no-overrides path: each test here
  // creates a flag without setTargeting(), so the weighted-hash path must
  // still produce a SPLIT result identical to pre-overrides behavior.
  it("SPLIT reason and deterministic for the same targeting key", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "ab-test", "string", [
        { name: "control", value: '"Control"', weight: 50 },
        { name: "treatment", value: '"Treatment"', weight: 50 },
      ]);

      await provider.initialize();

      const results = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const r = await provider.resolveStringEvaluation(
          "ab-test",
          "",
          { targetingKey: "user-123" },
          logger,
        );
        assertStrictEquals(r.reason, StandardResolutionReasons.SPLIT);
        assert(["control", "treatment"].includes(r.variant ?? ""));
        results.add(r.variant ?? "");
      }
      assertStrictEquals(results.size, 1, "should be deterministic");
    }));

  it("returns STATIC without targeting key", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "ab-test", "string", [
        { name: "control", value: '"Control"', weight: 50 },
        { name: "treatment", value: '"Treatment"', weight: 50 },
      ]);

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "ab-test",
        "",
        {},
        logger,
      );
      assertStrictEquals(result.reason, StandardResolutionReasons.STATIC);

      // Deterministic: same flag key always resolves to the same variant
      const again = await provider.resolveStringEvaluation(
        "ab-test",
        "",
        {},
        logger,
      );
      assertStrictEquals(result.variant, again.variant);
    }));

  it("normalizes weights proportionally", () => {
    // 70 + 70 = 140 total → proportional split: 70/140 = 50% each.
    return withProvider(async (pool, provider) => {
      await insertFlag(pool, "split-test", "string", [
        { name: "a", value: '"A"', weight: 70 },
        { name: "b", value: '"B"', weight: 70 },
      ]);

      await provider.initialize();

      const counts: Record<string, number> = { a: 0, b: 0 };
      for (let i = 0; i < 200; i++) {
        const r = await provider.resolveStringEvaluation(
          "split-test",
          "",
          { targetingKey: `user-${i}` },
          logger,
        );
        counts[r.variant ?? ""]++;
      }

      assert(
        counts.a >= 70 && counts.a <= 130,
        `Expected a ≈ 100/200, got ${counts.a}`,
      );
      assert(
        counts.b >= 70 && counts.b <= 130,
        `Expected b ≈ 100/200, got ${counts.b}`,
      );
    });
  });

  it("single variant at weight 100 always resolves", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "full-rollout", "string", [
        { name: "treatment", value: '"Treatment"' },
      ]);

      await provider.initialize();

      for (let i = 0; i < 50; i++) {
        const result = await provider.resolveStringEvaluation(
          "full-rollout",
          "",
          { targetingKey: `user-${i}` },
          logger,
        );
        assertStrictEquals(result.variant, "treatment");
      }
    }));
});

describe("targeting", () => {
  it("single-variant pin returns TARGETING_MATCH", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "rollout", "string", [
        { name: "a", value: '"A"', weight: 1 },
        { name: "b", value: '"B"', weight: 0 },
      ]);
      await setTargeting(pool, "rollout", "string", "key-1", "b", 1);

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(result.value, "B");
      assertStrictEquals(result.variant, "b");
      assertStrictEquals(
        result.reason,
        StandardResolutionReasons.TARGETING_MATCH,
      );
    }));

  it("override pin beats flag-wide weights; other keys fall through", () =>
    withProvider(async (pool, provider) => {
      // All flag-wide weight on 'a' — without the override 'a' always wins.
      await insertFlag(pool, "rollout", "string", [
        { name: "a", value: '"A"', weight: 100 },
        { name: "b", value: '"B"', weight: 0 },
      ]);
      await setTargeting(pool, "rollout", "string", "key-1", "b", 1);

      await provider.initialize();

      const matched = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(matched.variant, "b");
      assertStrictEquals(
        matched.reason,
        StandardResolutionReasons.TARGETING_MATCH,
      );

      const unmatched = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-other" },
        logger,
      );
      assertStrictEquals(unmatched.variant, "a");
      assertStrictEquals(unmatched.reason, StandardResolutionReasons.SPLIT);
    }));

  it("weighted cohort: multi-variant override splits among its rows", () =>
    withProvider(async (pool, provider) => {
      // Flag-wide is 100% 'a'. Per-key cohort splits 50/50 between b and c.
      await insertFlag(pool, "rollout", "string", [
        { name: "a", value: '"A"', weight: 1 },
        { name: "b", value: '"B"', weight: 0 },
        { name: "c", value: '"C"', weight: 0 },
      ]);
      await setTargeting(pool, "rollout", "string", "key-1", "b", 50);
      await setTargeting(pool, "rollout", "string", "key-1", "c", 50);

      await provider.initialize();

      // Resolution for key-1 is one of {b, c} but never 'a'; same key →
      // deterministic single result.
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const r = await provider.resolveStringEvaluation(
          "rollout",
          "",
          { targetingKey: "key-1" },
          logger,
        );
        assertStrictEquals(r.reason, StandardResolutionReasons.TARGETING_MATCH);
        assert(
          ["b", "c"].includes(r.variant ?? ""),
          `expected b or c, got ${r.variant}`,
        );
        seen.add(r.variant ?? "");
      }
      assertStrictEquals(seen.size, 1, "deterministic for same targetingKey");
    }));

  it("disabled flag returns default even when an override would match", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "rollout", "string", [
        { name: "a", value: '"A"' },
        { name: "b", value: '"B"' },
      ], { enabled: false });
      await setTargeting(pool, "rollout", "string", "key-1", "b", 1);

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "rollout",
        "fallback",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(result.value, "fallback");
      assertStrictEquals(result.reason, StandardResolutionReasons.DISABLED);
      assertStrictEquals(result.variant, undefined);
    }));

  it("all-zero-weight cohort falls through to flag-wide hash", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "rollout", "string", [
        { name: "a", value: '"A"', weight: 1 },
        { name: "b", value: '"B"', weight: 0 },
      ]);
      // Override row exists but with weight 0 — same DISABLED semantics
      // as a zero-weight variants list at the flag level: no choice, fall
      // through to the flag-wide weighted hash.
      await setTargeting(pool, "rollout", "string", "key-1", "b", 0);

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(result.variant, "a");
      assertStrictEquals(result.reason, StandardResolutionReasons.SPLIT);
    }));

  it("override propagates via NOTIFY without re-init", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "rollout", "string", [
        { name: "a", value: '"A"', weight: 1 },
        { name: "b", value: '"B"', weight: 0 },
      ]);

      await using stack = new AsyncDisposableStack();
      const provider = stack.adopt(
        new PostgresProvider({ pool, jitter: false }),
        (p) => p.onClose(),
      );
      await provider.initialize();

      // Baseline: no override → weighted hash picks 'a'.
      const before = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(before.variant, "a");

      // Add an override; wait for cache to sync.
      const added = new Promise<void>((resolve) => {
        provider.events.addHandler(
          ProviderEvents.ConfigurationChanged,
          () => resolve(),
        );
      });
      await setTargeting(pool, "rollout", "string", "key-1", "b", 1);
      await deadline(added, 1_000);

      const matched = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(matched.variant, "b");
      assertStrictEquals(
        matched.reason,
        StandardResolutionReasons.TARGETING_MATCH,
      );

      // Clear override; weighted hash resumes.
      const removed = new Promise<void>((resolve) => {
        provider.events.addHandler(
          ProviderEvents.ConfigurationChanged,
          () => resolve(),
        );
      });
      await clearTargeting(pool, "rollout", "key-1");
      await deadline(removed, 1_000);

      const after = await provider.resolveStringEvaluation(
        "rollout",
        "",
        { targetingKey: "key-1" },
        logger,
      );
      assertStrictEquals(after.variant, "a");
      assertStrictEquals(after.reason, StandardResolutionReasons.SPLIT);
    }));
});

describe("schema constraints", () => {
  const constraintCases = [
    {
      name: "rejects wrong-typed JSONB values",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('bool-flag', 'boolean', true)`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('bool-flag', 'on', 'boolean', '"not-a-boolean"')`,
      expectedError: "check",
    },
    {
      name: "rejects JSONB arrays for object-type variants",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('tags', 'object', true)`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('tags', 'default', 'object', '["a", "b", "c"]')`,
      expectedError: "check",
    },
    {
      name: "rejects empty flag_key",
      setupSql: [],
      badSql:
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('', 'boolean', true)`,
      expectedError: "check",
    },
    {
      name: "rejects empty variant",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('my-flag', 'boolean', true)`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', '', 'boolean', 'true')`,
      expectedError: "check",
    },
    {
      name: "rejects targeting row referencing missing variant",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('my-flag', 'string', true)`,
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', 'a', 'string', '"A"')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight) VALUES ('my-flag', 'k', 'string', 'nonexistent', 1)`,
      expectedError: "foreign key",
    },
    {
      name: "rejects targeting row with mismatched flag_type",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('my-flag', 'string', true)`,
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', 'a', 'string', '"A"')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight) VALUES ('my-flag', 'k', 'boolean', 'a', 1)`,
      expectedError: "foreign key",
    },
    {
      name: "rejects targeting row with negative weight",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('my-flag', 'string', true)`,
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', 'a', 'string', '"A"')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight) VALUES ('my-flag', 'k', 'string', 'a', -1)`,
      expectedError: "check",
    },
    {
      name: "rejects empty subject",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('my-flag', 'string', true)`,
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', 'a', 'string', '"A"')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight) VALUES ('my-flag', '', 'string', 'a', 1)`,
      expectedError: "check",
    },
  ];

  for (const tc of constraintCases) {
    it(tc.name, () =>
      withDb(async (pool) => {
        for (const sql of tc.setupSql) await pool.query(sql);
        await assertRejects(
          () => pool.query(tc.badSql),
          Error,
          tc.expectedError,
        );
      }));
  }
});

describe("lifecycle", () => {
  it("initialize fails if schema is missing", () =>
    // Deliberately skip schema — syncCache will fail
    withDb(async (pool) => {
      const provider = new PostgresProvider({ pool, jitter: false });
      await assertRejects(() => provider.initialize(), Error);
      await provider.onClose();
    }, { applySchema: false }));

  it("initialize is idempotent", () =>
    withProvider(async (_pool, provider) => {
      await provider.initialize();
      await provider.initialize(); // should not throw or create a second listener
    }));

  it("onClose before initialize", () =>
    withProvider(async (_pool, provider) => {
      await provider.onClose(); // should not throw on uninitialized provider
    }));

  it("initialize after onClose", () =>
    withProvider(async (_pool, provider) => {
      await provider.initialize();
      await provider.onClose();
      await provider.initialize(); // should not re-initialize after dispose
    }));
});

describe("sync", () => {
  it("reconnects after connection loss", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "test-flag", "boolean", [
        { name: "on", value: "true" },
      ]);

      const getListenerClient = interceptListenerClient(pool);

      await using stack = new AsyncDisposableStack();
      const provider = stack.adopt(
        new PostgresProvider({ pool, jitter: false }),
        (p) => p.onClose(),
      );
      await provider.initialize();

      const stale = new Promise<void>((resolve) => {
        provider.events.addHandler(ProviderEvents.Stale, () => resolve());
      });

      // Simulate connection loss
      getListenerClient().emit("error", new Error("simulated disconnect"));
      await deadline(stale, 1_000);

      // Insert a new flag while disconnected — after reconnect, the sync will
      // see the change and emit ConfigurationChanged, which we await.
      await insertFlag(pool, "added-while-down", "boolean", [
        { name: "on", value: "true" },
      ]);
      const changed = new Promise<void>((resolve) => {
        provider.events.addHandler(
          ProviderEvents.ConfigurationChanged,
          () => resolve(),
        );
      });
      await deadline(changed, 1_000);

      // Provider should work after reconnection
      const result = await provider.resolveBooleanEvaluation(
        "test-flag",
        false,
        {},
        logger,
      );
      assertStrictEquals(result.value, true);
    }));

  it("dispose during reconnection", () =>
    withDb(async (pool) => {
      const getListenerClient = interceptListenerClient(pool);

      const provider = new PostgresProvider({ pool, jitter: false });
      await provider.initialize();

      // Simulate connection loss to enter reconnecting state
      getListenerClient().emit("error", new Error("simulated disconnect"));

      // Immediately close while reconnection is in-flight — should not throw,
      // backoff should stop retrying
      await provider.onClose();
    }));

  it("emits Stale on query failure", () =>
    withDb(async (pool) => {
      let failQueries = false;
      const wrappedPool = {
        connect: () => pool.connect(),
        query: (sql: string) => {
          if (failQueries) return Promise.reject(new Error("DB down"));
          return pool.query(sql);
        },
      } as unknown as typeof pool;

      await using stack = new AsyncDisposableStack();
      const provider = stack.adopt(
        new PostgresProvider({ pool: wrappedPool, jitter: false }),
        (p) => p.onClose(),
      );
      await provider.initialize();
      failQueries = true;

      const stale = new Promise<void>((resolve) => {
        provider.events.addHandler(ProviderEvents.Stale, () => resolve());
      });

      // Trigger onNotification path via a direct NOTIFY
      await pool.query("NOTIFY openfeature_flag_change");
      await deadline(stale, 1_000);
    }));

  it("skips ConfigurationChanged when unchanged", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "stable-flag", "boolean", [
        { name: "on", value: "true" },
      ]);

      await using stack = new AsyncDisposableStack();
      const provider = stack.adopt(
        new PostgresProvider({ pool, jitter: false }),
        (p) => p.onClose(),
      );
      await provider.initialize();

      let changeCount = 0;
      provider.events.addHandler(ProviderEvents.ConfigurationChanged, () => {
        changeCount++;
      });

      // Trigger a sync via NOTIFY without changing any data — cache is identical,
      // so ConfigurationChanged must not fire.
      await pool.query("NOTIFY openfeature_flag_change");
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      assertStrictEquals(
        changeCount,
        0,
        "should not fire when cache is unchanged",
      );
    }));
});
