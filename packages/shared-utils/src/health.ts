/**
 * Health bookkeeping every app shares: webhook counters, the health error
 * list, heartbeats and cron last-run stamps. The Redis client is a
 * parameter (structurally satisfied by @upstash/redis).
 *
 * Readers depend on these exact keys and value shapes: the middleware's
 * /api/health, the command center System health page, the agent's
 * error-surface cron, @aac/watchdog and tools/src/triage. Change a shape
 * here only together with every reader.
 *
 * Never throws. These are observability, never the reason a webhook or
 * cron fails: with Redis down the write is logged (console, via the
 * shared logger) and the caller carries on.
 */

import { easternDate } from './eastern.js';
import { createLogger } from './logger.js';
import { keys, ttl } from './redis.js';

const log = createLogger('health');

/** The Redis calls health bookkeeping needs (each function takes only the ones it uses). */
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
export async function trackWebhookProcessed(
  redis: Pick<HealthRedis, 'incr' | 'set' | 'expire'>,
  source: string,
): Promise<void> {
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
  redis: Pick<HealthRedis, 'lpush' | 'ltrim'>,
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
export async function writeHeartbeat(redis: Pick<HealthRedis, 'set'>, app: string): Promise<void> {
  try {
    await redis.set(keys.heartbeat(app), new Date().toISOString());
  } catch (err) {
    log.error('writeHeartbeat failed (swallowed)', err, { app });
  }
}

/** Stamp a cron's last-run time and store today's (UTC) result counts. */
export async function trackCronRun(
  redis: Pick<HealthRedis, 'set'>,
  jobName: string,
  result: CronRunResult,
): Promise<void> {
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

// ── Silent-skip conditions ──────────────────────────────────────────────

/**
 * Every counted condition: a skip or degradation that costs the business
 * something but is not an error (no exception, no health:errors entry).
 * The value is the plain-English line the command center shows.
 */
export const CONDITIONS = {
  'invoice-create.no_person': 'Job not invoiced: no Pipedrive person matched the calendar event',
  'invoice-create.no_qb_customer': 'Job not invoiced: no QuickBooks customer for the Pipedrive person',
  'invoice-create.no_accepted_estimate': 'Job not invoiced: the customer has no accepted quote',
  'invoice-create.multi_accepted_estimate': 'Job not invoiced: several accepted quotes (texted at the time)',
  'reminders.no_person': 'Day-before reminder not sent: no Pipedrive person for the job',
  'reminders.no_phone': 'Day-before reminder not sent: the Pipedrive person has no phone',
  'followups.no_person': 'Post-job follow-up not sent: no Pipedrive person for the job',
  'followups.no_phone': 'Post-job follow-up not sent: the Pipedrive person has no phone',
  'dispatch.stub_skipped': 'Scheduling: an agreed slot produced no STUB event',
  'dispatch.classifier_rejected': 'Scheduling: the Gemini classifier failed on a message',
  'router.read_failed': 'Inbound router: a customer burst could not be read',
  'intake.generation_failed': 'Intake draft: Gemini produced no draft',
  'followup.skeleton_fallback': 'Post-quote follow-up: the template skeleton was used instead of a draft',
  'pd-webhook.qb_disconnected': 'Pipedrive sync: QuickBooks disconnected, customer not synced',
  'pd-webhook.lost_lock_no_contact': 'Pipedrive sync: lost the create race and no Quo contact appeared',
  'booking-sync.error': 'Booking sync: a booked job could not be checked against its quote',
  'quote-email.no_scope': 'Quote email channel: the Google token lacks gmail.readonly',
  'stale-quotes.note_failed': 'Stale quotes: a follow-up note could not be posted to Quo',
  'gemini.canary_failed': 'Gemini canary: the hourly test call failed',
} as const;

export type ConditionName = keyof typeof CONDITIONS;

/**
 * Conditions also kept in a rolling window (keys.healthConditionRecent) so
 * the watchdog can count the last hour: these two are how a degraded
 * Gemini shows up in the live paths.
 */
export const ROLLING_CONDITIONS: ReadonlySet<ConditionName> = new Set<ConditionName>([
  'router.read_failed',
  'dispatch.classifier_rejected',
]);

/** What the skip skipped, when the reader needs to name it (e.g. the job not invoiced). */
export interface ConditionEntity {
  id: string;
  /** Human label, e.g. "Jane Doe · 12 Main St · 2026-11-05". */
  label?: string;
}

/** One keys.healthConditionEntities value (JSON). */
export interface ConditionEntityRecord {
  label?: string;
  /** ISO time of the latest occurrence. */
  at: string;
}

/** The Redis calls countCondition uses (structurally satisfied by @upstash/redis). */
export interface ConditionRedis {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hset(key: string, kv: Record<string, string>): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  zadd(
    key: string,
    scoreMember: { score: number; member: string },
    ...more: Array<{ score: number; member: string }>
  ): Promise<number | null>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
}

export interface CountConditionOptions {
  /** Occurrences to add (default 1). */
  by?: number;
  /** Record what was skipped (keep to low-volume conditions). */
  entity?: ConditionEntity;
  now?: Date;
}

/**
 * Count one silent skip: HINCRBY keys.healthConditions(Eastern day) with a
 * 14-day TTL, plus the entity (when given) and the rolling window (for
 * ROLLING_CONDITIONS). Never throws.
 */
export async function countCondition(
  redis: ConditionRedis,
  name: ConditionName,
  opts: CountConditionOptions = {},
): Promise<void> {
  const by = Math.max(1, Math.floor(opts.by ?? 1));
  const now = opts.now ?? new Date();
  const day = easternDate(now);
  try {
    const dayKey = keys.healthConditions(day);
    await redis.hincrby(dayKey, name, by);
    await redis.expire(dayKey, ttl.healthConditions);
    if (opts.entity) {
      const entKey = keys.healthConditionEntities(day);
      const rec: ConditionEntityRecord = { ...(opts.entity.label ? { label: opts.entity.label } : {}), at: now.toISOString() };
      await redis.hset(entKey, { [`${name}|${opts.entity.id}`]: JSON.stringify(rec) });
      await redis.expire(entKey, ttl.healthConditions);
    }
    if (ROLLING_CONDITIONS.has(name)) {
      const recentKey = keys.healthConditionRecent(name);
      const t = now.getTime();
      const salt = Math.random().toString(36).slice(2, 8);
      const members = Array.from({ length: by }, (_, i) => ({ score: t, member: `${t}:${i}:${salt}` }));
      await redis.zadd(recentKey, members[0], ...members.slice(1));
      await redis.zremrangebyscore(recentKey, 0, t - ttl.healthConditionRecent * 1000);
      await redis.expire(recentKey, ttl.healthConditionRecent);
    }
  } catch (err) {
    log.error('countCondition failed (swallowed)', err, { condition: name, by });
  }
}
