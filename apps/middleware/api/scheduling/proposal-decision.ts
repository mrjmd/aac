/**
 * Proposal-decision intake — agent → middleware (Walk #6.3).
 *
 * Receives Matt's verdict on a scheduling proposal after he replies on
 * the agent line:
 *   - approved → record + (Walk #7) eventually hand off to executeDirective
 *   - rejected → record + leave directive in shadow queue as rejected
 *   - edit     → record verbatim text; future Walk routes back for re-propose
 *
 * Walk #6 records the decision in Redis only (no calendar writes, no PD
 * mutations). Command-center reads the recorded decision via
 * `getProposalDecisionForDirective` and renders it on the directive card.
 *
 * Auth: shared `SCHEDULING_PROPOSAL_SECRET` header — same value as the
 * middleware → agent direction.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import type { ProposalDecisionPayload } from '@aac/scheduling';
import { getEnv } from '../../lib/env.js';
import {
  logHealthError,
  recordProposalDecision,
  type RecordedProposalDecision,
} from '../../lib/redis.js';

const log = createLogger('proposal-decision');

function validatePayload(raw: unknown): ProposalDecisionPayload | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be an object' };
  const p = raw as Record<string, unknown>;
  if (typeof p.proposalId !== 'string' || !p.proposalId) return { error: 'proposalId required' };
  if (typeof p.directiveId !== 'string' || !p.directiveId) return { error: 'directiveId required' };
  if (p.decision !== 'approved' && p.decision !== 'rejected' && p.decision !== 'edit') {
    return { error: 'decision must be approved/rejected/edit' };
  }
  if (typeof p.replyText !== 'string') return { error: 'replyText required' };
  if (typeof p.decidedAt !== 'string') return { error: 'decidedAt required' };
  return raw as ProposalDecisionPayload;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const env = getEnv();

  if (!env.scheduling.proposalSecret) {
    log.error('SCHEDULING_PROPOSAL_SECRET not configured', new Error('missing'));
    res.status(503).json({ error: 'Proposal endpoint not configured' });
    return;
  }

  const supplied = req.headers['x-scheduling-proposal-secret'];
  const suppliedValue = Array.isArray(supplied) ? supplied[0] : supplied;
  if (suppliedValue !== env.scheduling.proposalSecret) {
    log.warn('Invalid proposal secret on decision callback');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const validated = validatePayload(req.body);
  if ('error' in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const payload = validated;

  try {
    const recorded: RecordedProposalDecision = {
      proposalId: payload.proposalId,
      directiveId: payload.directiveId,
      decision: payload.decision,
      replyText: payload.replyText,
      decidedAt: payload.decidedAt,
      recordedAt: new Date().toISOString(),
    };
    await recordProposalDecision(recorded);

    log.info('Recorded proposal decision', {
      proposalId: payload.proposalId,
      directiveId: payload.directiveId,
      decision: payload.decision,
    });

    res.status(200).json({ status: 'recorded', proposalId: payload.proposalId });
  } catch (err) {
    log.error('Failed to record proposal decision', err as Error, {
      proposalId: payload.proposalId,
    });
    await logHealthError(
      'proposal-decision',
      `Failed to record proposal decision: ${(err as Error).message}`,
      { proposalId: payload.proposalId, directiveId: payload.directiveId },
    );
    res.status(500).json({ error: 'Recording failed' });
  }
}
