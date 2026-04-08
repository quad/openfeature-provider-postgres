/**
 * PGlite test helpers.
 *
 * The PGlite adapter (`@middle-management/pglite-pg-adapter`) exposes a Pool
 * class that is structurally compatible with `pg` but is a distinct TypeScript
 * type. This module does the cast once so individual test files stay clean.
 */

import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@middle-management/pglite-pg-adapter";
import type pg from "pg";

const schema = Deno.readTextFileSync(
  new URL("../schema.sql", import.meta.url),
);

export function createPool(pglite: PGlite): pg.Pool {
  // @ts-ignore: PGlite ESM/CTS dual-package type mismatch
  return new Pool({ pglite }) as unknown as pg.Pool;
}

export async function insertFlag(
  pool: pg.Pool,
  key: string,
  type: string,
  variants: { name: string; value: string; percentage?: number }[],
  { enabled = true } = {},
) {
  await pool.query(
    `INSERT INTO openfeature.feature_flags (flag_key, flag_type, enabled) VALUES ('${key}', '${type}', ${enabled})`,
  );
  for (const v of variants) {
    await pool.query(
      `INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage) ` +
        `VALUES('${key}', '${v.name}', '${type}', '${v.value}', ${
          v.percentage ?? "NULL"
        })`,
    );
  }
}

export async function withDb(
  fn: (pool: pg.Pool) => Promise<void>,
  { applySchema = true } = {},
): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const pglite = stack.adopt(new PGlite(), (p) => p.close());
  const pool = stack.adopt(createPool(pglite), (p) => p.end());
  if (applySchema) await pglite.exec(schema);
  await fn(pool);
}
