// deno-lint-ignore-file no-import-prefix
import { assert } from "jsr:@std/assert@1";
import { createClient, createPgLite, createPool } from "./pglite.ts";
import { NotifyListener } from "./listener.ts";

Deno.test("NotifyListener > receives notifications via LISTEN/NOTIFY", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  try {
    const listener = new NotifyListener({
      pool,
      channelName: "flag_change",
      createClient: () => createClient(pglite),
    });

    const notifications: number[] = [];
    await listener.start({
      onNotification: () => notifications.push(Date.now()),
      onReconnect: () => {},
      onDisconnect: () => {},
    });

    // Send a notification via the pool (separate connection)
    await pool.query("NOTIFY flag_change");
    await new Promise((r) => setTimeout(r, 100));

    assert(
      notifications.length >= 1,
      "should have received at least one notification",
    );

    await listener.stop();
  } finally {
    await pool.end();
    await pglite.close();
  }
});

Deno.test("NotifyListener > stops cleanly", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  try {
    const listener = new NotifyListener({
      pool,
      channelName: "flag_change",
      createClient: () => createClient(pglite),
    });

    await listener.start({
      onNotification: () => {},
      onReconnect: () => {},
      onDisconnect: () => {},
    });

    // Should not throw
    await listener.stop();
    // Idempotent stop
    await listener.stop();
  } finally {
    await pool.end();
    await pglite.close();
  }
});
