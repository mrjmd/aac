/**
 * Operational Redis layer for the middleware.
 *
 * This file provides the OPERATIONS (dedup, mapping, health tracking).
 * Key SCHEMA comes from @aac/shared-utils/redis.
 *
 * This is NOT a copy of shared-utils/redis.ts — that file defines key
 * builders and TTL constants. This file uses them to perform actual
 * Redis operations.
 */

import { Redis } from '@upstash/redis';
import { keys, ttl } from '@aac/shared-utils/redis';
import { createLogger } from '@aac/shared-utils/logger';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import { getEnv } from './env.js';

const log = createLogger('redis');

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

// ── Deduplication ────────────────────────────────────────────────────

/**
 * Mark a webhook event as processed. Returns true if this is a NEW event.
 * Uses SET NX (only-if-not-exists) with 24h TTL.
 */
export async function markEventProcessed(
  source: 'pipedrive' | 'quo' | 'google-ads' | 'qb',
  eventId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = keys.dedupe(source, eventId);

  const result = await redis.set(key, 'processed', { nx: true, ex: ttl.dedupe });
  const isNew = result === 'OK';

  log.debug('Dedupe check', { source, eventId, isNew });
  return isNew;
}

/**
 * Check if event was already processed (without marking it).
 */
export async function wasEventProcessed(
  source: 'pipedrive' | 'quo' | 'google-ads' | 'qb',
  eventId: string
): Promise<boolean> {
  const redis = getRedis();
  const key = keys.dedupe(source, eventId);
  const exists = await redis.exists(key);
  return exists === 1;
}

// ── ID Mapping (Pipedrive ↔ Quo) ────────────────────────────────────

export async function storeIdMapping(
  pipedriveId: string,
  quoId: string
): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.set(keys.map.pipedriveToQuo(pipedriveId), quoId, { ex: ttl.idMapping }),
    redis.set(keys.map.quoToPipedrive(quoId), pipedriveId, { ex: ttl.idMapping }),
  ]);
  log.debug('Stored ID mapping', { pipedriveId, quoId });
}

export async function getQuoIdFromPipedrive(pipedriveId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.map.pipedriveToQuo(pipedriveId));
}

export async function getPipedriveIdFromQuo(quoId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.map.quoToPipedrive(quoId));
}

// ── Phone → Pipedrive mapping ────────────────────────────────────────

export async function storePhoneMapping(
  phone: string,
  pipedriveId: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.map.phoneToPipedrive(phone), pipedriveId, { ex: ttl.idMapping });
}

export async function getPipedriveIdFromPhone(phone: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.map.phoneToPipedrive(phone));
}

// ── ID Mapping (Pipedrive ↔ QuickBooks) ──────────────────────────────

export async function storePipedriveToQbMapping(
  pipedriveId: string,
  qbCustomerId: string
): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.set(keys.map.pipedriveToQb(pipedriveId), qbCustomerId, { ex: ttl.idMapping }),
    redis.set(keys.map.qbToPipedrive(qbCustomerId), pipedriveId, { ex: ttl.idMapping }),
  ]);
  log.debug('Stored PD-QB mapping', { pipedriveId, qbCustomerId });
}

export async function getQbCustomerIdFromPipedrive(pipedriveId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.map.pipedriveToQb(pipedriveId));
}

export async function getPipedriveIdFromQb(qbCustomerId: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(keys.map.qbToPipedrive(qbCustomerId));
}

// ── Loop Prevention ──────────────────────────────────────────────────

export async function markCreatedByMiddleware(pipedriveId: string): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.createdByUs('pd', pipedriveId), '1', { ex: ttl.loopPrevention });
}

export async function wasCreatedByMiddleware(pipedriveId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(keys.createdByUs('pd', pipedriveId));
  return exists === 1;
}

// ── Contact Create Lock ─────────────────────────────────────────────

/**
 * Try to acquire a lock before creating a contact in an external system.
 * Returns true if lock acquired (you should create), false if another
 * handler is already creating for this phone (you should wait and search).
 */
