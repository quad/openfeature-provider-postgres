import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client, Pool } from "@middle-management/pglite-pg-adapter";
import {
  FlagNotFoundError,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { PostgresProvider } from "./provider.ts";

const migration = readFileSync(
  new URL("../migration.sql", import.meta.url),
  "utf8",
);

async function setup() {
  const pglite = new PGlite();
  const pool = new Pool({ pglite });
  await pglite.exec(migration);

  const provider = new PostgresProvider({
    pool: pool as any,
    syncIntervalMs: 60_000_000, // effectively disabled for tests
    createClient: () => new Client({ pglite }) as any,
  } as any);

  return { pglite, pool, provider };
}

describe("PostgresProvider", () => {
  let pglite: PGlite;
  let pool: Pool;
  let provider: PostgresProvider;

  beforeEach(async () => {
    ({ pglite, pool, provider } = await setup());
  });

  afterEach(async () => {
    await provider.onClose();
    await pool.end();
    await pglite.close();
  });

  describe("flag resolution", () => {
    it("resolves boolean flags", async () => {
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
        console as any,
      );
      assert.equal(result.value, true);
      assert.equal(result.variant, "on");
      assert.equal(result.reason, StandardResolutionReasons.STATIC);
    });

    it("resolves string flags", async () => {
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
        console as any,
      );
      assert.equal(result.value, "Hello, world!");
      assert.equal(result.variant, "hello");
    });

    it("resolves number flags", async () => {
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
        console as any,
      );
      assert.equal(result.value, 100);
      assert.equal(result.variant, "default");
    });

    it("resolves object flags", async () => {
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
        console as any,
      );
      assert.deepEqual(result.value, { theme: "dark", limit: 10 });
      assert.equal(result.variant, "v1");
    });

    it("resolves array values under object type", async () => {
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
        console as any,
      );
      assert.deepEqual(result.value, ["a", "b", "c"]);
    });
  });

  describe("error handling", () => {
    it("throws FlagNotFoundError for missing flags", async () => {
      await provider.initialize();

      await assert.rejects(
        () =>
          provider.resolveBooleanEvaluation(
            "nonexistent",
            false,
            {},
            console as any,
          ),
        FlagNotFoundError,
      );
    });

    it("throws TypeMismatchError for wrong type", async () => {
      await pool.query(`
        INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
        VALUES ('bool-flag', 'boolean', 'on')
      `);
      await pool.query(`
        INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
        VALUES ('bool-flag', 'on', 'boolean', 'true')
      `);

      await provider.initialize();

      await assert.rejects(
        () =>
          provider.resolveStringEvaluation("bool-flag", "", {}, console as any),
        TypeMismatchError,
      );
    });
  });

  describe("disabled flags", () => {
    it("returns default value with DISABLED reason", async () => {
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
        console as any,
      );
      assert.equal(result.value, false); // default value, not stored value
      assert.equal(result.reason, StandardResolutionReasons.DISABLED);
    });
  });

  describe("rollouts", () => {
    it("returns SPLIT reason with targeting key", async () => {
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
        console as any,
      );
      assert.equal(result.reason, "SPLIT");
      assert.ok(["control", "treatment"].includes(result.variant ?? ""));
    });

    it("is deterministic for the same targeting key", async () => {
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
          console as any,
        );
        results.add(r.variant ?? "");
      }
      assert.equal(results.size, 1, "should be deterministic");
    });

    it("falls back to default variant without targeting key", async () => {
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
        console as any,
      );
      assert.equal(result.variant, "control");
      assert.equal(result.reason, StandardResolutionReasons.STATIC);
    });
  });

  describe("DB constraint enforcement", () => {
    it("rejects wrong-typed JSONB values", async () => {
      await pool.query(`
        INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
        VALUES ('bool-flag', 'boolean', 'on')
      `);

      await assert.rejects(
        () =>
          pool.query(`
          INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
          VALUES ('bool-flag', 'on', 'boolean', '"not-a-boolean"')
        `),
        /check/i,
      );
    });
  });

  describe("validation warnings", () => {
    it("warns when default_variant references nonexistent variant", async () => {
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

      assert.ok(
        warnings.some((w) => w.includes("nonexistent")),
        `Expected warning about nonexistent variant, got: ${warnings}`,
      );
    });
  });
});
