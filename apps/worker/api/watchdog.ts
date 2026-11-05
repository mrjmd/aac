/**
 * Outside-in pipe watchdog (route: /api/watchdog, Vercel cron every 5 min).
 * Texts Matt only when a business pipe is down, again every 6h while it
 * stays down, and once on recovery (@aac/watchdog). Runs here, not in the
 * middleware, so a dead middleware can't silence it.
 */
import { createLogger } from '@aac/shared-utils/logger';
import { runWatchdogTick } from '@aac/watchdog';
import { getWatchdogDeps } from '../lib/watchdog-deps.js';
import { isCronRequest, json } from '../lib/auth.js';

const log = createLogger('worker-watchdog');

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request)) return json({ error: 'unauthorized' }, 401);
  try {
    const result = await runWatchdogTick(getWatchdogDeps());
    if (result.down.length || result.recovered.length) log.warn('watchdog', { ...result });
    return json({ status: 'ok', ...result });
  } catch (err) {
    log.error('watchdog tick failed', err as Error);
    return json({ status: 'error', message: (err as Error).message }, 500);
  }
}
