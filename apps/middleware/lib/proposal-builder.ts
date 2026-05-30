/**
 * Proposal builder — middleware-side orchestration that turns a
 * SchedulingDirective in the shadow queue into a ready-to-send
 * ProposalPayload + posts it to the agent.
 *
 * Walk #6.3 wires this behind the admin `/api/scheduling/send-proposal`
 * trigger so Matt can pull-test the loop. Walk #7 will gate auto-fire
 * by confidence and route from `dispatchSchedulingIntent`.
 *
 * Failure policy: every external read (PD address, QB line items, Quo
 * conversation) is optional. If it errors or returns empty, we log and
 * proceed with what we have. The only blocking failure is "no directive
 * with that id" — that's a 404 to the trigger caller.
 */

import { randomUUID } from 'crypto';
import { createLogger } from '@aac/shared-utils/logger';
import type { GeminiClient } from '@aac/api-clients';
import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoClient } from '@aac/api-clients/quo';
import {
  buildEventDescription,
  suggestSlot,
  type EventDescriptionLineItem,
  type EventDescriptionMessage,
  type ProposalPayload,
  type SchedulingDirective,
} from '@aac/scheduling';
import { getPendingDirective, logHealthError } from './redis.js';

const log = createLogger('proposal-builder');

export interface ProposalBuilderDeps {
  pd: PipedriveClient;
  qb: QuickBooksClient;
  quo: QuoClient;
  calendar: GoogleCalendarClient;
  gemini: GeminiClient;
  newProposalId?: () => string;
  now?: () => Date;
}

export interface ProposalBuilderResult {
  payload: ProposalPayload;
  suggestedSlotFound: boolean;
  descriptionUsedFallback: boolean;
}

const PROPOSAL_PREFIX = 'prop_';
const CONVERSATION_LOOKBACK_MS = 30 * 86_400_000; // 30 days
const CALENDAR_LOOKAHEAD_MS = 21 * 86_400_000;
const CALENDAR_LOOKBACK_BUFFER_MS = 1 * 86_400_000;

