/**
 * Health Endpoint
 *
 * Returns operational metrics for the middleware: webhook processing counts,
 * cross-system sync mappings, and health-error COUNTS. Unauthenticated, so
 * it never returns error details (PD ids, estimate ids, QBO fault text):
 * the command center reads those from Redis behind its session. Readers:
 * the watchdog (status === 'healthy') and uptime checks.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { keys } from '@aac/shared-utils/redis';
import { writeHeartbeat } from '@aac/shared-utils/health';
import { getRedis } from '../lib/redis.js';

const log = createLogger('health');

const CODE_VERSION = 'v2026-03-31-monorepo';

interface HealthMetrics {
  webhooks: {
    pipedrive: { processed24h: number; lastProcessed: string | null };
    quo: { processed24h: number; lastProcessed: string | null };
    googleAds: { processed24h: number; lastProcessed: string | null };
    qb: { processed24h: number; lastProcessed: string | null };
  };
  sync: {
    pdToQuo: number;
    pdToQb: number;
    phoneToPd: number;
  };
  /**
   * Quo scheduling-intent classifier volume by event type, last 48h. Used
   * to validate the "transcripts are sparse" assumption before deciding
   * whether to drop the matt-side classifier on transcripts.
   */
  schedulingClassifier: {
    byEventType: Record<string, { classified: number; directivesWritten: number }>;
  };
  /** How many entries `health:errors` holds (of the last 50 read), and how many are under an hour old. No details. */
  errorCounts: { recent: number; lastHour: number };
}

async function getSchedulingClassifierMetrics(): Promise<
  Record<string, { classified: number; directivesWritten: number }>
> {
  const redis = getRedis();
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];

  const eventTypes = ['message.received', 'message.delivered', 'call.transcript.completed'];

  const result: Record<string, { classified: number; directivesWritten: number }> = {};
  await Promise.all(
    eventTypes.flatMap((et) =>
      [today, yesterday].map(async (day) => {
        const [classified, directives] = await Promise.all([
          redis.get<number>(keys.schedulingClassifierCount(et, day)),
          redis.get<number>(keys.schedulingDirectivesFromQuo(et, day)),
        ]);
        const prev = result[et] ?? { classified: 0, directivesWritten: 0 };
        result[et] = {
          classified: prev.classified + (classified || 0),
          directivesWritten: prev.directivesWritten + (directives || 0),
        };
      }),
    ),
  );

  return result;
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
    const [
      pipedriveMetrics,
      quoMetrics,
      googleAdsMetrics,
      qbMetrics,
      rawErrors,
      pdToQuoCount,
      pdToQbCount,
      phoneToPdCount,
      schedulingClassifierByType,
    ] = await Promise.all([
      getWebhookMetrics('pipedrive'),
      getWebhookMetrics('quo'),
      getWebhookMetrics('google-ads'),
      getWebhookMetrics('qb'),
      redis.lrange(keys.healthErrors, 0, 49),
      countKeysWithPrefix('map:pd-to-quo:'),
      countKeysWithPrefix('map:pd-to-qb:'),
      countKeysWithPrefix('phone:pd:'),
      getSchedulingClassifierMetrics(),
    ]);

    // Counts only: timestamps are read to age the entries, nothing else leaves.
    const hourAgo = Date.now() - 3_600_000;
    const timestamps = rawErrors.map((entry) => {
      try {
        const parsed = (typeof entry === 'string' ? JSON.parse(entry) : entry) as { timestamp?: string };
        return parsed?.timestamp ? Date.parse(parsed.timestamp) : NaN;
      } catch {
        return NaN;
      }
    });
    const errorCounts = {
      recent: rawErrors.length,
      lastHour: timestamps.filter((t) => Number.isFinite(t) && t > hourAgo).length,
    };

    const metrics: HealthMetrics = {
      webhooks: {
        pipedrive: pipedriveMetrics,
        quo: quoMetrics,
        googleAds: googleAdsMetrics,
        qb: qbMetrics,
      },
      sync: {
        pdToQuo: pdToQuoCount,
        pdToQb: pdToQbCount,
        phoneToPd: phoneToPdCount,
      },
      schedulingClassifier: {
        byEventType: schedulingClassifierByType,
      },
      errorCounts,
    };

    // Write heartbeat
    await writeHeartbeat(redis, 'middleware');

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
