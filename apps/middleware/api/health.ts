/**
 * Health Endpoint
 *
 * Returns operational metrics for the middleware: webhook processing counts,
 * cross-system sync mappings, and recent errors. Consumed by the Command
 * Center dashboard.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { keys } from '@aac/shared-utils/redis';
import { getRedis } from '../lib/redis.js';

const log = createLogger('health');

const CODE_VERSION = 'v2026-03-31-monorepo';

interface HealthMetrics {
  webhooks: {
    pipedrive: { processed24h: number; lastProcessed: string | null };
    quo: { processed24h: number; lastProcessed: string | null };
    googleAds: { processed24h: number; lastProcessed: string | null };
  };
  sync: {
    pdToQuo: number;
    pdToQb: number;
    phoneToPd: number;
  };
  errors: Array<{
    timestamp: string;
    source: string;
    message: string;
    details?: string;
  }>;
}

/**
 * Get webhook processing metrics for a given source
 */
async function getWebhookMetrics(
  source: string
): Promise<{ processed24h: number; lastProcessed: string | null }> {
  const redis = getRedis();
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];

  const [todayCount, yesterdayCount, lastProcessed] = await Promise.all([
    redis.get<number>(keys.webhookCount(source, today)),
    redis.get<number>(keys.webhookCount(source, yesterday)),
    redis.get<string>(keys.webhookLast(source)),
  ]);

  return {
    processed24h: (todayCount || 0) + (yesterdayCount || 0),
    lastProcessed: lastProcessed || null,
  };
}

/**
 * Count keys matching a prefix pattern using SCAN
 */
async function countKeysWithPrefix(prefix: string): Promise<number> {
  const redis = getRedis();
  let count = 0;
  let cursor = 0;

  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, { match: `${prefix}*`, count: 100 });
    cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : nextCursor;
    count += (foundKeys as string[]).length;
  } while (cursor !== 0);

  return count;
}

/**
 * Main health endpoint handler
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const redis = getRedis();

    // Fetch all metrics in parallel
    const [pipedriveMetrics, quoMetrics, googleAdsMetrics, rawErrors, pdToQuoCount, pdToQbCount, phoneToPdCount] =
      await Promise.all([
        getWebhookMetrics('pipedrive'),
        getWebhookMetrics('quo'),
        getWebhookMetrics('google-ads'),
        redis.lrange(keys.healthErrors, 0, 49),
        countKeysWithPrefix('map:pd-to-quo:'),
        countKeysWithPrefix('map:pd-to-qb:'),
        countKeysWithPrefix('phone:pd:'),
      ]);

    // Parse error entries
    const errors = rawErrors
      .map((entry) => {
        try {
          const parsed =
            typeof entry === 'string' ? JSON.parse(entry) : entry;
          return parsed as {
            timestamp: string;
            source: string;
            message: string;
            details?: string;
          };
        } catch {
          return null;
        }
      })
      .filter(
        (e): e is { timestamp: string; source: string; message: string; details?: string } =>
          e !== null
      );

    const metrics: HealthMetrics = {
      webhooks: {
        pipedrive: pipedriveMetrics,
        quo: quoMetrics,
        googleAds: googleAdsMetrics,
      },
      sync: {
        pdToQuo: pdToQuoCount,
        pdToQb: pdToQbCount,
        phoneToPd: phoneToPdCount,
      },
      errors,
    };

    // Write heartbeat
    await redis.set(keys.heartbeat('middleware'), new Date().toISOString());

    return res.status(200).json({
      status: 'healthy',
      version: CODE_VERSION,
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (error) {
    log.error('Health check failed', error as Error);

    return res.status(500).json({
      status: 'error',
      version: CODE_VERSION,
      timestamp: new Date().toISOString(),
      error: (error as Error).message,
    });
  }
}
