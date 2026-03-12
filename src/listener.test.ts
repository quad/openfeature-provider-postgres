import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client, Pool } from "@middle-management/pglite-pg-adapter";
import { NotifyListener } from "./listener.ts";

describe("NotifyListener", () => {
  let pglite: PGlite;
  let pool: Pool;

  after(async () => {
    await pool?.end();
    await pglite?.close();
  });

  it("receives notifications via LISTEN/NOTIFY", async () => {
    pglite = new PGlite();
    pool = new Pool({ pglite });

    const listener = new NotifyListener({
      pool: pool as any,
      channelName: "flag_change",
      createClient: () => new Client({ pglite }) as any,
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
    pglite = new PGlite();
    pool = new Pool({ pglite });

    const listener = new NotifyListener({
      pool: pool as any,
      channelName: "flag_change",
      createClient: () => new Client({ pglite }) as any,
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