export async function tryAcquireContactCreateLock(
  system: string,
  phone: string
): Promise<boolean> {
  const redis = getRedis();
  const key = keys.contactCreateLock(system, phone);
  const result = await redis.set(key, 'locked', { nx: true, ex: ttl.contactCreateLock });
  return result === 'OK';
}

// ── QuickBooks OAuth Token Storage ───────────────────────────────────

export async function storeQBTokens(tokens: QBOAuthTokens): Promise<void> {
  const redis = getRedis();
  // Pass object directly — Upstash auto-serializes/deserializes JSON
  await redis.set(keys.qbOAuthTokens, tokens);
  log.debug('Stored QB OAuth tokens');
}

export async function getQBTokens(): Promise<QBOAuthTokens | null> {
  const redis = getRedis();
  // Upstash auto-deserializes, so we get the object directly
  const data = await redis.get<QBOAuthTokens>(keys.qbOAuthTokens);
  return data || null;
}

// ── Health & Observability ───────────────────────────────────────────

export async function trackWebhookProcessed(
  source: 'pipedrive' | 'quo' | 'google-ads' | 'qb'
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  await Promise.all([
    redis.incr(keys.webhookCount(source, today)),
    redis.set(keys.webhookLast(source), now),
  ]);
  // Set TTL on the count key so it auto-cleans
  await redis.expire(keys.webhookCount(source, today), ttl.webhookCount);
}

export async function logHealthError(
  source: string,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  const redis = getRedis();
  const error = JSON.stringify({
    source,
    message,
    details,
    timestamp: new Date().toISOString(),
  });

  await redis.lpush(keys.healthErrors, error);
  await redis.ltrim(keys.healthErrors, 0, 99); // Keep last 100
}

export async function writeHeartbeat(): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.heartbeat('middleware'), new Date().toISOString());
}

// ── Scheduling Pipeline ─────────────────────────────────────────────

/**
 * Confidence threshold for routing a directive onto the auto-propose path.
 * Directives at or above this score land on `scheduling:pending:list`;
 * below it they land on `scheduling:pending-review:list` so Matt can
 * triage manually (no auto-fire SMS).
 *
 * Calibrated against the Walk #6 smoke-test (Margie's directive scored
 * ~0.55 and shouldn't have auto-fired).
 */
export const SCHEDULING_AUTO_PROPOSE_THRESHOLD = 0.7;

/**
 * Write a SchedulingDirective to the Crawl shadow queue.
 *
 * Stores the directive blob under `scheduling:pending:{id}`. Pushes its id
 * onto `scheduling:pending:list` when confidence ≥ {@link SCHEDULING_AUTO_PROPOSE_THRESHOLD}
 * (the auto-propose queue), or onto `scheduling:pending-review:list`
 * otherwise (the manual-review queue). Both lists are capped at 500 entries.
 * No TTL — the queue is for review, not transient state.
 *
 * When the directive carries a `qbEstimateId`, also writes a reverse
 * index `scheduling:directive-by-qb-estimate:{id}` so the QB reconciliation
 * cron can cheaply check whether the webhook already produced a directive
 * for this estimate.
 */
export async function writePendingDirective<
  T extends {
    id: string;
    qbEstimateId?: string;
    confidence?: { score: number };
  },
>(directive: T): Promise<void> {
  const redis = getRedis();
  const score = directive.confidence?.score ?? 0;
  const targetList =
    score >= SCHEDULING_AUTO_PROPOSE_THRESHOLD
      ? keys.schedulingPendingList
      : keys.schedulingPendingReviewList;

  const writes: Promise<unknown>[] = [
    redis.set(keys.schedulingPending(directive.id), directive),
    redis.lpush(targetList, directive.id),
  ];
  if (directive.qbEstimateId) {
    writes.push(
      redis.set(keys.schedulingDirectiveByEstimate(directive.qbEstimateId), directive.id),
    );
  }
  await Promise.all(writes);
  await redis.ltrim(targetList, 0, 499);
}

/**
 * Look up the directive ID (if any) that was already produced for a given
 * QB Estimate. Used by the QB reconciliation cron to skip estimates the
 * webhook already handled.
 */
