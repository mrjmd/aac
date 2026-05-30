/**
 * Admin send-proposal trigger — Walk #6.3.
 *
 * Pull-triggered (CRON_SECRET-authed) endpoint that takes a directive id,
 * orchestrates the full proposal assembly (PD person, QB line items,
 * Quo conversation, calendar slot, LLM event description) and POSTs to
 * apps/agent /api/proposals so Matt gets the SMS.
 *
 * Use case: smoke-testing the propose-dialogue loop end-to-end before
 * Walk #7 wires confidence-gated auto-fire from dispatch.
 *
 * Request: POST { directiveId: string } (also accepts ?directiveId=)
 *   Auth: Authorization: Bearer <CRON_SECRET>
 *
 * Response: { ok, proposalId?, smsId?, suggestedSlotFound, description... }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from '../../lib/env.js';
import { verifyCronAuth } from '../../lib/cron.js';
import {
  getPipedrive,
  getQuickBooks,
  getQuo,
  getGemini,
  getCalendar,
  getMaps,
} from '../../lib/clients.js';
import { buildProposalForDirective } from '../../lib/proposal-builder.js';
import { postProposalToAgent } from '../../lib/agent-proposal-post.js';
import { getRedis, logHealthError } from '../../lib/redis.js';

const log = createLogger('send-proposal');

function extractDirectiveId(req: VercelRequest): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.directiveId === 'string') return body.directiveId;
  const qs = req.query.directiveId;
  if (typeof qs === 'string') return qs;
  if (Array.isArray(qs) && qs[0]) return qs[0];
  return null;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!verifyCronAuth(req, res)) return;

  const env = getEnv();
  if (!env.scheduling.agentBaseUrl || !env.scheduling.proposalSecret) {
    res.status(503).json({
      error: 'Proposal trigger not configured (need AGENT_BASE_URL and SCHEDULING_PROPOSAL_SECRET)',
    });
    return;
  }

  const directiveId = extractDirectiveId(req);
  if (!directiveId) {
    res.status(400).json({ error: 'directiveId required (body.directiveId or ?directiveId=)' });
    return;
  }

  try {
    const built = await buildProposalForDirective(
      {
        pd: getPipedrive(),
        qb: getQuickBooks(),
        quo: getQuo(),
        calendar: getCalendar(),
        gemini: getGemini(),
        maps: getMaps(),
        redis: getRedis(),
        technicianEmails: env.google.technicianEmails,
      },
      directiveId,
    );

    if (!built) {
      res.status(404).json({ error: 'Directive not found', directiveId });
      return;
    }

    const post = await postProposalToAgent(built.payload, {
      agentBaseUrl: env.scheduling.agentBaseUrl,
      proposalSecret: env.scheduling.proposalSecret,
    });

    if (!post.ok) {
      await logHealthError(
        'send-proposal',
        `Agent post failed (status ${post.status})`,
        { directiveId, proposalId: built.payload.proposalId },
      );
    }

    res.status(post.ok ? 200 : 502).json({
      ok: post.ok,
      directiveId,
      proposalId: built.payload.proposalId,
      smsId: post.smsId,
      suggestedSlotFound: built.suggestedSlotFound,
      descriptionUsedFallback: built.descriptionUsedFallback,
      agentStatus: post.status,
    });
  } catch (err) {
    log.error('send-proposal failed', err as Error, { directiveId });
    await logHealthError(
      'send-proposal',
      `send-proposal threw: ${(err as Error).message}`,
      { directiveId },
    );
    res.status(500).json({ error: 'send-proposal failed', message: (err as Error).message });
  }
}
