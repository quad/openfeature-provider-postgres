import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createClient, createPgLite, createPool } from "../test/pglite.ts";
import { NotifyListener } from "./listener.ts";

describe("NotifyListener", () => {
  let pglite: ReturnType<typeof createPgLite>;
  let pool: ReturnType<typeof createPool>;

  after(async () => {
    await pool?.end();
    await pglite?.close();
  });

  it("receives notifications via LISTEN/NOTIFY", async () => {
    pglite = createPgLite();
    pool = createPool(pglite);

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

    assert.ok(
      notifications.length >= 1,
      "should have received at least one notification",
    );

    await listener.stop();
  });

  it("stops cleanly", async () => {
    pglite = createPgLite();
    pool = createPool(pglite);

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
  });
});
