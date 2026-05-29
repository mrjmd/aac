/**
 * Intent router — entry point for inbound texts on the agent comms line.
 *
 * Walk step 1 ships this as a STUB. The interface is locked here so the
 * webhook handler, audit log, and tests don't have to change when real
 * intent classification (Walk step 3) lands behind the same function
 * signature.
 *
 * Stub behavior:
 *   - `owner`: ack with "received, classification not yet live"
 *   - other roles: ignore (no reply, no action)
 *
 * The handler is responsible for the unknown-caller case (no role) — by
 * the time we call this function the caller's identity has been resolved.
 */

import type { AgentRole } from './roles.js';

export interface IntentRouterInput {
  callerPhoneE164: string;
  role: AgentRole;
  messageBody: string;
  /** Quo message ID — surfaced in audit log + future reply-chain plumbing */
  messageId: string;
  /** Quo conversation ID, when present */
  conversationId?: string;
}

export type IntentDecision =
  | { type: 'ack'; replyText: string }
  | { type: 'ignore'; reason: string };

const MAX_ECHO_CHARS = 80;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3).trimEnd() + '...';
}

export function routeIntent(input: IntentRouterInput): IntentDecision {
  if (input.role === 'owner') {
    const echo = truncate(input.messageBody.trim(), MAX_ECHO_CHARS);
    return {
      type: 'ack',
      replyText: `Got it: "${echo}". Intent classification isn't live yet — for now I just confirm receipt.`,
    };
  }

  return { type: 'ignore', reason: `role-${input.role}-not-yet-handled` };
}
