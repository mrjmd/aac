/**
 * Agent comms inbound handler — pure logic, no HTTP.
 *
 * Takes a normalized inbound event + injected deps and:
 *   1. Filters out events we don't process here (call.*, delivery acks)
 *   2. Confirms the message went TO the agent comms line
 *   3. Looks up sender role; unknown senders get audit + silent drop
 *   4. Routes through the intent router (Walk-1 stub)
 *   5. Sends ack reply via Quo when the router says so
 *   6. Writes an audit entry for every path
 *
 * The HTTP wrapper (`api/webhooks/quo.ts`) is responsible for parsing
 * the raw Quo payload into a `ParsedInboundEvent`, plus signature
 * verification and dedup. Keeping those out of here lets us test the
 * routing logic without faking `Request`/`Response`.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { normalizePhone } from '@aac/shared-utils/phone';
import { lookupRole, type AgentRole } from './roles.js';
import { routeIntent } from './intent-router.js';
import type { AgentAuditDecision, AgentAuditEntry } from './redis.js';

const log = createLogger('agent:inbound');

export interface ParsedInboundEvent {
  /** Quo event ID (top-level `object.id`) */
  eventId: string;
  /** Quo event type (e.g. `message.received`) */
  type: string;
  /** Quo recipient phone (E.164) — ours if inbound */
  to: string | undefined;
  /** Sender phone (E.164) — theirs if inbound */
  from: string | undefined;
  /** Message body (empty string when missing) */
  body: string;
  /** Quo message ID (`data.object.id`) */
  messageId: string;
  /** Quo conversation ID, when present */
  conversationId?: string;
}

export interface InboundDeps {
  /** Quo client (sendMessage only — keeps test mocks tiny) */
  quo: {
    sendMessage(to: string, text: string, from?: string): Promise<{ id: string }>;
  };
  /** Audit log writer (injected so tests can assert without mocking Redis) */
  audit: (entry: AgentAuditEntry) => Promise<void>;
  /** Agent comms line in E.164 — used both as filter and as sender */
  agentPhoneNumber: string;
  /** Caller phone → role map (current scale: env-driven JSON) */
  roleMap: Record<string, AgentRole>;
  /** Test seam for deterministic timestamps */
  now?: () => Date;
}

export type InboundResult = {
  decision: AgentAuditDecision;
  /** Reply text actually sent, when decision is `ack` */
  replyText?: string;
};

/** Events the agent inbound handler is interested in. Everything else is
 *  filtered + audited as `unsupported_event`. */
const SUPPORTED_EVENT_TYPES = new Set(['message.received']);

export async function handleInboundAgentMessage(
  event: ParsedInboundEvent,
  deps: InboundDeps,
): Promise<InboundResult> {
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const senderE164 = event.from ? normalizePhone(event.from) ?? event.from : 'unknown';
  const recipientE164 = event.to ? normalizePhone(event.to) ?? event.to : undefined;

  // ── 1. Filter unsupported event types ──────────────────────────────
  if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
    log.debug('Dropping unsupported event type on agent line', {
      type: event.type,
      eventId: event.eventId,
    });
    await deps.audit({
      timestamp,
      caller: senderE164,
      role: 'unknown',
      inboundText: event.body,
      decision: 'unsupported_event',
      eventId: event.eventId,
    });
    return { decision: 'unsupported_event' };
  }

  // ── 2. Confirm the message landed on the agent comms line ──────────
  if (recipientE164 !== deps.agentPhoneNumber) {
    log.warn('Inbound event on agent webhook routed to non-agent line', {
      to: recipientE164,
      expected: deps.agentPhoneNumber,
      eventId: event.eventId,
    });
    await deps.audit({
      timestamp,
      caller: senderE164,
      role: 'unknown',
      inboundText: event.body,
      decision: 'wrong_line',
      eventId: event.eventId,
    });
    return { decision: 'wrong_line' };
  }

  // ── 3. Identity check ──────────────────────────────────────────────
  if (senderE164 === 'unknown') {
    await deps.audit({
      timestamp,
      caller: 'unknown',
      role: 'unknown',
      inboundText: event.body,
      decision: 'unknown_caller',
      eventId: event.eventId,
    });
    return { decision: 'unknown_caller' };
  }

  const role = lookupRole(senderE164, deps.roleMap);
  if (role === null) {
    log.info('Inbound text from caller not in role map; dropping silently', {
      caller: senderE164,
      eventId: event.eventId,
    });
    await deps.audit({
      timestamp,
      caller: senderE164,
      role: 'unknown',
      inboundText: event.body,
      decision: 'unknown_caller',
      eventId: event.eventId,
    });
    return { decision: 'unknown_caller' };
  }

  // ── 4. Route through the intent router ────────────────────────────
  const decision = routeIntent({
    callerPhoneE164: senderE164,
    role,
    messageBody: event.body,
    messageId: event.messageId,
    conversationId: event.conversationId,
  });

  if (decision.type === 'ignore') {
    log.info('Intent router ignored inbound text', {
      caller: senderE164,
      role,
      reason: decision.reason,
      eventId: event.eventId,
    });
    await deps.audit({
      timestamp,
      caller: senderE164,
      role,
      inboundText: event.body,
      decision: 'ignore',
      eventId: event.eventId,
    });
    return { decision: 'ignore' };
  }

  // ── 5. Send reply ──────────────────────────────────────────────────
  try {
    await deps.quo.sendMessage(senderE164, decision.replyText, deps.agentPhoneNumber);
    log.info('Sent ack reply', {
      caller: senderE164,
      role,
      eventId: event.eventId,
    });
  } catch (err) {
    log.error('Failed to send agent reply', err as Error, {
      caller: senderE164,
      role,
      eventId: event.eventId,
    });
    // Still audit-log the attempt so Matt can see the failure context.
    await deps.audit({
      timestamp,
      caller: senderE164,
      role,
      inboundText: event.body,
      decision: 'ack',
      replyText: `[send failed: ${(err as Error).message}] ${decision.replyText}`,
      eventId: event.eventId,
    });
    throw err;
  }

  await deps.audit({
    timestamp,
    caller: senderE164,
    role,
    inboundText: event.body,
    decision: 'ack',
    replyText: decision.replyText,
    eventId: event.eventId,
  });

  return { decision: 'ack', replyText: decision.replyText };
}
