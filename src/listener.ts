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
  let client: pg.PoolClient | null = null;
  let state: "listening" | "reconnecting" | "stopped" = "listening";

  async function connect(): Promise<void> {
    client = await pool.connect();
    client.on("notification", onNotification);
    client.on("error", handleConnectionLost);
    client.on("end", handleConnectionLost);
    await client.query(`LISTEN ${pg.escapeIdentifier(channelName)}`);
    state = "listening";
  }

  function releaseClient(): void {
    if (!client) return;
    client.release(true);
    client = null;
  }

  function handleConnectionLost(): void {
    if (state === "stopped" || state === "reconnecting") return;
    state = "reconnecting";
    releaseClient();
    onConnectionLost();
    backOff(() => connect(), {
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

  await connect();

  return {
    [Symbol.dispose]() {
      state = "stopped";
      releaseClient();
    },
  };
}
