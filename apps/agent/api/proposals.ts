/**
 * Scheduling proposal intake — middleware → agent.
 *
 * Walk #6.1. Middleware POSTs a SchedulingDirective + suggested slot +
 * draft event description here; we stash it, set the owner's
 * active-proposal pointer, and text Matt from the agent line. Matt's
 * reply lands on the existing /api/webhooks/quo handler, which (Walk
 * #6.2) routes it through `lib/proposal-reply.ts`.
 *
 * Auth: shared secret in `x-scheduling-proposal-secret` header.
 *
 * Idempotency: writeProposal sets the key NX. If middleware retries the
 * same proposalId, we return 200 with `{ status: 'idempotent' }` rather
 * than re-texting Matt.
 *
 * SACROSANCT mirror policy: business logic stays in lib/; this file owns
 * HTTP transport + auth only.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { ProposalPayload, StoredProposal } from '@aac/scheduling';
import { getEnv } from '../lib/env.js';
import { getQuo } from '../lib/clients.js';
import {
  appendAgentAuditEntry,
  writeProposal,
} from '../lib/redis.js';
import { sendProposalSms } from '../lib/proposals.js';

const log = createLogger('agent:proposals-endpoint');

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validatePayload(raw: unknown): ProposalPayload | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be an object' };
  const p = raw as Record<string, unknown>;
  const directive = p.directive as Record<string, unknown> | undefined;
  const slot = p.slot as Record<string, unknown> | undefined;
  if (typeof p.proposalId !== 'string' || !p.proposalId) return { error: 'proposalId required' };
  if (!directive || typeof directive !== 'object') return { error: 'directive required' };
  if (typeof directive.id !== 'string') return { error: 'directive.id required' };
  if (typeof directive.customerName !== 'string') return { error: 'directive.customerName required' };
  if (typeof directive.customerPhone !== 'string') return { error: 'directive.customerPhone required' };
  if (!slot || typeof slot !== 'object') return { error: 'slot required' };
  if (typeof slot.startIso !== 'string') return { error: 'slot.startIso required' };
  if (typeof slot.endIso !== 'string') return { error: 'slot.endIso required' };
  if (typeof p.eventDescription !== 'string') return { error: 'eventDescription required' };
  if (typeof p.createdAt !== 'string') return { error: 'createdAt required' };
  return raw as ProposalPayload;
}

export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  if (!env.scheduling.proposalSecret) {
    log.error('SCHEDULING_PROPOSAL_SECRET not configured', new Error('missing proposal secret'));
    return json({ error: 'Proposal endpoint not configured' }, 503);
  }

  const supplied = request.headers.get('x-scheduling-proposal-secret');
  if (supplied !== env.scheduling.proposalSecret) {
    log.warn('Invalid proposal secret');
    return json({ error: 'Unauthorized' }, 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const validated = validatePayload(raw);
  if ('error' in validated) {
    log.warn('Rejected proposal payload', { error: validated.error });
    return json({ error: validated.error }, 400);
  }
  const payload = validated;

  const ownerPhone = env.notifications.mattPersonalPhone;

  const stored: StoredProposal = {
    ...payload,
    ownerPhoneE164: ownerPhone,
    smsId: null,
  };

  try {
    const isNew = await writeProposal(stored);
    if (!isNew) {
      log.info('Idempotent proposal — same id received again, not re-texting', {
        proposalId: payload.proposalId,
      });
      return json({ status: 'idempotent', proposalId: payload.proposalId });
    }

    const smsId = await sendProposalSms(stored, {
      quo: getQuo(),
      agentPhoneNumber: env.quo.agentPhoneNumber,
      ownerPhoneE164: ownerPhone,
    });
    // smsId is informational only; the reply path looks up by owner
    // phone → active-proposal pointer → stored blob, never by smsId.

    await appendAgentAuditEntry({
      timestamp: new Date().toISOString(),
      caller: ownerPhone,
      role: 'owner',
      inboundText: '',
      decision: 'proposal_received',
      replyText: smsId ? `proposal ${payload.proposalId} → SMS ${smsId}` : `proposal ${payload.proposalId} → SMS send failed`,
      eventId: payload.proposalId,
    });

    return json({
      status: 'sent',
      proposalId: payload.proposalId,
      smsId,
    });
  } catch (err) {
    log.error('Proposal handler failed', err as Error, { proposalId: payload.proposalId });
    return json({ error: 'Processing failed, logged' }, 500);
  }
}
