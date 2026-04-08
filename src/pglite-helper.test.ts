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

export async function withDb(
  fn: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const pglite = stack.adopt(new PGlite(), (p) => p.close());
  const pool = stack.adopt(createPool(pglite), (p) => p.end());
  await pglite.exec(schema);
  await fn(pool);
}
