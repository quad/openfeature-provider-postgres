/**
 * PGlite test helpers.
 *
 * The PGlite adapter (`@middle-management/pglite-pg-adapter`) exposes a Pool
 * class that is structurally compatible with `pg` but is a distinct TypeScript
 * type. This module does the cast once so individual test files stay clean.
 */

import type { PGlite } from "npm:@electric-sql/pglite@^0.3.0";
import { Pool } from "npm:@middle-management/pglite-pg-adapter@^0.0.4";
import type pg from "pg";

export function createPool(pglite: PGlite): pg.Pool {
  // @ts-ignore: PGlite ESM/CTS dual-package type mismatch
  return new Pool({ pglite }) as unknown as pg.Pool;
}
