/**
 * Cron job utilities for apps/agent — auth verification only at start.
 *
 * Mirrors apps/middleware/lib/cron.ts. Kept as a separate file (rather
 * than copy-pasting verifyCronAuth into each cron) because there will be
 * more crons here as Walk-phase automations ship.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from './env.js';

const log = createLogger('agent:cron');

/**
 * Verify that a request came from Vercel Cron (or an authorized caller).
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`. Returns true if
 * authorized, false (and sends 401/500) if not.
 */
export function verifyCronAuth(req: VercelRequest, res: VercelResponse): boolean {
  const env = getEnv();

  if (!env.cron.secret) {
    if (env.nodeEnv === 'development') {
      log.debug('Cron auth skipped (development, no CRON_SECRET)');
      return true;
    }
    log.error('CRON_SECRET not configured in production');
    res.status(500).json({ error: 'Cron not configured' });
    return false;
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${env.cron.secret}`) {
    log.warn('Cron auth failed — invalid or missing Authorization header');
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}
