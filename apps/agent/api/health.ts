/**
 * Agent health endpoint.
 *
 * Writes a heartbeat and returns minimal observability. Command Center
 * reads `health:agent:ts` to know the agent app is up.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { writeHeartbeat } from '../lib/redis.js';
import { getEnv } from '../lib/env.js';

const log = createLogger('agent:health');

const CODE_VERSION = 'v2026-05-28-scaffold';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const env = getEnv();
    await writeHeartbeat();

    return res.status(200).json({
      status: 'healthy',
      app: 'agent',
      version: CODE_VERSION,
      timestamp: new Date().toISOString(),
      env: {
        agentPhoneNumber: env.quo.agentPhoneNumber,
        userRoleCount: Object.keys(env.userRoles).length,
        nodeEnv: env.nodeEnv,
      },
    });
  } catch (error) {
    log.error('Health check failed', error as Error);
    return res.status(500).json({
      status: 'error',
      app: 'agent',
      version: CODE_VERSION,
      timestamp: new Date().toISOString(),
      error: (error as Error).message,
    });
  }
}
