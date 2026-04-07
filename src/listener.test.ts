import { assert } from "jsr:@std/assert@1";
import {
  createPgLite,
  createPool,
} from "./pglite-helper.test.ts";
import { NotifyListener } from "./listener.ts";

Deno.test("NotifyListener > receives notifications via LISTEN/NOTIFY", async () => {
  const pglite = createPgLite();
  const pool = createPool(pglite);
  try {
    const notifications: number[] = [];
    const listener = new NotifyListener({
      pool,
      channelName: "flag_change",
      callbacks: {
        onNotification: () => notifications.push(Date.now()),
        onReconnect: () => {},
        onDisconnect: () => {},
      },
    });

    await listener.start();

    // Send a notification via the pool (separate connection)
    await pool.query("NOTIFY flag_change");
    await new Promise((r) => setTimeout(r, 100));

    assert(
      notifications.length >= 1,
      "should have received at least one notification",
    );

    await listener[Symbol.asyncDispose]();
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
      callbacks: {
        onNotification: () => {},
        onReconnect: () => {},
        onDisconnect: () => {},
      },
    });

    await listener.start();

    // Should not throw
    await listener[Symbol.asyncDispose]();
    // Idempotent stop
    await listener[Symbol.asyncDispose]();
  } finally {
    await pool.end();
    await pglite.close();
  }
});
