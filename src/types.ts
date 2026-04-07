import type { Client, ClientConfig, Pool } from "pg";

export interface FlagData {
  flagKey: string;
  flagType: "boolean" | "string" | "number" | "object";
  defaultVariant: string;
  enabled: boolean;
  variants: Map<string, unknown>;
  rollout: RolloutEntry[] | null;
}

export interface RolloutEntry {
  variant: string;
  percentage: number;
}

export interface PostgresProviderOptions {
  pool: Pool;
  schema?: string;
  channelName?: string;
  syncIntervalMs?: number;
  /** Override client creation for the LISTEN connection (e.g. for testing with PGlite). */
  createClient?: () => Client;
  /**
   * Explicit config for the LISTEN connection client. An alternative to `createClient`
   * when a connection string URL or non-standard pool setup makes the default
   * pool-options extraction unreliable.
   */
  listenerClientConfig?: ClientConfig;
}

export const DEFAULT_SCHEMA = "openfeature";
export const DEFAULT_CHANNEL = "flag_change";
export const DEFAULT_SYNC_INTERVAL_MS = 300_000;
