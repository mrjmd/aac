/**
 * Error-surface Cron — periodic job that reads new entries from middleware's
 * `health:errors` list and texts Matt raw failure context from the agent
 * comms line.
 *
 * Crawl version: no diagnosis. Just better routing than waiting for Matt to
 * check /api/health. The diagnostic-agent LLM layer comes in Walk.
 *
 * Schedule (vercel.json): every 10 minutes. Cursor stored in Redis at
 * `agent:cron:error-surface:cursor`.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { verifyCronAuth } from '../../lib/cron.js';
import { getEnv } from '../../lib/env.js';
import { getQuo } from '../../lib/clients.js';
import { runErrorSurfaceTick } from '../../lib/error-surface.js';

const log = createLogger('agent:cron:error-surface');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCronAuth(req, res)) return;

  try {
    const env = getEnv();
    const result = await runErrorSurfaceTick({
      quo: getQuo(),
      recipient: env.notifications.mattPersonalPhone,
      sender: env.quo.agentPhoneNumber,
    });
    log.info('error-surface tick complete', { ...result });
    return res.status(200).json(result);
  } catch (error) {
    log.error('error-surface tick failed', error as Error);
    return res.status(500).json({ error: (error as Error).message });
  }
}
