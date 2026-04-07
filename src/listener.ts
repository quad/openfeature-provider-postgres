import { backOff } from "exponential-backoff";
import pg from "pg";

export interface NotifyListenerCallbacks {
  onNotification: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export interface NotifyListenerOptions {
  pool: pg.Pool;
  channelName: string;
  callbacks: NotifyListenerCallbacks;
}

type ListenerState = "idle" | "listening" | "reconnecting" | "stopped";

export class NotifyListener {
  private client: pg.PoolClient | null = null;
  private state: ListenerState = "idle";
  private readonly pool: pg.Pool;
  private readonly channelName: string;
  private readonly callbacks: NotifyListenerCallbacks;

  constructor(options: NotifyListenerOptions) {
    this.pool = options.pool;
    this.channelName = options.channelName;
    this.callbacks = options.callbacks;
  }

  async start(): Promise<void> {
    this.client = await this.pool.connect();

    this.client.on("notification", () => {
      this.callbacks.onNotification();
    });

    this.client.on("error", () => {
      this.handleDisconnect();
    });

    this.client.on("end", () => {
      this.handleDisconnect();
    });

    await this.client.query(`LISTEN ${quoteIdent(this.channelName)}`);
    this.state = "listening";
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    if (this.client) {
      try {
        await this.client.query("UNLISTEN *");
      } catch {
        // ignore — connection may already be dead
      }
      this.client.release(true);
      this.client = null;
    }
  }

  private handleDisconnect(): void {
    if (this.state === "stopped" || this.state === "reconnecting") return;
    this.state = "reconnecting";
    this.client = null;
    this.callbacks.onDisconnect();
    this.reconnect();
  }

  private reconnect(): void {
    backOff(() => this.start(), {
      numOfAttempts: Infinity,
      startingDelay: 500,
      maxDelay: 30_000,
      retry: () => this.state !== "stopped",
    })
      .then(() => {
        this.callbacks.onReconnect();
      })
      .catch(() => {
        // stopped during reconnection — nothing to do
      });
  }
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
