import { assertStrictEquals } from "jsr:@std/assert@1";
import { deadline } from "@std/async/deadline";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { insertFlag, withDb } from "./pglite-helper.test.ts";
import { PostgresProvider } from "./provider.ts";

Deno.test("end-to-end flag change via NOTIFY", () =>
  withDb(async (pool) => {
    await insertFlag(pool, "my-flag", "boolean", [
      { name: "on", value: "true" },
      { name: "off", value: "false", percentage: 100 },
    ]);

    const provider = new PostgresProvider({ pool });
    await OpenFeature.setProviderAndWait("test", provider);
    const client = OpenFeature.getClient("test");

    // Evaluate initial value (default variant is 'on' → true)
    const initial = await client.getBooleanValue("my-flag", false);
    assertStrictEquals(initial, true);

    // Listen for configuration change
    const changed = new Promise<void>((resolve) => {
      client.addHandler(ProviderEvents.ConfigurationChanged, () => resolve());
    });

    // Swap the default to 'off' — triggers NOTIFY via UPDATE trigger.
    // Two statements: remove old default first, then set new one.
    // A single CASE UPDATE violates the partial unique index mid-statement in PGlite.
    await pool.query(`
      UPDATE openfeature.flag_variants SET percentage = 50 WHERE flag_key = 'my-flag' AND variant = 'on'
    `);
    await pool.query(`
      UPDATE openfeature.flag_variants SET percentage = NULL WHERE flag_key = 'my-flag' AND variant = 'off'
    `);

    await deadline(changed, 1_000);

    // Evaluate updated value (default variant is now 'off' → false)
    const updated = await client.getBooleanValue("my-flag", true);
    assertStrictEquals(updated, false);

    await OpenFeature.clearProviders();
  }));

Deno.test("onClose is idempotent", () =>
  withDb(async (pool) => {
    const provider = new PostgresProvider({ pool });
    await provider.initialize();

    // Double close should not throw
    await provider.onClose();
    await provider.onClose();
  }));
