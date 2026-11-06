/**
 * Redis-outage stand-ins for tests that mock ../lib/redis.js: the mocked
 * health functions run the REAL @aac/shared-utils/health code against a
 * client whose every call rejects, so a test exercises the actual
 * never-throw path instead of a hand-rolled resolve.
 */
import * as health from '@aac/shared-utils/health';

const down = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED redis'));

export const deadRedis: health.HealthRedis = { set: down, incr: down, expire: down, lpush: down, ltrim: down };

export const logHealthErrorRedisDown = (source: string, message: string, details?: Record<string, unknown>) =>
  health.logHealthError(deadRedis, source, message, details);

export const trackWebhookProcessedRedisDown = (source: string) => health.trackWebhookProcessed(deadRedis, source);
