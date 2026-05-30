/**
 * Proposal contract — shared types between middleware (sender) and agent
 * (receiver / replier). These describe the payload of a scheduling
 * proposal that flows:
 *
 *   middleware  → POST /api/proposals       → agent      (ProposalPayload)
 *   matt        → SMS reply                 → agent
 *   agent       → POST /api/scheduling/proposal-decision → middleware
 *               (ProposalDecisionPayload)
 *
 * Owned here because it's a scheduling-domain artifact; both apps import
 * the same definition so the contract can't drift.
 */

import type { SuggestSlotResult } from './suggest-slot.js';
import type { SchedulingDirective } from './types.js';

/**
 * Slim subset of a SchedulingDirective that the agent needs to draft the
 * SMS. We don't send the full directive (PII reduction + payload size) —
 * just enough for the SMS body. The full directive is looked up by id on
 * the middleware side when the decision callback arrives.
 */
export interface ProposalDirectiveSnapshot {
  id: string;
  intent: SchedulingDirective['intent'];
  eventClass: SchedulingDirective['eventClass'];
  customerName: string;
  customerPhone: string;
  scopeSummary: string;
}

export interface ProposalSlot {
  startIso: string;
  endIso: string;
  reasoning: string;
}

export interface ProposalPayload {
  proposalId: string;
  directive: ProposalDirectiveSnapshot;
  slot: ProposalSlot;
  /** Draft calendar event body produced by `buildEventDescription`. */
  eventDescription: string;
  /**
   * `usedFallback` from buildEventDescription. When true, the agent
   * appends a "(template fallback)" tag to the SMS so Matt knows the
   * Gemini path didn't produce a clean description.
   */
  descriptionUsedFallback: boolean;
  createdAt: string;
}

/**
 * Stored alongside the payload on the agent side so we can route Matt's
 * reply back to middleware.
 */
export interface StoredProposal extends ProposalPayload {
  ownerPhoneE164: string;
  smsId: string | null;
}

export type ProposalDecision = 'approved' | 'rejected' | 'edit';

export interface ProposalDecisionPayload {
  proposalId: string;
  directiveId: string;
  decision: ProposalDecision;
  /**
   * Matt's verbatim reply text. For edits, this is the whole reply so the
   * middleware-side reviewer (command-center, future executeDirective)
   * can decide what to do with it.
   */
  replyText: string;
  decidedAt: string;
}

/**
 * Convenience builder used by the suggestSlot caller — converts a
 * SuggestSlotResult into the wire-shape we send. Returns null if the
 * search couldn't find a slot.
 */
export function toProposalSlot(result: SuggestSlotResult): ProposalSlot | null {
  if (!result.slot) return null;
  return {
    startIso: result.slot.startIso,
    endIso: result.slot.endIso,
    reasoning: result.reasoning,
  };
}
