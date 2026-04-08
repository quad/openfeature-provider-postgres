import { backOff } from "exponential-backoff";
import pg from "pg";

export interface NotifyListenerOptions {
  pool: pg.Pool;
  channelName: string;
  onNotification: () => void;
  onReconnect: () => void;
  onConnectionLost: () => void;
}

export async function startNotifyListener(
  options: NotifyListenerOptions,
): Promise<Disposable> {
  const { pool, channelName, onNotification, onConnectionLost, onReconnect } =
    options;
  let state: "listening" | "reconnecting" | "stopped" = "stopped";

  async function connect(): Promise<pg.PoolClient> {
    const c = await pool.connect();
    c.on("notification", onNotification);
    c.on("error", handleConnectionLost);
    c.on("end", handleConnectionLost);
    await c.query(`LISTEN ${pg.escapeIdentifier(channelName)}`);
    state = "listening";
    return c;
  }

  function handleConnectionLost(): void {
    if (state === "stopped" || state === "reconnecting") return;
    state = "reconnecting";
    client.release(true);
    onConnectionLost();
    backOff(async () => { client = await connect(); }, {
      numOfAttempts: Infinity,
      maxDelay: 30_000,
      jitter: "full",
      retry: () => state !== "stopped",
    })
      .then(() => onReconnect())
      .catch(() => {
        // stopped during reconnection — nothing to do
      });
  }

  let client = await connect();

  return {
    [Symbol.dispose]() {
      const wasListening = state === "listening";
      state = "stopped";
      if (wasListening) client.release(true);
    },
  };
}
