import type { Pool } from "pg";

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
}

export const DEFAULT_SCHEMA = "openfeature";
export const DEFAULT_CHANNEL = "flag_change";
export const DEFAULT_SYNC_INTERVAL_MS = 300_000;
