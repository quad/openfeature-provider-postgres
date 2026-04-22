/**
 * Minimal example: evaluate feature flags backed by PGlite (in-process Postgres).
 *
 * Run:  deno run --allow-read examples/basic.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@middle-management/pglite-pg-adapter";
import { OpenFeature } from "@openfeature/server-sdk";
import type pg from "pg";
import { PostgresProvider } from "../src/provider.ts";

// --- database setup ---

const pglite = new PGlite();
const ddl = Deno.readTextFileSync(new URL("../schema.sql", import.meta.url));
await pglite.exec(ddl);

// @ts-expect-error: PGlite ESM/CTS type mismatch
const pool: pg.Pool = new Pool({ pglite });

// --- seed a couple of flags ---

await pool.query(`
  INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES
    ('dark-mode',  'boolean', true),
    ('greeting',   'string',  true),
    ('max-retries','number',  true)
`);

await pool.query(`
  INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, weight) VALUES
    ('dark-mode',   'on',    'boolean', 'true',  1),
    ('dark-mode',   'off',   'boolean', 'false', 0),
    ('greeting',    'hello', 'string',  '"Hello, world!"', 100),
    ('greeting',    'hi',    'string',  '"Hi there!"',     100),
    ('max-retries', 'low',   'number',  '3',  1),
    ('max-retries', 'high',  'number',  '10', 0)
`);

// --- wire up the provider ---

const provider = new PostgresProvider({ pool, jitter: false });
await OpenFeature.setProviderAndWait("example", provider);
const client = OpenFeature.getClient("example");

// --- evaluate flags ---

const darkMode = await client.getBooleanValue("dark-mode", false);
console.log("dark-mode:", darkMode);

// Variant selection is deterministic per targeting key — the same user always
// sees the same variant.  Evaluate a handful of users to show the split.
const users = ["user-1", "user-2", "user-3", "user-4", "user-5", "user-6"];
for (const user of users) {
  const g = await client.getStringValue("greeting", "default", {
    targetingKey: user,
  });
  console.log(`greeting (${user}):`, g);
}

const retries = await client.getNumberValue("max-retries", 1);
console.log("max-retries:", retries);

// --- clean up ---

await OpenFeature.close();
await pool.end();
await pglite.close();
