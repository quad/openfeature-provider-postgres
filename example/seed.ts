import pg from "pg";
import process from "node:process";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ??
    "postgres://localhost:5432/flags",
});

const migration = Deno.readTextFileSync(
  new URL("../migration.sql", import.meta.url),
);
const seed = Deno.readTextFileSync(new URL("seed.sql", import.meta.url));

await pool.query(migration);
await pool.query(seed);

console.log("Migration and seed data applied.");
await pool.end();
