/**
 * Per-minute fast-lane drain (route: /api/tick, Vercel cron).
 *
 * Cheap when idle: one LPOP (webhook-fed emailed-estimate queue) + one
 * ZRANGEBYSCORE (intake phones whose 10-min preemption window elapsed).
 * Claims in Redis make overlap with the sweep, the middleware fast lane,
 * and the laptop backstop harmless.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { keys } from '@aac/shared-utils/redis';
import { drainFollowupQueue, drainIntakeDue } from '@aac/message-drafts';
import { getWorkerDeps } from '../lib/deps.js';
import { isCronRequest, isMiddlewareRequest, json } from '../lib/auth.js';

const log = createLogger('worker-tick');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request) && !isMiddlewareRequest(request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const { deps, redis } = getWorkerDeps();
  try {
    const records = [
      ...(await drainFollowupQueue(deps, redis)),
      ...(await drainIntakeDue(deps, redis)),
    ];
    await redis.set(keys.heartbeat('worker'), new Date().toISOString());
    const drafted = records.filter((r) => r.outcome === 'drafted').length;
    if (records.length) log.info('tick drained', { drafted, records: records.length });
    return json({ status: 'ok', drafted, records: records.length });
  } catch (err) {
    log.error('tick failed', err as Error);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
