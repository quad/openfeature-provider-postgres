import {
  assert,
  assertEquals,
  assertGreater,
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
import { deadline } from "@std/async/deadline";
import { delay } from "@std/async/delay";
import type pg from "pg";
import { insertFlag, withDb } from "./pglite-helper.test.ts";
import { PostgresProvider } from "./provider.ts";

const logger = new DefaultLogger();

async function withProvider(
  fn: (pool: pg.Pool, provider: PostgresProvider) => Promise<void>,
) {
  await withDb(async (pool) => {
    const provider = new PostgresProvider({ pool });
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
  it("returns SPLIT reason with targeting key", () =>
    withProvider(async (pool, provider) => {
      await insertFlag(pool, "ab-test", "string", [
        { name: "control", value: '"Control"', weight: 50 },
        { name: "treatment", value: '"Treatment"', weight: 50 },
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

describe("schema constraints", () => {
  const constraintCases = [
    {
      name: "rejects wrong-typed JSONB values",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('bool-flag', 'boolean', true)`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, weight) VALUES ('bool-flag', 'on', 'boolean', '"not-a-boolean"', 1)`,
      expectedError: "check",
    },
    {
      name: "rejects JSONB arrays for object-type variants",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('tags', 'object', true)`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, weight) VALUES ('tags', 'default', 'object', '["a", "b", "c"]', 1)`,
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
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, weight) VALUES ('my-flag', '', 'boolean', 'true', 1)`,
      expectedError: "check",
    },
    {
      name: "rejects negative weight",
      setupSql: [
        `INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ('my-flag', 'boolean', true)`,
      ],
      badSql:
        `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, weight) VALUES ('my-flag', 'on', 'boolean', 'true', -1)`,
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
      await deadline(stale, 1_000);
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
      await new Promise((resolve) => setTimeout(resolve, 150)); // 1.5× DEBOUNCE_MS

      assertStrictEquals(
        changeCount,
        0,
        "should not fire when cache is unchanged",
      );
    }));
});

describe("evaluation tracking", () => {
  it("writes last_evaluated_at on close", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "tracked", "boolean", [
        { name: "on", value: "true" },
      ]);

      const provider = new PostgresProvider({ pool });
      await provider.initialize();
      await provider.resolveBooleanEvaluation("tracked", false, {}, logger);
      await provider.onClose();

      const { rows } = await pool.query(
        `SELECT fv.flag_key, fv.variant, fe.last_evaluated_at
         FROM openfeature.flag_evaluations fe
         JOIN openfeature.flag_variants fv ON fv.id = fe.flag_variant_id`,
      );
      assertStrictEquals(rows.length, 1);
      assertStrictEquals(rows[0].flag_key, "tracked");
      assertStrictEquals(rows[0].variant, "on");
      assert(rows[0].last_evaluated_at instanceof Date);
    }));

  it("updates timestamp on repeated evaluation", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "repeat", "boolean", [
        { name: "on", value: "true" },
      ]);

      const first_provider = new PostgresProvider({ pool });
      await first_provider.initialize();
      await first_provider.resolveBooleanEvaluation(
        "repeat",
        false,
        {},
        logger,
      );
      await first_provider.onClose();

      const first = (await pool.query(
        `SELECT fe.last_evaluated_at
         FROM openfeature.flag_evaluations fe
         JOIN openfeature.flag_variants fv ON fv.id = fe.flag_variant_id
         WHERE fv.flag_key = 'repeat'`,
      )).rows[0].last_evaluated_at;

      await delay(10);

      const second_provider = new PostgresProvider({ pool });
      await second_provider.initialize();
      await second_provider.resolveBooleanEvaluation(
        "repeat",
        false,
        {},
        logger,
      );
      await second_provider.onClose();

      const second = (await pool.query(
        `SELECT fe.last_evaluated_at
         FROM openfeature.flag_evaluations fe
         JOIN openfeature.flag_variants fv ON fv.id = fe.flag_variant_id
         WHERE fv.flag_key = 'repeat'`,
      )).rows[0].last_evaluated_at;

      assertGreater(second, first);
    }));

  it("does not track disabled flag evaluations (zero-weight)", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "off-flag", "boolean", [
        { name: "on", value: "true", weight: 0 },
      ]);

      const provider = new PostgresProvider({ pool });
      await provider.initialize();
      await provider.resolveBooleanEvaluation("off-flag", false, {}, logger);
      await provider.onClose();

      const { rows } = await pool.query(
        "SELECT count(*) as n FROM openfeature.flag_evaluations",
      );
      assertStrictEquals(Number(rows[0].n), 0);
    }));

  it("does not track disabled flag evaluations (enabled=false)", () =>
    withDb(async (pool) => {
      await insertFlag(pool, "off-flag", "boolean", [
        { name: "on", value: "true" },
      ], { enabled: false });

      const provider = new PostgresProvider({ pool });
      await provider.initialize();
      await provider.resolveBooleanEvaluation("off-flag", false, {}, logger);
      await provider.onClose();

      const { rows } = await pool.query(
        "SELECT count(*) as n FROM openfeature.flag_evaluations",
      );
      assertStrictEquals(Number(rows[0].n), 0);
    }));

  it("no-ops when no flags were evaluated", () =>
    withDb(async (pool) => {
      const provider = new PostgresProvider({ pool });
      await provider.initialize();
      await provider.onClose();

      const { rows } = await pool.query(
        "SELECT count(*) as n FROM openfeature.flag_evaluations",
      );
      assertStrictEquals(Number(rows[0].n), 0);
    }));
});
