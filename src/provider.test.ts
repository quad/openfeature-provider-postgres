import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@1";
import {
  DefaultLogger,
  FlagNotFoundError,
  ProviderEvents,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { describe, it } from "@std/testing/bdd";
import type pg from "pg";
import { insertFlag, withDb } from "./pglite-helper.test.ts";
import { PostgresProvider } from "./provider.ts";

const logger = new DefaultLogger();

async function withProvider(
  fn: (pool: pg.Pool, provider: PostgresProvider) => Promise<void>,
) {
  await withDb(async (pool) => {
    await using stack = new AsyncDisposableStack();
    const provider = stack.adopt(
      new PostgresProvider({ pool }),
      (p) => p.onClose(),
    );
    await fn(pool, provider);
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
  it("resolves boolean flags", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "bool-flag", "boolean", [{
        name: "on",
        value: "true",
      }]);
      await provider.initialize();
      const result = await provider.resolveBooleanEvaluation(
        "bool-flag",
        false,
        {},
        logger,
      );
      assertStrictEquals(result.value, true);
      assertStrictEquals(result.variant, "on");
    }));

  it("resolves string flags", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "greeting", "string", [{
        name: "hello",
        value: '"Hello, world!"',
      }]);
      await provider.initialize();
      const result = await provider.resolveStringEvaluation(
        "greeting",
        "",
        {},
        logger,
      );
      assertStrictEquals(result.value, "Hello, world!");
      assertStrictEquals(result.variant, "hello");
    }));

  it("resolves number flags", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "rate-limit", "number", [{
        name: "default",
        value: "100",
      }]);
      await provider.initialize();
      const result = await provider.resolveNumberEvaluation(
        "rate-limit",
        0,
        {},
        logger,
      );
      assertStrictEquals(result.value, 100);
      assertStrictEquals(result.variant, "default");
    }));

  it("resolves object flags", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "config", "object", [{
        name: "v1",
        value: '{"theme": "dark", "limit": 10}',
      }]);
      await provider.initialize();
      const result = await provider.resolveObjectEvaluation(
        "config",
        {},
        {},
        logger,
      );
      assertEquals(result.value, { theme: "dark", limit: 10 });
      assertStrictEquals(result.variant, "v1");
    }));

  it("disabled flag returns default", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "disabled-flag", "boolean", [
        { name: "on", value: "true" },
      ], { enabled: false });

      await provider.initialize();

      const result = await provider.resolveBooleanEvaluation(
        "disabled-flag",
        false,
        {},
        logger,
      );
      assertStrictEquals(result.value, false); // default value, not stored value
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

  for (const enabled of [true, false]) {
    it(`wrong type throws TypeMismatchError (enabled=${enabled})`, () =>
      withProvider(async (pool, provider) => {
        await insertFlag(pool, "bool-flag", "boolean", [
          { name: "on", value: "true" },
        ], { enabled });

        await provider.initialize();

        await assertRejects(
          () => provider.resolveStringEvaluation("bool-flag", "", {}, logger),
          TypeMismatchError,
        );
      }));
  }
});

