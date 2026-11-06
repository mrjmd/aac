/**
 * QuickBooks OAuth Connection Initiation
 *
 * Owner-only: requires CRON_SECRET, as `Authorization: Bearer <secret>` or,
 * since this is opened in a browser, `?key=<secret>`:
 *   https://aac-middleware-monorepo.vercel.app/api/auth/quickbooks/connect?key=<CRON_SECRET>
 *
 * Issues a one-time random OAuth state (Redis, 10-minute TTL) and redirects
 * to QuickBooks; /callback consumes the state before saving any tokens.
 */

import crypto from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { keys, ttl } from '@aac/shared-utils/redis';
import { createLogger } from '@aac/shared-utils/logger';
import { hasBearerSecret } from '@aac/shared-utils/request-secret';
import { timingSafeEqualString } from '@aac/shared-utils/webhook-signature';
import { getEnv } from '../../../lib/env.js';
import { getRedis } from '../../../lib/redis.js';

const log = createLogger('quickbooks-oauth-connect');

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const env = getEnv();

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (!env.cron.secret) {
    log.error('CRON_SECRET not configured; refusing QuickBooks connect');
    res.status(503).send('<h1>QuickBooks connect is not configured</h1>');
    return;
  }

  const key = typeof req.query.key === 'string' ? req.query.key : undefined;
  if (!hasBearerSecret(req.headers.authorization, env.cron.secret) && !timingSafeEqualString(key, env.cron.secret)) {
    log.warn('QuickBooks connect: missing or invalid key');
    res.status(401).send('<h1>Unauthorized</h1>');
    return;
  }

  const state = crypto.randomBytes(32).toString('hex');
  await getRedis().set(keys.qbOAuthState(state), '1', { ex: ttl.qbOAuthState });

  // QuickBooks OAuth authorization URL
  const authUrl = new URL('https://appcenter.intuit.com/connect/oauth2');

  authUrl.searchParams.set('client_id', env.quickbooks.clientId);
  authUrl.searchParams.set('redirect_uri', env.quickbooks.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
  authUrl.searchParams.set('state', state);

  // Redirect to QuickBooks authorization page
  res.redirect(302, authUrl.toString());
}