export async function buildProposalForDirective(
  deps: ProposalBuilderDeps,
  directiveId: string,
): Promise<ProposalBuilderResult | null> {
  const directive = await getPendingDirective<SchedulingDirective>(directiveId);
  if (!directive) {
    log.warn('Directive not found in shadow queue', { directiveId });
    return null;
  }
  const now = (deps.now ?? (() => new Date()))();

  // ── Customer side: name + address ──────────────────────────────────
  const { customerName, customerAddress } = await fetchCustomer(deps, directive);

  // ── QB line items, if estimate id present ─────────────────────────
  const qbLineItems = directive.qbEstimateId
    ? await fetchLineItems(deps, directive.qbEstimateId)
    : [];

  // ── Quo conversation history ──────────────────────────────────────
  const conversationHistory = await fetchConversation(
    deps,
    directive.customerPhone,
    now,
  );

  // ── Slot suggestion ───────────────────────────────────────────────
  const slotResult = await runSuggestSlot(deps, directive, now);

  // ── Event description ────────────────────────────────────────────
  const description = await buildEventDescription(
    { gemini: deps.gemini, now: () => now },
    {
      directive,
      customer: { name: customerName, address: customerAddress },
      qbLineItems,
      conversationHistory,
      photosUrl: undefined,
      accessNotes: undefined,
    },
  );

  const proposalId = (deps.newProposalId ?? (() => PROPOSAL_PREFIX + randomUUID().replace(/-/g, '').slice(0, 16)))();

  // We always emit a payload — even when no slot found, we send a "no
  // slot found, please advise" surface to Matt. Walk #7 will tighten
  // this; for the admin trigger today it's better than silently no-op.
  const slot = slotResult.slot ?? {
    startIso: '',
    endIso: '',
  };

  const payload: ProposalPayload = {
    proposalId,
    directive: {
      id: directive.id,
      intent: directive.intent,
      eventClass: directive.eventClass,
      customerName,
      customerPhone: directive.customerPhone,
      scopeSummary: directive.scopeSummary,
    },
    slot: {
      startIso: slot.startIso,
      endIso: slot.endIso,
      reasoning: slotResult.reasoning,
    },
    eventDescription: description.description,
    descriptionUsedFallback: description.usedFallback,
    createdAt: now.toISOString(),
  };

  return {
    payload,
    suggestedSlotFound: !!slotResult.slot,
    descriptionUsedFallback: description.usedFallback,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

async function fetchCustomer(
  deps: ProposalBuilderDeps,
  directive: SchedulingDirective,
): Promise<{
  customerName: string;
  customerAddress: string | null;
}> {
  let customerName: string | null = null;
  let customerAddress: string | null = null;

  // Name first: PD person if we have an id, else derive from scope summary.
  if (directive.pdPersonId) {
    try {
      const person = await deps.pd.getPerson(directive.pdPersonId);
      if (person?.name) customerName = person.name;
    } catch (err) {
      await logHealthError(
        'proposal-builder',
        `PD person lookup failed: ${(err as Error).message}`,
        { directiveId: directive.id, pdPersonId: directive.pdPersonId },
      );
    }
  }
  if (!customerName) customerName = fallbackCustomerNameFromScope(directive);

  // Address: QB customer billing address (PD's address is a hashed custom
  // field; QB carries it as structured `BillAddr` which is good enough
  // for the scope-pass quality gate in buildEventDescription).
  if (directive.qbCustomerId) {
    try {
      const customer = await deps.qb.getCustomer(directive.qbCustomerId);
      if (customer?.BillAddr) {
        const parts = [
          customer.BillAddr.Line1,
          customer.BillAddr.City,
          customer.BillAddr.CountrySubDivisionCode,
          customer.BillAddr.PostalCode,
        ].filter((p): p is string => !!p && p.trim().length > 0);
        if (parts.length > 0) customerAddress = parts.join(', ');
      }
    } catch (err) {
      await logHealthError(
        'proposal-builder',
        `QB customer lookup failed: ${(err as Error).message}`,
        { directiveId: directive.id, qbCustomerId: directive.qbCustomerId },
      );
    }
  }

  return { customerName, customerAddress };
}

function fallbackCustomerNameFromScope(directive: SchedulingDirective): string {
  const summary = directive.scopeSummary.trim();
  const dashIdx = summary.indexOf(' — ');
  if (dashIdx > 0) return summary.slice(0, dashIdx).trim();
  return 'Customer';
}

async function fetchLineItems(
  deps: ProposalBuilderDeps,
  qbEstimateId: string,
): Promise<EventDescriptionLineItem[]> {
  try {
    const estimate = await deps.qb.getEstimate(qbEstimateId);
    if (!estimate) return [];
    return estimate.Line
      .map((l) => (l.Description ?? '').trim())
      .filter((d) => d.length > 0)
      .map((description) => ({ description }));
  } catch (err) {
    await logHealthError(
      'proposal-builder',
      `QB estimate fetch failed: ${(err as Error).message}`,
      { qbEstimateId },
    );
    return [];
  }
}

async function fetchConversation(
  deps: ProposalBuilderDeps,
  customerPhone: string,
  now: Date,
): Promise<EventDescriptionMessage[]> {
  if (!customerPhone) return [];
  try {
    const since = new Date(now.getTime() - CONVERSATION_LOOKBACK_MS);
    const window = await deps.quo.getRecentActivityForContact(customerPhone, {
      limit: 50,
      since,
    });
    return window.messages
      .filter((m) => m.text && m.text.trim().length > 0)
      .map((m) => ({
        direction: m.direction,
        text: m.text,
        at: m.createdAt,
      }))
      .reverse(); // oldest → newest for the LLM
  } catch (err) {
    await logHealthError(
      'proposal-builder',
      `Quo conversation fetch failed: ${(err as Error).message}`,
      { customerPhone },
    );
    return [];
  }
}

async function runSuggestSlot(
  deps: ProposalBuilderDeps,
  directive: SchedulingDirective,
  now: Date,
): Promise<ReturnType<typeof suggestSlot>> {
  try {
    const timeMin = new Date(now.getTime() - CALENDAR_LOOKBACK_BUFFER_MS).toISOString();
    const timeMax = new Date(now.getTime() + CALENDAR_LOOKAHEAD_MS).toISOString();
    const events = await deps.calendar.listEvents({ timeMin, timeMax, maxResults: 500 });
    return suggestSlot({ directive, existingEvents: events, now });
  } catch (err) {
    await logHealthError(
      'proposal-builder',
      `Calendar listEvents failed: ${(err as Error).message}`,
      { directiveId: directive.id },
    );
    return suggestSlot({ directive, existingEvents: [], now });
  }
}

