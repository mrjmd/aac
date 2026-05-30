/**
 * Proposal reply handling — Walk #6.2.
 *
 * Called by the inbound handler when a reply from the owner arrives on
 * the agent line and there's an active scheduling proposal in flight.
 *
 *   - Classify Matt's reply: approve / reject / edit
 *   - POST decision callback to middleware
 *   - Send Matt a short ack SMS
 *   - Clear the active-proposal pointer (proposal itself stays in Redis
 *     for the remaining TTL so we can debug)
 *
 * The classifier is keyword-based for v0. "yes" / "y" / "ok" / "approve"
 * etc. → approved; "no" / "n" / "skip" / "cancel" → rejected; everything
 * else → edit. Walk #7 will iterate on edit parsing.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type {
  ProposalDecision,
  ProposalDecisionPayload,
  StoredProposal,
} from '@aac/scheduling';

const log = createLogger('agent:proposal-reply');

const APPROVE_TOKENS = new Set([
  'y', 'ya', 'ye', 'yes', 'yep', 'yeah', 'yup', 'ok', 'okay', 'k',
  'go', 'send', 'sure', 'confirm', 'confirmed', 'approve', 'approved',
  'do it', 'do-it', 'doit', 'book', 'book it', 'book-it', 'schedule it',
  'looks good', 'sounds good', 'lgtm',
]);

const REJECT_TOKENS = new Set([
  'n', 'no', 'nope', 'nah', 'skip', 'cancel', 'reject', 'rejected',
  'dont', "don't", 'no thanks', 'no thank you', 'pass', 'kill',
]);

export function classifyProposalReply(text: string): ProposalDecision {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!normalized) return 'edit';
  if (APPROVE_TOKENS.has(normalized)) return 'approved';
  if (REJECT_TOKENS.has(normalized)) return 'rejected';
  return 'edit';
}

export interface ProposalReplyDeps {
  quo: {
    sendMessage(to: string, text: string, from?: string): Promise<{ id: string }>;
  };
  clearActiveProposalForOwner(ownerPhoneE164: string): Promise<void>;
  /**
   * Calls middleware's /api/scheduling/proposal-decision endpoint with
   * the shared secret. Returns whether the callback succeeded; failure
   * is non-fatal (we still ack Matt) but is logged + audited.
   */
  postDecisionCallback(payload: ProposalDecisionPayload): Promise<boolean>;
  agentPhoneNumber: string;
  now?: () => Date;
}

export interface ProposalReplyResult {
  decision: ProposalDecision;
  callbackOk: boolean;
  replyText: string;
}

export async function handleProposalReply(
  proposal: StoredProposal,
  inboundBody: string,
  deps: ProposalReplyDeps,
): Promise<ProposalReplyResult> {
  const decision = classifyProposalReply(inboundBody);
  const decidedAt = (deps.now ?? (() => new Date()))().toISOString();

  const callbackOk = await deps.postDecisionCallback({
    proposalId: proposal.proposalId,
    directiveId: proposal.directive.id,
    decision,
    replyText: inboundBody,
    decidedAt,
  });

  if (!callbackOk) {
    log.error('Middleware callback failed; will still ack Matt', new Error('callback failed'), {
      proposalId: proposal.proposalId,
      decision,
    });
  }

  const ackText = buildAckText(decision, proposal, callbackOk, inboundBody);
  try {
    await deps.quo.sendMessage(
      proposal.ownerPhoneE164,
      ackText,
      deps.agentPhoneNumber,
    );
  } catch (err) {
    log.error('Failed to send proposal ack', err as Error, {
      proposalId: proposal.proposalId,
    });
    // Continue — we still clear the pointer below so a stuck SMS send
    // doesn't trap Matt's next reply against a stale proposal.
  }

  await deps.clearActiveProposalForOwner(proposal.ownerPhoneE164);

  return { decision, callbackOk, replyText: ackText };
}

function buildAckText(
  decision: ProposalDecision,
  proposal: StoredProposal,
  callbackOk: boolean,
  inboundBody: string,
): string {
  const tail = callbackOk
    ? ''
    : '\n\n(heads up: command-center callback failed — I have your decision but Matt couldn\'t hand it off to middleware automatically. Will retry; check command-center.)';

  switch (decision) {
    case 'approved':
      return `Got it — recorded as approved for ${proposal.directive.customerName}. Walk #7 will turn this into a calendar event once it ships.${tail}`;
    case 'rejected':
      return `Got it — won't schedule ${proposal.directive.customerName}. Directive marked rejected.${tail}`;
    case 'edit': {
      const snippet = inboundBody.trim().length > 120
        ? inboundBody.trim().slice(0, 117) + '...'
        : inboundBody.trim();
      return `Got it — recorded your edit: "${snippet}". No calendar action; Walk #7 will route this back for a new slot.${tail}`;
    }
    default:
      return `Got it — recorded reply for ${proposal.directive.customerName}.${tail}`;
  }
}
