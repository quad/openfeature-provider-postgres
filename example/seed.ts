import { readFileSync } from "node:fs";
import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://localhost:5432/flags",
});

const migration = readFileSync(
  new URL("../migration.sql", import.meta.url),
  "utf8",
);
const seed = readFileSync(new URL("seed.sql", import.meta.url), "utf8");

await pool.query(migration);
await pool.query(seed);

console.log("Migration and seed data applied.");
await pool.end();
