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
  /** Override client creation (used for testing with PGlite). */
  createClient?: () => pg.Client;
}

export class NotifyListener {
  private client: pg.Client | null = null;
  private callbacks: NotifyListenerCallbacks | null = null;
  private stopping = false;
  private reconnecting = false;
  private readonly channelName: string;
  private readonly createClient: () => pg.Client;

  constructor(options: NotifyListenerOptions) {
    this.channelName = options.channelName;
    this.createClient = options.createClient ??
      (() => {
        const { host, port, database, user, password, ssl } = options.pool
          .options as unknown as Record<string, unknown>;
        return new pg.Client({
          host,
          port,
          database,
          user,
          password,
          ssl,
        } as pg.ClientConfig);
      });
  }

  async start(callbacks: NotifyListenerCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.callbacks = null;
    if (this.client) {
      try {
        await this.client.query("UNLISTEN *");
      } catch {
        // ignore — connection may already be dead
      }
      try {
        await this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  private async connect(): Promise<void> {
    this.client = this.createClient();

    this.client.on("notification", () => {
      this.callbacks?.onNotification();
    });

    this.client.on("error", () => {
      this.handleDisconnect();
    });

    this.client.on("end", () => {
      this.handleDisconnect();
    });

    await this.client.connect();
    await this.client.query(`LISTEN ${quoteIdent(this.channelName)}`);
  }

  private handleDisconnect(): void {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    this.client = null;
    this.callbacks?.onDisconnect();
    this.reconnect();
  }

  private reconnect(): void {
    backOff(() => this.connect(), {
      numOfAttempts: Infinity,
      startingDelay: 500,
      maxDelay: 30_000,
      retry: () => !this.stopping,
    })
      .then(() => {
        this.reconnecting = false;
        this.callbacks?.onReconnect();
      })
      .catch(() => {
        // stopped during reconnection — nothing to do
      });
  }
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
