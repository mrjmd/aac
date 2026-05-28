/**
 * Operational Redis layer for apps/agent.
 *
 * Mirrors apps/middleware/lib/redis.ts: this file holds the operations,
 * the key schema lives in @aac/shared-utils/redis. Same Redis instance
 * as middleware — agent uses the `agent:*` keyspace plus reads
 * `health:errors` from middleware for the error-surface cron.
 */

import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from './env.js';

const log = createLogger('agent:redis');

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    const env = getEnv();
    redisClient = new Redis({
      url: env.redis.url,
      token: env.redis.token,
    });
  }
  return redisClient;
}

// ── Health ──────────────────────────────────────────────────────────

export async function writeHeartbeat(): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.heartbeat('agent'), new Date().toISOString());
}

// ── Cron cursors ────────────────────────────────────────────────────

/**
 * Read a cron-job cursor (e.g. the last surfaced error index for the
 * error-surface tick). Null if never written.
 */
export async function getCronCursor(job: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.agentCronCursor(job));
}

export async function setCronCursor(job: string, value: string): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.agentCronCursor(job), value);
  log.debug('Updated cron cursor', { job, value });
}

// ── Middleware health-error stream (READ-ONLY from agent) ───────────

export interface HealthErrorEntry {
  timestamp: string;
  source: string;
  message: string;
  details?: Record<string, unknown> | string;
}

/**
 * Read the last `limit` entries from middleware's health:errors list.
 * Entries are JSON-encoded strings in a Redis LIST (LPUSH'd by
 * middleware's logHealthError, capped at 100 by LTRIM).
 *
 * Returns newest first (index 0 = most recent), matching middleware
 * convention. Bad entries are skipped with a warning.
 */
export async function readRecentHealthErrors(limit: number = 50): Promise<HealthErrorEntry[]> {
  const redis = getRedis();
  const raw = await redis.lrange(keys.healthErrors, 0, limit - 1);

  const out: HealthErrorEntry[] = [];
  for (const entry of raw) {
    try {
      const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
      if (parsed && typeof parsed === 'object' && 'timestamp' in parsed && 'source' in parsed && 'message' in parsed) {
        out.push(parsed as HealthErrorEntry);
      }
    } catch (err) {
      log.warn('Skipping malformed health error entry', { error: (err as Error).message });
    }
  }
  return out;
}
