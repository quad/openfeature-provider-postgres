/**
 * PGlite test helpers.
 *
 * A template PGlite instance with the schema applied is created once at module
 * load. Each test clones it (~100ms vs ~400ms for re-applying the DDL),
 * giving full isolation without the startup cost.
 */

import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@middle-management/pglite-pg-adapter";
import type pg from "pg";

const ddl = Deno.readTextFileSync(
  new URL("../schema.sql", import.meta.url),
);

function createPool(pglite: PGlite): pg.Pool {
  // @ts-expect-error: PGlite ESM/CTS dual-package type mismatch
  return new Pool({ pglite }) as unknown as pg.Pool;
}

const template = new PGlite();
await template.exec(ddl);

export async function insertFlag(
  pool: pg.Pool,
  key: string,
  type: string,
  variants: { name: string; value: string; percentage?: number }[],
  enabled = true,
) {
  await pool.query(
    "INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ($1, $2, $3)",
    [key, type, enabled],
  );
  for (const v of variants) {
    await pool.query(
      "INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage) VALUES ($1, $2, $3, $4, $5)",
      [key, v.name, type, v.value, v.percentage ?? null],
    );
  }
}

export async function withDb(
  fn: (pool: pg.Pool) => Promise<void>,
  { applySchema = true } = {},
): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const pglite = stack.adopt(
    applySchema ? (await template.clone()) as PGlite : new PGlite(),
    (p) => p.close(),
  );
  const pool = stack.adopt(createPool(pglite), (p) => p.end());
  await fn(pool);
}
