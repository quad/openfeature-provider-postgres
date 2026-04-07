import { assert } from "jsr:@std/assert@1";
import {
  createPgLite,
  createPool,
} from "./pglite-helper.test.ts";
import { startNotifyListener } from "./listener.ts";

Deno.test("startNotifyListener > receives notifications via LISTEN/NOTIFY", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  try {
    const notifications: number[] = [];
    const listener = await startNotifyListener({
      pool,
      channelName: "flag_change",
      onNotification: () => notifications.push(Date.now()),
      onReconnect: () => {},
      onConnectionLost: () => {},
    });

    // Send a notification via the pool (separate connection)
    await pool.query("NOTIFY flag_change");
    await new Promise((r) => setTimeout(r, 100));

    assert(
      notifications.length >= 1,
      "should have received at least one notification",
    );

    listener[Symbol.dispose]();
  } finally {
    await pool.end();
    await pglite.close();
  }
});

Deno.test("startNotifyListener > disposes cleanly", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  try {
    const listener = await startNotifyListener({
      pool,
      channelName: "flag_change",
      onNotification: () => {},
      onReconnect: () => {},
      onConnectionLost: () => {},
    });

    // Should not throw
    listener[Symbol.dispose]();
    // Idempotent dispose
    listener[Symbol.dispose]();
  } finally {
    await pool.end();
    await pglite.close();
  }
});
