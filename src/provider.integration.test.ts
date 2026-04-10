import { assertStrictEquals } from "jsr:@std/assert@1";
import { deadline } from "@std/async/deadline";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { insertFlag, withDb } from "./pglite-helper.test.ts";
import { PostgresProvider } from "./provider.ts";

Deno.test("end-to-end flag change via NOTIFY", () =>
  withDb(async (pool) => {
    await insertFlag(pool, "my-flag", "boolean", [
      { name: "on", value: "true", weight: 1 },
      { name: "off", value: "false", weight: 0 },
    ]);

    const provider = new PostgresProvider({ pool, jitter: false });
    await OpenFeature.setProviderAndWait("test", provider);
    const client = OpenFeature.getClient("test");

    // Evaluate initial value (only 'on' has weight → true)
    const initial = await client.getBooleanValue("my-flag", false);
    assertStrictEquals(initial, true);

    // Listen for configuration change
    const changed = new Promise<void>((resolve) => {
      client.addHandler(ProviderEvents.ConfigurationChanged, () => resolve());
    });

    // Swap weights in a single transaction so NOTIFY fires once
    // and the provider never sees an intermediate state.
    await pool.query("BEGIN");
    await pool.query(`
      UPDATE openfeature.flag_variants SET weight = 0 WHERE flag_key = 'my-flag' AND variant = 'on'
    `);
    await pool.query(`
      UPDATE openfeature.flag_variants SET weight = 1 WHERE flag_key = 'my-flag' AND variant = 'off'
    `);
    await pool.query("COMMIT");

    await deadline(changed, 1_000);

    // Evaluate updated value (only 'off' has weight → false)
    const updated = await client.getBooleanValue("my-flag", true);
    assertStrictEquals(updated, false);

    await OpenFeature.clearProviders();
  }));

Deno.test("onClose is idempotent", () =>
  withDb(async (pool) => {
    const provider = new PostgresProvider({ pool, jitter: false });
    await provider.initialize();

    // Double close should not throw
    await provider.onClose();
    await provider.onClose();
  }));
