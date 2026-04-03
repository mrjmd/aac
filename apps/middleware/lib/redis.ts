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
  source: 'pipedrive' | 'quo' | 'google-ads',
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
  source: 'pipedrive' | 'quo' | 'google-ads',
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
  source: 'pipedrive' | 'quo' | 'google-ads'
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
