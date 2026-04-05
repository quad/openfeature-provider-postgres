import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  FlagNotFoundError,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { createClient, createPgLite, createPool, logger } from "./pglite.ts";
import { PostgresProvider } from "./provider.ts";

const migration = Deno.readTextFileSync(
  new URL("../migration.sql", import.meta.url),
);

async function setup() {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  const provider = new PostgresProvider({
    pool,
    syncIntervalMs: 60_000_000, // effectively disabled for tests
    createClient: () => createClient(pglite),
  });

  return { pglite, pool, provider };
}

Deno.test("flag resolution > resolves boolean flags", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('bool-flag', 'boolean', 'on')
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
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('greeting', 'string', 'hello')
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
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('rate-limit', 'number', 'default')
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
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('config', 'object', 'v1')
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

Deno.test("flag resolution > resolves array values under object type", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('tags', 'object', 'default')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('tags', 'default', 'object', '["a", "b", "c"]')
    `);

    await provider.initialize();

    const result = await provider.resolveObjectEvaluation(
      "tags",
      [],
      {},
      logger,
    );
    assertEquals(result.value, ["a", "b", "c"]);
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});

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

Deno.test("error handling > throws TypeMismatchError for wrong type", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('bool-flag', 'boolean', 'on')
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

Deno.test("disabled flags > returns default value with DISABLED reason", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant, enabled)
      VALUES ('disabled-flag', 'boolean', 'on', false)
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

Deno.test("rollouts > returns SPLIT reason with targeting key", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('ab-test', 'string', 'control')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('ab-test', 'control', 'string', '"Control"'),
             ('ab-test', 'treatment', 'string', '"Treatment"')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_rollouts (flag_key, variant, percentage)
      VALUES ('ab-test', 'treatment', 50)
    `);

    await provider.initialize();

    const result = await provider.resolveStringEvaluation(
      "ab-test",
      "",
      { targetingKey: "user-123" },
      logger,
    );
    assertStrictEquals(result.reason, "SPLIT");
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
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('ab-test', 'string', 'control')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('ab-test', 'control', 'string', '"Control"'),
             ('ab-test', 'treatment', 'string', '"Treatment"')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_rollouts (flag_key, variant, percentage)
      VALUES ('ab-test', 'treatment', 50)
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
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('ab-test', 'string', 'control')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('ab-test', 'control', 'string', '"Control"'),
             ('ab-test', 'treatment', 'string', '"Treatment"')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_rollouts (flag_key, variant, percentage)
      VALUES ('ab-test', 'treatment', 50)
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

Deno.test("DB constraint enforcement > rejects wrong-typed JSONB values", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('bool-flag', 'boolean', 'on')
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

Deno.test("validation warnings > warns when default_variant references nonexistent variant", async () => {
  const { pglite, pool, provider } = await setup();
  try {
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('bad-default', 'boolean', 'nonexistent')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('bad-default', 'on', 'boolean', 'true')
    `);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      await provider.initialize();
    } finally {
      console.warn = origWarn;
    }

    assert(
      warnings.some((w) => w.includes("nonexistent")),
      `Expected warning about nonexistent variant, got: ${warnings}`,
    );
  } finally {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  }
});