describe("rollouts", () => {
  it("returns SPLIT reason with targeting key", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "ab-test", "string", [
        { name: "control", value: '"Control"' },
        { name: "treatment", value: '"Treatment"', percentage: 50 },
      ]);

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "ab-test",
        "",
        { targetingKey: "user-123" },
        logger,
      );
      assertStrictEquals(result.reason, StandardResolutionReasons.SPLIT);
      assert(["control", "treatment"].includes(result.variant ?? ""));
    }));

  it("is deterministic for the same targeting key", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "ab-test", "string", [
        { name: "control", value: '"Control"' },
        { name: "treatment", value: '"Treatment"', percentage: 50 },
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
        results.add(r.variant ?? "");
      }
      assertStrictEquals(results.size, 1, "should be deterministic");
    }));

  it("falls back to default variant without targeting key", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "ab-test", "string", [
        { name: "control", value: '"Control"' },
        { name: "treatment", value: '"Treatment"', percentage: 50 },
      ]);

      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        "ab-test",
        "",
        {},
        logger,
      );
      assertStrictEquals(result.variant, "control");
      assertStrictEquals(result.reason, StandardResolutionReasons.STATIC);
    }));

  it("normalizes percentages exceeding 100", () => {
    // 70 + 70 = 140 total. Math.max(140, 100) = 140 as bucket divisor.
    // Buckets 0–69 → 'a' (50%), buckets 70–139 → 'b' (50%).
    // This is the intended behaviour: treat percentages as weights when they
    // overflow, so 70/70 means the same as 50/50.
    return withProvider(async (pool, provider) => {
      await insertFlag(pool, "split-test", "string", [
        { name: "fallback", value: '"Fallback"' },
        { name: "a", value: '"A"', percentage: 70 },
        { name: "b", value: '"B"', percentage: 70 },
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

      // Both variants should appear and neither should dominate
      // (within a generous ±30% tolerance around 50%).
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

  it("100% rollout never falls through to default", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "full-rollout", "string", [
        { name: "default", value: '"Default"' },
        { name: "treatment", value: '"Treatment"', percentage: 100 },
      ]);

      await provider.initialize();

      // With 100% rollout, every targeting key should get 'treatment'
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

describe("schema constraints", () => {
  const constraintCases = [
    {
      name: "rejects wrong-typed JSONB values",
      setupSql: [
        `INSERT INTO openfeature.feature_flags (flag_key, flag_type) VALUES ('bool-flag', 'boolean')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('bool-flag', 'on', 'boolean', '"not-a-boolean"')`,
    },
    {
      name: "rejects JSONB arrays for object-type variants",
      setupSql: [
        `INSERT INTO openfeature.feature_flags (flag_key, flag_type) VALUES ('tags', 'object')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('tags', 'default', 'object', '["a", "b", "c"]')`,
    },
    {
      name: "rejects a second default variant for the same flag",
      setupSql: [
        `INSERT INTO openfeature.feature_flags (flag_key, flag_type) VALUES ('my-flag', 'boolean')`,
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', 'on', 'boolean', 'true')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', 'off', 'boolean', 'false')`,
    },
    {
      name: "rejects empty flag_key",
      setupSql: [],
      badSql:
        `INSERT INTO openfeature.feature_flags (flag_key, flag_type) VALUES ('', 'boolean')`,
    },
    {
      name: "rejects empty variant",
      setupSql: [
        `INSERT INTO openfeature.feature_flags (flag_key, flag_type) VALUES ('my-flag', 'boolean')`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ('my-flag', '', 'boolean', 'true')`,
    },
  ];

  for (const tc of constraintCases) {
    it(tc.name, () =>
      withDb(async (pool) => {
        for (const sql of tc.setupSql) await pool.query(sql);
        await assertRejects(() => pool.query(tc.badSql), Error);
      }));
  }
});

describe("lifecycle", () => {
  it("initialize fails if schema is missing", () =>
    // Deliberately skip schema — syncCache will fail
    withDb(async (pool) => {
      const provider = new PostgresProvider({ pool });
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
        new PostgresProvider({ pool }),
        (p) => p.onClose(),
      );
      await provider.initialize();

      const stale = new Promise<void>((resolve) => {
        provider.events.addHandler(ProviderEvents.Stale, () => resolve());
      });

      // Simulate connection loss
      getListenerClient().emit("error", new Error("simulated disconnect"));

      // Should emit Stale
      await stale;

      // Wait for backoff to reconnect and sync
      await new Promise((r) => setTimeout(r, 500));

      // Provider should still work after reconnection
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

      const provider = new PostgresProvider({ pool });
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
      } as unknown as typeof pool; // partial mock — only implements connect/query

      await using stack = new AsyncDisposableStack();
      const provider = stack.adopt(
        new PostgresProvider({ pool: wrappedPool }),
        (p) => p.onClose(),
      );
      await provider.initialize();
      failQueries = true;

      const stale = new Promise<void>((resolve) => {
        provider.events.addHandler(ProviderEvents.Stale, () => resolve());
      });

      // Trigger onNotification path via a direct NOTIFY
      await pool.query("NOTIFY openfeature_flag_change");
      await stale;
    }));

  it("skips ConfigurationChanged when unchanged", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "stable-flag", "boolean", [
        { name: "on", value: "true" },
      ]);

      await using stack = new AsyncDisposableStack();
      const provider = stack.adopt(
        new PostgresProvider({ pool }),
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
      await new Promise((resolve) => setTimeout(resolve, 200));

      assertStrictEquals(
        changeCount,
        0,
        "should not fire when cache is unchanged",
      );
    }));
});
