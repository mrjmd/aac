/**
 * Cron job utilities — auth verification and shared helpers.
 *
 * Vercel Cron jobs call endpoints with an Authorization header containing
 * the CRON_SECRET. We verify this to prevent public access.
 *
 * See: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from './env.js';

const log = createLogger('cron');

/**
 * Verify that a request came from Vercel Cron (or an authorized caller).
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron invocations.
 * Returns true if authorized, false (and sends 401) if not.
 */
export function verifyCronAuth(req: VercelRequest, res: VercelResponse): boolean {
  const env = getEnv();

  // In development, skip auth if no secret configured
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
