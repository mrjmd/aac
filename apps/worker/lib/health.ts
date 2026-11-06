/**
 * Worker health bookkeeping, through @aac/shared-utils/health so failures
 * land in `health:errors` next to the middleware's: the command center's
 * health page lists them and the agent's error-surface cron texts them.
 *
 * Sources are `worker:<route>` (e.g. `worker:sweep`). Last-run stamps use
 * the route name as the job (`cron:sweep:last-run`), like the middleware
 * crons; the watchdog reads only the jobs listed in @aac/watchdog.
 *
 * Its own Redis client, built from the Upstash env alone, so a route whose
 * other deps failed to build (missing Quo/QBO env) can still record that.
 * Never throws.
 */
import { Redis } from '@upstash/redis';
import * as health from '@aac/shared-utils/health';
import { createLogger } from '@aac/shared-utils/logger';
import { keys } from '@aac/shared-utils/redis';

const log = createLogger('worker-health');

/**
 * One `health:errors` entry per source per window. Several routes run every
 * minute; a lasting outage would otherwise push one entry a minute and
 * evict everything else from the 100-entry list. The function log still
 * gets every failure.
 */
export const FAILURE_THROTTLE_SEC = 600;

let client: Redis | null | undefined;

function healthRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

/** Record a route failure in `health:errors` as source `worker:<route>` (throttled per route). */
export async function recordFailure(route: string, message: string, details?: Record<string, unknown>): Promise<void> {
  const source = `worker:${route}`;
  const redis = healthRedis();
  if (!redis) {
    log.error('health error not recorded: Upstash env not set', undefined, { source, healthMessage: message });
    return;
  }
  try {
    const first = await redis.set(keys.healthErrorThrottle(source), new Date().toISOString(), {
      nx: true,
      ex: FAILURE_THROTTLE_SEC,
    });
    if (first !== 'OK') {
      log.warn('health error throttled (already recorded this window)', { source, healthMessage: message });
      return;
    }
  } catch {
    // Redis is likely down; logHealthError below logs the failure itself.
  }
  await health.logHealthError(redis, source, message.slice(0, 500), details);
}

/** Stamp `cron:<route>:last-run` and today's result counts. */
export async function recordRun(route: string, result: health.CronRunResult): Promise<void> {
  const redis = healthRedis();
  if (!redis) return;
  await health.trackCronRun(redis, route, result);
}

/**
 * Run a route body; a throw it doesn't catch itself (deps that failed to
 * build, a Redis read before its try) is recorded and answered 500 JSON
 * instead of escaping as an unrecorded Vercel 500.
 */
export async function guarded(route: string, handle: () => Promise<Response>): Promise<Response> {
  try {
    return await handle();
  } catch (err) {
    const message = (err as Error).message;
    log.error(`${route} failed before its own error handling`, err as Error);
    await recordFailure(route, `${route} failed: ${message}`);
    return new Response(JSON.stringify({ status: 'error', message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