export async function getDirectiveIdByEstimate(
  qbEstimateId: string,
): Promise<string | null> {
  const redis = getRedis();
  return (await redis.get<string>(keys.schedulingDirectiveByEstimate(qbEstimateId))) ?? null;
}

/**
 * Read a single SchedulingDirective from the shadow queue by id. Used by
 * the admin send-proposal trigger and the proposal-decision endpoint to
 * look up the directive in context.
 */
export async function getPendingDirective<T = unknown>(
  directiveId: string,
): Promise<T | null> {
  const redis = getRedis();
  return (await redis.get<T>(keys.schedulingPending(directiveId))) ?? null;
}

/**
 * Record the proposal decision posted back by the agent. Stores the
 * decision blob with a 30-day TTL and a reverse index from directive id
 * → proposal id, so the command-center can show the decision next to
 * each pending directive.
 */
export interface RecordedProposalDecision {
  proposalId: string;
  directiveId: string;
  decision: 'approved' | 'rejected' | 'edit';
  replyText: string;
  decidedAt: string;
  recordedAt: string;
}

export async function recordProposalDecision(
  payload: RecordedProposalDecision,
): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.set(keys.schedulingProposalDecision(payload.proposalId), payload, {
      ex: ttl.schedulingProposalDecision,
    }),
    redis.set(keys.schedulingProposalByDirective(payload.directiveId), payload.proposalId, {
      ex: ttl.schedulingProposalDecision,
    }),
  ]);
}

export async function getProposalDecisionForDirective(
  directiveId: string,
): Promise<RecordedProposalDecision | null> {
  const redis = getRedis();
  const proposalId = await redis.get<string>(
    keys.schedulingProposalByDirective(directiveId),
  );
  if (!proposalId) return null;
  return (await redis.get<RecordedProposalDecision>(
    keys.schedulingProposalDecision(proposalId),
  )) ?? null;
}

// ── Cron Job Tracking ───────────────────────────────────────────────

/**
 * Check if a cron action was already performed (e.g., reminder already sent
 * for a specific calendar event). Uses SET NX with TTL.
 * Returns true if this is new (not yet done), false if already done.
 */
export async function markCronAction(
  action: string,
  entityId: string,
  ttlSeconds: number = 7 * 86_400 // 7 days default
): Promise<boolean> {
  const redis = getRedis();
  const key = `cron:${action}:${entityId}`;
  const result = await redis.set(key, new Date().toISOString(), { nx: true, ex: ttlSeconds });
  return result === 'OK';
}

/**
 * Track a cron run for health observability.
 */
export async function trackCronRun(
  jobName: string,
  result: { sent: number; skipped: number; errors: number }
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  await Promise.all([
    redis.set(`cron:${jobName}:last-run`, now),
    redis.set(`cron:${jobName}:${today}:result`, JSON.stringify(result), { ex: 30 * 86_400 }),
  ]);
}

/**
 * Track scheduling-classifier dispatch volume. We don't yet have real data
 * on Quo transcript volume — this counter lets /api/health surface it so
 * we can verify the "transcripts are sparse" assumption before deciding to
 * drop the matt-side classifier on transcripts.
 */
export async function trackSchedulingClassification(
  eventType: string,
  summary: { classified: number; directivesWritten: number },
): Promise<void> {
  if (summary.classified === 0 && summary.directivesWritten === 0) return;
  const redis = getRedis();
  const today = new Date().toISOString().split('T')[0];

  const writes: Promise<unknown>[] = [];
  if (summary.classified > 0) {
    writes.push(redis.incrby(keys.schedulingClassifierCount(eventType, today), summary.classified));
    writes.push(redis.expire(keys.schedulingClassifierCount(eventType, today), 30 * 86_400));
  }
  if (summary.directivesWritten > 0) {
    writes.push(redis.incrby(keys.schedulingDirectivesFromQuo(eventType, today), summary.directivesWritten));
    writes.push(redis.expire(keys.schedulingDirectivesFromQuo(eventType, today), 30 * 86_400));
  }
  await Promise.all(writes);
}
