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
  INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES
    ('dark-mode',   'on',    'boolean', 'true'),
    ('dark-mode',   'off',   'boolean', 'false'),
    ('greeting',    'hello', 'string',  '"Hello, world!"'),
    ('greeting',    'hi',    'string',  '"Hi there!"'),
    ('max-retries', 'low',   'number',  '3'),
    ('max-retries', 'high',  'number',  '10')
`);

// Weighted default distribution for each flag (NULL subject = "everyone
// except a per-subject override").
await pool.query(`
  INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight) VALUES
    ('dark-mode',   NULL, 'boolean', 'on',    1),
    ('dark-mode',   NULL, 'boolean', 'off',   0),
    ('greeting',    NULL, 'string',  'hello', 100),
    ('greeting',    NULL, 'string',  'hi',    100),
    ('max-retries', NULL, 'number',  'low',   1),
    ('max-retries', NULL, 'number',  'high',  0)
`);

// Pin user-1 to the "hi" greeting regardless of the default distribution.
await pool.query(`
  INSERT INTO openfeature.flag_targeting (flag_key, subject, flag_type, variant, weight) VALUES
    ('greeting', 'user-1', 'string', 'hi', 1)
`);

// --- wire up the provider ---

const provider = new PostgresProvider({ pool, jitter: false });
await OpenFeature.setProviderAndWait("example", provider);
const client = OpenFeature.getClient("example");

// --- evaluate flags ---

const darkMode = await client.getBooleanValue("dark-mode", false);
console.log("dark-mode:", darkMode);

// Variant selection is deterministic per targeting key — the same user
// always sees the same variant. user-1 is pinned via a flag_targeting row;
// the rest fall through to the 50/50 default split.
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
