/**
 * Health bookkeeping every app shares: webhook counters, the health error
 * list, heartbeats and cron last-run stamps. The Redis client is a
 * parameter (structurally satisfied by @upstash/redis).
 *
 * Readers depend on these exact keys and value shapes: the middleware's
 * /api/health (and the command center through it), the agent's
 * error-surface cron, @aac/watchdog and tools/src/triage. Change a shape
 * here only together with every reader.
 *
 * Never throws. These are observability, never the reason a webhook or
 * cron fails: with Redis down the write is logged (console, via the
 * shared logger) and the caller carries on.
 */

import { createLogger } from './logger.js';
import { keys, ttl } from './redis.js';

const log = createLogger('health');

/** The Redis calls health bookkeeping needs. */
export interface HealthRedis {
  set(key: string, value: string, opts?: { ex: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  lpush(key: string, ...elements: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
}

/** `health:errors` keeps this many entries (newest first). */
export const HEALTH_ERRORS_CAP = 100;

/** One `health:errors` entry, as stored (JSON string). */
export interface HealthErrorEntry {
  source: string;
  message: string;
  details?: Record<string, unknown>;
  commitSha: string;
  timestamp: string;
}

/** A cron run's counts, stored under keys.cronResult. */
export interface CronRunResult {
  sent: number;
  skipped: number;
  errors: number;
}

/** Count a processed webhook for today and stamp the source's last-processed time. */
export async function trackWebhookProcessed(redis: HealthRedis, source: string): Promise<void> {
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  try {
    await Promise.all([
      redis.incr(keys.webhookCount(source, today)),
      redis.set(keys.webhookLast(source), now),
    ]);
    // Set TTL on the count key so it auto-cleans
    await redis.expire(keys.webhookCount(source, today), ttl.webhookCount);
  } catch (err) {
    log.error('trackWebhookProcessed failed (swallowed)', err, { source });
  }
}

/** Push one entry onto `health:errors` (newest first, capped at HEALTH_ERRORS_CAP). */
export async function logHealthError(
  redis: HealthRedis,
  source: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  // Vercel injects VERCEL_GIT_COMMIT_SHA per deploy; we stamp it on each
  // error so the agent-side notifier can dedupe within a deploy but reset
  // on a new one (Matt knows whether a fix worked instead of staying silent).
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
  const error = JSON.stringify({
    source,
    message,
    details,
    commitSha,
    timestamp: new Date().toISOString(),
  });

  try {
    await redis.lpush(keys.healthErrors, error);
    await redis.ltrim(keys.healthErrors, 0, HEALTH_ERRORS_CAP - 1);
  } catch (err) {
    // The original error goes to the log so it isn't lost with Redis down.
    log.error('logHealthError failed (swallowed)', err, { source, healthMessage: message, details });
  }
}

/** Stamp `health:{app}:ts` with the current ISO time. */
export async function writeHeartbeat(redis: HealthRedis, app: string): Promise<void> {
  try {
    await redis.set(keys.heartbeat(app), new Date().toISOString());
  } catch (err) {
    log.error('writeHeartbeat failed (swallowed)', err, { app });
  }
}

/** Stamp a cron's last-run time and store today's (UTC) result counts. */
export async function trackCronRun(redis: HealthRedis, jobName: string, result: CronRunResult): Promise<void> {
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  try {
    await Promise.all([
      redis.set(keys.cronLastRun(jobName), now),
      redis.set(keys.cronResult(jobName, today), JSON.stringify(result), { ex: ttl.cronResult }),
    ]);
  } catch (err) {
    log.error('trackCronRun failed (swallowed)', err, { jobName, result });
  }
}
