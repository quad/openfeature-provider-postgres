/**
 * PGlite test helpers.
 *
 * The PGlite adapter (`@middle-management/pglite-pg-adapter`) exposes Pool and
 * Client classes that are structurally compatible with `pg` but are distinct
 * TypeScript types. Every test needs to bridge them via `as unknown as pg.X`.
 *
 * This module does that cast once so individual test files stay clean.
 */

// deno-lint-ignore-file no-import-prefix
import { PGlite } from "npm:@electric-sql/pglite@^0.3.0";
import { Client, Pool } from "npm:@middle-management/pglite-pg-adapter@^0.0.4";
import { DefaultLogger } from "@openfeature/server-sdk";
import type pg from "pg";

export function createPgLite(): PGlite {
  return new PGlite();
}

export function createPool(pglite: PGlite): pg.Pool {
  // @ts-ignore: PGlite ESM/CTS dual-package type mismatch
  return new Pool({ pglite }) as unknown as pg.Pool;
}

export function createClient(pglite: PGlite): pg.Client {
  // @ts-ignore: PGlite ESM/CTS dual-package type mismatch
  return new Client({ pglite }) as unknown as pg.Client;
}

export const logger = new DefaultLogger();
