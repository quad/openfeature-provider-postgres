import { assertStrictEquals } from "jsr:@std/assert@1";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { PostgresProvider } from "./provider.ts";
import { createPgLite, createPool } from "./pglite-helper.test.ts";

const migration = Deno.readTextFileSync(
  new URL("../schema.sql", import.meta.url),
);

Deno.test("Integration: initialize → insert → ConfigurationChanged → evaluate", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  // Insert initial flag before provider starts
  await pool.query(`
    INSERT INTO openfeature.feature_flags (flag_key, flag_type)
    VALUES ('my-flag', 'boolean')
  `);
  await pool.query(`
    INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value, percentage)
    VALUES ('my-flag', 'on',  'boolean', 'true',  NULL),
           ('my-flag', 'off', 'boolean', 'false', 100)
  `);

  const provider = new PostgresProvider({
    pool,
  });

  await OpenFeature.setProviderAndWait("test", provider);
  const client = OpenFeature.getClient("test");

  // Evaluate initial value (default variant is 'on' → true)
  const initial = await client.getBooleanValue("my-flag", false);
  assertStrictEquals(initial, true);

  // Listen for configuration change
  const changed = new Promise<void>((resolve) => {
    client.addHandler(ProviderEvents.ConfigurationChanged, () => resolve());
  });

  // Swap the default to 'off' — triggers NOTIFY via UPDATE trigger
  await pool.query(`
    UPDATE openfeature.flag_variants
    SET percentage = CASE WHEN variant = 'off' THEN NULL ELSE 100 END
    WHERE flag_key = 'my-flag'
  `);

  // Wait for the ConfigurationChanged event
  await changed;

  // Evaluate updated value (default variant is now 'off' → false)
  const updated = await client.getBooleanValue("my-flag", true);
  assertStrictEquals(updated, false);

  // Cleanup
  await OpenFeature.clearProviders();
  await pool.end();
  await pglite.close();
});

Deno.test("Integration: onClose cleanup is idempotent", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  await pglite.exec(migration);

  const provider = new PostgresProvider({
    pool,
  });

  await provider.initialize();

  // Double close should not throw
  await provider.onClose();
  await provider.onClose();

  await pool.end();
  await pglite.close();
});
