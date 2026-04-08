import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@1";
import {
  FlagNotFoundError,
  ProviderEvents,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { DefaultLogger } from "@openfeature/server-sdk";
import { createPool } from "./pglite-helper.test.ts";

const logger = new DefaultLogger();
import { PostgresProvider } from "./provider.ts";

const migration = Deno.readTextFileSync(
  new URL("../schema.sql", import.meta.url),
);

async function setup() {
  const pglite = new PGlite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  const provider = new PostgresProvider({
    pool,
  });

  return { pglite, pool, provider };
}

// ---------------------------------------------------------------------------
// Flag resolution
// ---------------------------------------------------------------------------

Deno.test("flag resolution > resolves boolean flags", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('bool-flag', 'boolean')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('bool-flag', 'on', 'boolean', 'true')
    `);

    await provider.initialize();

    const result = await provider.resolveBooleanEvaluation(
      "bool-flag",
      false,
      {},
      logger,
    );
    assertStrictEquals(result.value, true);
    assertStrictEquals(result.variant, "on");
    assertStrictEquals(result.reason, StandardResolutionReasons.STATIC);
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("flag resolution > resolves string flags", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('greeting', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('greeting', 'hello', 'string', '"Hello, world!"')
    `);

    await provider.initialize();

    const result = await provider.resolveStringEvaluation(
      "greeting",
      "",
      {},
      logger,
    );
    assertStrictEquals(result.value, "Hello, world!");
    assertStrictEquals(result.variant, "hello");
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("flag resolution > resolves number flags", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('rate-limit', 'number')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('rate-limit', 'default', 'number', '100')
    `);

    await provider.initialize();

    const result = await provider.resolveNumberEvaluation(
      "rate-limit",
      0,
      {},
      logger,
    );
    assertStrictEquals(result.value, 100);
    assertStrictEquals(result.variant, "default");
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("flag resolution > resolves object flags", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('config', 'object')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('config', 'v1', 'object', '{"theme": "dark", "limit": 10}')
    `);

    await provider.initialize();

    const result = await provider.resolveObjectEvaluation(
      "config",
      {},
      {},
      logger,
    );
    assertEquals(result.value, { theme: "dark", limit: 10 });
    assertStrictEquals(result.variant, "v1");
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("error handling > throws FlagNotFoundError for missing flags", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await provider.initialize();

    await assertRejects(
      () => provider.resolveBooleanEvaluation("nonexistent", false, {}, logger),
      FlagNotFoundError,
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

for (const enabled of [true, false]) {
  Deno.test(`error handling > throws TypeMismatchError for wrong type (enabled=${enabled})`, async () => {
    const { pglite, pool, provider } = await setup();
    try {
      await pool.query(`
        INSERT INTO openfeature.feature_flags (flag_key, flag_type, enabled)
        VALUES ('bool-flag', 'boolean', ${enabled})
      `);
      await pool.query(`
        INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
        VALUES ('bool-flag', 'on', 'boolean', 'true')
      `);

      await provider.initialize();

      await assertRejects(
        () => provider.resolveStringEvaluation("bool-flag", "", {}, logger),
        TypeMismatchError,
      );
    } finally {
      await provider.onClose();
      await pool.end();
      await pglite.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Disabled flags
// ---------------------------------------------------------------------------

Deno.test("disabled flags > returns default value with DISABLED reason", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, enabled)
      VALUES ('disabled-flag', 'boolean', false)
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('disabled-flag', 'on', 'boolean', 'true')
    `);

    await provider.initialize();

    const result = await provider.resolveBooleanEvaluation(
      "disabled-flag",
      false,
      {},
      logger,
    );
    assertStrictEquals(result.value, false); // default value, not stored value
    assertStrictEquals(result.reason, StandardResolutionReasons.DISABLED);
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

Deno.test("rollouts > returns SPLIT reason with targeting key", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('ab-test', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage)
      VALUES ('ab-test', 'control', 'string', '"Control"', NULL),
             ('ab-test', 'treatment', 'string', '"Treatment"', 50)
    `);

    await provider.initialize();

    const result = await provider.resolveStringEvaluation(
      "ab-test",
      "",
      { targetingKey: "user-123" },
      logger,
    );
    assertStrictEquals(result.reason, StandardResolutionReasons.SPLIT);
    assert(["control", "treatment"].includes(result.variant ?? ""));
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("rollouts > is deterministic for the same targeting key", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('ab-test', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage)
      VALUES ('ab-test', 'control', 'string', '"Control"', NULL),
             ('ab-test', 'treatment', 'string', '"Treatment"', 50)
    `);

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
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("rollouts > falls back to default variant without targeting key", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('ab-test', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage)
      VALUES ('ab-test', 'control', 'string', '"Control"', NULL),
             ('ab-test', 'treatment', 'string', '"Treatment"', 50)
    `);

    await provider.initialize();

    const result = await provider.resolveStringEvaluation(
      "ab-test",
      "",
      {},
      logger,
    );
    assertStrictEquals(result.variant, "control");
    assertStrictEquals(result.reason, StandardResolutionReasons.STATIC);
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("rollouts > normalizes percentages > 100 proportionally", async () => {
  // 70 + 70 = 140 total. Math.max(140, 100) = 140 as bucket divisor.
  // Buckets 0–69 → 'a' (50%), buckets 70–139 → 'b' (50%).
  // This is the intended behaviour: treat percentages as weights when they
  // overflow, so 70/70 means the same as 50/50.
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('split-test', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage)
      VALUES ('split-test', 'fallback', 'string', '"Fallback"', NULL),
             ('split-test', 'a', 'string', '"A"', 70),
             ('split-test', 'b', 'string', '"B"', 70)
    `);

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

    // With SHA-256 and 200 users both variants should appear and neither should
    // dominate (within a generous ±30% tolerance around 50%).
    assert(
      counts.a >= 70 && counts.a <= 130,
      `Expected a ≈ 100/200, got ${counts.a}`,
    );
    assert(
      counts.b >= 70 && counts.b <= 130,
      `Expected b ≈ 100/200, got ${counts.b}`,
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

// ---------------------------------------------------------------------------
// DB constraint enforcement
// ---------------------------------------------------------------------------

Deno.test("DB constraint enforcement > rejects wrong-typed JSONB values", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('bool-flag', 'boolean')
    `);

    await assertRejects(
      () =>
        pool.query(`
        INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
        VALUES ('bool-flag', 'on', 'boolean', '"not-a-boolean"')
      `),
      Error,
      "check",
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("DB constraint enforcement > rejects JSONB arrays for object-type variants", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('tags', 'object')
    `);

    await assertRejects(
      () =>
        pool.query(`
        INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
        VALUES ('tags', 'default', 'object', '["a", "b", "c"]')
      `),
      Error,
      "check",
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("DB constraint enforcement > rejects a second default variant for the same flag", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('my-flag', 'boolean')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('my-flag', 'on', 'boolean', 'true')
    `);

    await assertRejects(
      () =>
        pool.query(`
        INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
        VALUES ('my-flag', 'off', 'boolean', 'false')
      `),
      Error,
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("DB constraint enforcement > rejects empty flag_key", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await assertRejects(
      () =>
        pool.query(`
        INSERT INTO openfeature.feature_flags (flag_key, flag_type)
        VALUES ('', 'boolean')
      `),
      Error,
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("DB constraint enforcement > rejects empty variant", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('my-flag', 'boolean')
    `);
    await assertRejects(
      () =>
        pool.query(`
        INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
        VALUES ('my-flag', '', 'boolean', 'true')
      `),
      Error,
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

// ---------------------------------------------------------------------------
// initialize() behaviour
// ---------------------------------------------------------------------------

Deno.test("initialize > propagates syncCache errors to the caller", async () => {
  const pglite = new PGlite();
  const pool = createPool(pglite);
  // Do NOT run migration — the query inside syncCache will fail (schema missing)
  const provider = new PostgresProvider({
    pool,
  });
  try {
    await assertRejects(() => provider.initialize(), Error);
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("initialize > double-call is a no-op", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await provider.initialize();
    await provider.initialize(); // should not throw or create a second listener
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

Deno.test("initialize > onClose before initialize is a no-op", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await provider.onClose(); // should not throw on uninitialized provider
  } finally {
    await pool.end();
    await pglite.close();
  }
});

Deno.test("initialize > initialize after onClose is a no-op", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await provider.initialize();
    await provider.onClose();
    await provider.initialize(); // should not re-initialize after dispose
  } finally {
    await pool.end();
    await pglite.close();
  }
});

Deno.test("initialize > resolves multiple flags simultaneously", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('flag-a', 'boolean'), ('flag-b', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('flag-a', 'on', 'boolean', 'true'),
             ('flag-b', 'hello', 'string', '"world"')
    `);

    await provider.initialize();

    const a = await provider.resolveBooleanEvaluation(
      "flag-a",
      false,
      {},
      logger,
    );
    assertStrictEquals(a.value, true);

    const b = await provider.resolveStringEvaluation("flag-b", "", {}, logger);
    assertStrictEquals(b.value, "world");
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

// ---------------------------------------------------------------------------
// Rollout edge cases
// ---------------------------------------------------------------------------

Deno.test("rollouts > 100% rollout never falls through to default", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type)
      VALUES ('full-rollout', 'string')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage)
      VALUES ('full-rollout', 'default', 'string', '"Default"', NULL),
             ('full-rollout', 'treatment', 'string', '"Treatment"', 100)
    `);

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
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

// ---------------------------------------------------------------------------
// Property tests for rollout bucketing
// ---------------------------------------------------------------------------

import fc from "fast-check";
import { pickRolloutVariant } from "./provider.ts";

const rolloutEntryArb = fc.record({
  variant: fc.string({ minLength: 1, maxLength: 20 }),
  percentage: fc.integer({ min: 0, max: 100 }),
});

const flagKeyArb = fc.string({ minLength: 1, maxLength: 50 });
const targetingKeyArb = fc.string({ minLength: 1, maxLength: 100 });

Deno.test("property > pickRolloutVariant is deterministic", () => {
  fc.assert(
    fc.property(
      flagKeyArb,
      targetingKeyArb,
      fc.array(rolloutEntryArb, { minLength: 1, maxLength: 10 }),
      (flagKey, targetingKey, rollout) => {
        const flag = {
          flagType: "string" as const,
          defaultVariant: "fallback",
          enabled: true,
          variants: new Map<string, unknown>([
            ["fallback", "f"],
            ...rollout.map((r) => [r.variant, r.variant] as [string, string]),
          ]),
          rollout,
        };
        const a = pickRolloutVariant(flagKey, flag, targetingKey);
        const b = pickRolloutVariant(flagKey, flag, targetingKey);
        return a === b;
      },
    ),
  );
});

Deno.test("property > pickRolloutVariant always returns a known variant", () => {
  fc.assert(
    fc.property(
      flagKeyArb,
      targetingKeyArb,
      fc.array(rolloutEntryArb, { minLength: 1, maxLength: 10 }),
      (flagKey, targetingKey, rollout) => {
        const defaultVariant = "fallback";
        const validVariants = new Set([
          defaultVariant,
          ...rollout.map((r) => r.variant),
        ]);
        const flag = {
          flagType: "string" as const,
          defaultVariant,
          enabled: true,
          variants: new Map<string, unknown>(
            [...validVariants].map((v) => [v, v]),
          ),
          rollout,
        };
        const result = pickRolloutVariant(flagKey, flag, targetingKey);
        return validVariants.has(result);
      },
    ),
  );
});

Deno.test("property > overflow rollout never falls through to default", () => {
  fc.assert(
    fc.property(
      flagKeyArb,
      fc
        .array(
          fc.record({
            variant: fc.constantFrom("a", "b", "c"),
            percentage: fc.integer({ min: 34, max: 100 }),
          }),
          { minLength: 2, maxLength: 3 },
        )
        .map((arr) => [...new Map(arr.map((r) => [r.variant, r])).values()])
        .filter((arr) => arr.reduce((s, r) => s + r.percentage, 0) > 100),
      (flagKey, rollout) => {
        const flag = {
          flagType: "string" as const,
          defaultVariant: "fallback",
          enabled: true,
          variants: new Map<string, unknown>([
            ["fallback", "F"],
            ...rollout.map((r) => [r.variant, r.variant] as [string, string]),
          ]),
          rollout,
        };
        for (let i = 0; i < 200; i++) {
          if (pickRolloutVariant(flagKey, flag, `u-${i}`) === "fallback") {
            return false;
          }
        }
        return true;
      },
    ),
    { numRuns: 20 },
  );
});

// ---------------------------------------------------------------------------
// Background sync behaviour
// ---------------------------------------------------------------------------

Deno.test("background sync > reconnects after connection loss", async () => {
  const pglite = new PGlite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  await pool.query(`
    INSERT INTO openfeature.feature_flags (flag_key, flag_type)
    VALUES ('test-flag', 'boolean')
  `);
  await pool.query(`
    INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
    VALUES ('test-flag', 'on', 'boolean', 'true')
  `);

  // Capture the listener's internal client via a pool.connect wrapper
  let listenerClient:
    | { emit: (event: string, ...args: unknown[]) => void }
    | null = null;
  const origConnect = pool.connect.bind(pool);
  // deno-lint-ignore no-explicit-any
  (pool as any).connect = async () => {
    const c = await origConnect();
    listenerClient = c;
    return c;
  };

  const provider = new PostgresProvider({ pool });
  await provider.initialize();

  const stale = new Promise<void>((resolve) => {
    provider.events.addHandler(ProviderEvents.Stale, () => resolve());
  });

  // Simulate connection loss
  listenerClient!.emit("error", new Error("simulated disconnect"));

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

  await provider.onClose();
  await pool.end();
  await pglite.close();
});

Deno.test("background sync > emits Stale when a notification-triggered sync fails", async () => {
  const pglite = new PGlite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  let failQueries = false;
  const wrappedPool = {
    connect: () => pool.connect(),
    query: (sql: string) => {
      if (failQueries) return Promise.reject(new Error("DB down"));
      return pool.query(sql);
    },
  } as unknown as typeof pool;

  const provider = new PostgresProvider({
    pool: wrappedPool,
  });

  await provider.initialize();
  failQueries = true;

  const stale = new Promise<void>((resolve) => {
    provider.events.addHandler(ProviderEvents.Stale, () => resolve());
  });

  // Trigger onNotification path via a direct NOTIFY
  await pool.query("NOTIFY openfeature_flag_change");
  await stale;

  await provider.onClose();
  await pool.end();
  await pglite.close();
});

Deno.test("background sync > does not emit ConfigurationChanged when nothing changed", async () => {
  const pglite = new PGlite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  await pool.query(`
    INSERT INTO openfeature.feature_flags (flag_key, flag_type)
    VALUES ('stable-flag', 'boolean')
  `);
  await pool.query(`
    INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
    VALUES ('stable-flag', 'on', 'boolean', 'true')
  `);

  const provider = new PostgresProvider({
    pool,
  });

  await provider.initialize();

  let changeCount = 0;
  provider.events.addHandler(ProviderEvents.ConfigurationChanged, () => {
    changeCount++;
  });

  // Trigger a sync via NOTIFY without changing any data — cache is identical,
  // so ConfigurationChanged must not fire.
  await pool.query("NOTIFY openfeature_flag_change");
  await new Promise((resolve) => setTimeout(resolve, 200));

  assertStrictEquals(changeCount, 0, "should not fire when cache is unchanged");

  await provider.onClose();
  await pool.end();
  await pglite.close();
});
