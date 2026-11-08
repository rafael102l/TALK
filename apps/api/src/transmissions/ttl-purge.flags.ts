/** Phase 5: server media TTL. Off until explicitly enabled. Easy rollback = unset / false. */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function loadTtlEnvFile() {
  const paths = [
    resolve(process.cwd(), ".env.ttl-purge"),
    resolve(process.cwd(), "apps/api/.env.ttl-purge"),
    resolve(__dirname, "../../.env.ttl-purge"),
  ];
  for (const file of paths) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!key) continue;
      // Host env wins except DRY_RUN, which follows this file after the live-purge go-ahead.
      if (key === "MEDIA_TTL_PURGE_DRY_RUN") process.env[key] = value;
      else if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    }
  }
}

loadTtlEnvFile();

function envFlag(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function envInt(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Master switch. Default OFF so old devices keep GET /transmissions media. */
export function ttlPurgeEnabled(): boolean {
  return envFlag("MEDIA_TTL_PURGE_ENABLED", false);
}

/**
 * Live purge when false. Host env wins; file fallback is false after Phase 6 go-ahead.
 */
export function ttlPurgeDryRun(): boolean {
  return envFlag("MEDIA_TTL_PURGE_DRY_RUN", false);
}

/** Long TTL while Phase 3 is still proving itself. */
export function ttlPurgeDays(): number {
  return envInt("MEDIA_TTL_DAYS", 14, 1);
}

export function ttlPurgeIntervalMs(): number {
  return envInt("MEDIA_TTL_INTERVAL_MS", 60 * 60 * 1000, 30_000);
}

export function ttlPurgeBatchSize(): number {
  return envInt("MEDIA_TTL_BATCH", 40, 1);
}

/** Live walkie replay window in realtime.gateway sendUnplayedWalkies. Never purge inside it. */
export const WALKIE_REPLAY_MS = 2 * 60 * 1000;

export function ttlPurgeStatus() {
  return {
    enabled: ttlPurgeEnabled(),
    dryRun: ttlPurgeDryRun(),
    ttlDays: ttlPurgeDays(),
    intervalMs: ttlPurgeIntervalMs(),
    batch: ttlPurgeBatchSize(),
    walkieReplaySec: WALKIE_REPLAY_MS / 1000,
  };
}
