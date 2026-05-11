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
  variants: { name: string; value: string; weight?: number }[],
  { enabled = true } = {},
) {
  await pool.query(
    "INSERT INTO openfeature.flags (flag_key, flag_type, enabled) VALUES ($1, $2, $3)",
    [key, type, enabled],
  );
  for (const v of variants) {
    await pool.query(
      "INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value) VALUES ($1, $2, $3, $4)",
      [key, v.name, type, v.value],
    );
    // Default distribution row (subject NULL).
    await pool.query(
      `INSERT INTO openfeature.flag_targeting
         (flag_key, subject, flag_type, variant, weight)
       VALUES ($1, NULL, $2, $3, $4)`,
      [key, type, v.name, v.weight ?? 100],
    );
  }
}

export async function setTargeting(
  pool: pg.Pool,
  flagKey: string,
  flagType: string,
  subject: string,
  variant: string,
  weight: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO openfeature.flag_targeting
       (flag_key, subject, flag_type, variant, weight)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (flag_key, subject, variant)
     DO UPDATE SET weight = EXCLUDED.weight`,
    [flagKey, subject, flagType, variant, weight],
  );
}

export async function clearTargeting(
  pool: pg.Pool,
  flagKey: string,
  subject: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM openfeature.flag_targeting
     WHERE flag_key = $1 AND subject = $2`,
    [flagKey, subject],
  );
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
