/**
 * executeHoldEvent — create a HOLD calendar placeholder from a directive
 * whose slot has been OFFERED to the customer but not yet confirmed.
 *
 * Matt's problem (2026-10-07): he offers a time by text, the customer
 * sits on it, and days later he offers the same slot to someone else.
 * A hold makes the offered time visible to every availability check —
 * suggestSlot treats all calendar events as busy, and Matt sees it when
 * he eyeballs the week — without committing anything. A hold:
 *
 *   - is titled "HOLD — {Customer Name}"
 *   - is colorId 8 (graphite) so it reads as a placeholder, never as
 *     booked work (job/assessment/callback detectors key on 10/3/5)
 *   - has NO attendees — Mike must never hear about an unconfirmed offer
 *   - carries machine-readable "Offered-At:" and "Customer-Phone:" lines
 *     in the description so the triage stale-offer detector (D13) can
 *     age it and join it back to the conversation thread
 *
 * Lifecycle: when the customer confirms, the appointment_confirmed /
 * booked manual_schedule path runs executeStubEvent, which deletes any
 * HOLD for the same customer near the slot and creates the real STUB.
 * A hold that never gets an answer is surfaced by triage after 24h —
 * releasing it is one tap (delete the event).
 *
 * Only an EXPLICIT slotCommitment of 'offered' creates a hold. Directives
 * predating the field are treated as offered elsewhere (they never
 * auto-execute), but creating calendar writes from that legacy ambiguity
 * isn't worth it — a missed hold is cheap, a spurious one erodes trust.
 */

import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { createLogger } from '@aac/shared-utils/logger';
import { STUB_DEFAULT_HOURS } from './execute-stub.js';
import type { KnownSlot, SchedulingDirective } from './types.js';
import { isManualSchedule } from './types.js';

const log = createLogger('scheduling:execute-hold');

export const HOLD_TITLE_PREFIX = 'HOLD — ';

/** Graphite — deliberately none of the work colors (job 10 / assessment 3 / callback 5). */
export const HOLD_COLOR_ID = '8';

/** Description lines D13 parses. Keep stable — triage greps for these. */
export const HOLD_OFFERED_AT_LABEL = 'Offered-At:';
export const HOLD_CUSTOMER_PHONE_LABEL = 'Customer-Phone:';

/** How far around the slot to scan for an existing event for the same customer. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead to scan for same-customer HOLDs. A new explicit offer
 * supersedes every outstanding unconfirmed hold for that customer, wherever
 * it sits — not just within the duplicate window.
 */
export const HOLD_RELEASE_LOOKAHEAD_MS = 60 * 24 * 60 * 60 * 1000;

export interface ExecuteHoldDeps {
  cal: GoogleCalendarClient;
  now: () => Date;
}

export interface ExecuteHoldInput {
  directive: SchedulingDirective;
  /** Display name for the event title + duplicate matching. */
  customerName: string;
  /** Street address for the event location; omitted when unknown. */
  customerAddress?: string | null;
  /**
   * Algorithm-SUGGESTED slot (quote_approved → suggestSlot flow) rather
   * than a slot Matt already offered by text. When set, the hold is
   * created on this slot with "Slot SUGGESTED … NOT yet offered" wording;
   * getOfferedSlot (which only honors manual_schedule offers) is bypassed.
   */
  suggestedSlot?: KnownSlot | null;
}

export type ExecuteHoldResult =
  | { status: 'created'; eventId: string; htmlLink: string }
  | { status: 'skipped'; reason: 'no_slot' | 'slot_in_past' | 'duplicate_event' };

/**
 * Extract the offered-but-unconfirmed slot from a directive, if any.
 * Mirrors getActionableSlot: that one returns agreed slots, this one
 * returns slots still awaiting the customer's yes.
 */
export function getOfferedSlot(directive: SchedulingDirective): KnownSlot | null {
  if (isManualSchedule(directive) && directive.slotCommitment === 'offered') {
    return directive.knownSlot ?? null;
  }
  return null;
}

export async function executeHoldEvent(
  deps: ExecuteHoldDeps,
  input: ExecuteHoldInput,
): Promise<ExecuteHoldResult> {
  const { directive, customerName, customerAddress, suggestedSlot } = input;

  const slot = suggestedSlot ?? getOfferedSlot(directive);
  if (!slot) return { status: 'skipped', reason: 'no_slot' };

  const start = new Date(slot.startIso);
  if (Number.isNaN(start.getTime())) return { status: 'skipped', reason: 'no_slot' };
  if (start.getTime() <= deps.now().getTime()) {
    log.warn('Hold slot is in the past — skipping', {
      directiveId: directive.id,
      startIso: slot.startIso,
    });
    return { status: 'skipped', reason: 'slot_in_past' };
  }

  const end = slot.endIso
    ? new Date(slot.endIso)
    : new Date(start.getTime() + STUB_DEFAULT_HOURS[directive.eventClass] * 60 * 60 * 1000);

  // Scan once, wide: duplicate detection needs ±24h around the slot, hold
  // supersession needs every future same-customer HOLD.
  const nowMs = deps.now().getTime();
  const dupMinMs = start.getTime() - DUPLICATE_WINDOW_MS;
  const dupMaxMs = end.getTime() + DUPLICATE_WINDOW_MS;
  const nearby = await deps.cal.listEvents({
    timeMin: new Date(Math.min(nowMs, dupMinMs)).toISOString(),
    timeMax: new Date(Math.max(dupMaxMs, nowMs + HOLD_RELEASE_LOOKAHEAD_MS)).toISOString(),
    maxResults: 500,
  });
  const nameLc = customerName.trim().toLowerCase();
  const matches = nameLc.length > 0
    ? nearby.filter((e) => e.summary?.toLowerCase().includes(nameLc))
    : [];
  const holds = matches.filter((e) => e.summary?.startsWith(HOLD_TITLE_PREFIX));

  // Non-hold events (stubs, hand-made bookings) only block within ±24h of
  // the slot — a customer with an unrelated event next month is not a dup.
  const existing = matches.find(
    (e) =>
      !e.summary?.startsWith(HOLD_TITLE_PREFIX)
      && new Date(e.end).getTime() > dupMinMs
      && new Date(e.start).getTime() < dupMaxMs,
  );
  if (existing) {
    log.info('Hold skipped — event already exists for customer near slot', {
      directiveId: directive.id,
      existingEventId: existing.id,
      existingSummary: existing.summary,
    });
    return { status: 'skipped', reason: 'duplicate_event' };
  }

  if (suggestedSlot) {
    // A suggestion never tramples an existing hold: if ANY hold stands for
    // this customer, an offer (Matt's hand-made or chat-detected) is already
    // out — the suggestion defers to it.
    if (holds.length > 0) {
      log.info('Suggested hold skipped — customer already has an outstanding hold', {
        directiveId: directive.id,
        existingHoldId: holds[0].id,
      });
      return { status: 'skipped', reason: 'duplicate_event' };
    }
  } else {
    // Matt's explicit offer supersedes every outstanding unconfirmed hold
    // for this customer — including a same-time suggestion hold (recreated
    // below with fresh Offered-At + OFFERED wording) and stale holds on
    // other days.
    for (const hold of holds) {
      try {
        await deps.cal.deleteEvent(hold.id);
        log.info('Prior hold superseded by new offer', {
          directiveId: directive.id,
          supersededHoldId: hold.id,
          supersededSummary: hold.summary,
        });
      } catch (err) {
        // A lingering hold is cosmetic (triage D13 surfaces it); the new
        // offer's hold matters more.
        log.warn('Failed to delete superseded hold — continuing', {
          directiveId: directive.id,
          holdEventId: hold.id,
          error: (err as Error).message,
        });
      }
    }
  }

  const headline = suggestedSlot
    ? `Slot SUGGESTED for ${customerName} — quote accepted, time NOT yet offered to the customer. Mike not assigned.`
    : `Time OFFERED to ${customerName} — awaiting their reply. Not confirmed; Mike not assigned.`;
  const description = [
    headline,
    directive.scopeSummary,
    '',
    `${HOLD_OFFERED_AT_LABEL} ${deps.now().toISOString()}`,
    `${HOLD_CUSTOMER_PHONE_LABEL} ${directive.customerPhone}`,
    `Auto-created hold from ${directive.source} directive ${directive.id}`
      + ` (confidence ${directive.confidence.score}).`,
    suggestedSlot
      ? 'If the customer confirms, the stub flow replaces this. If the time goes elsewhere, delete it to release the slot.'
      : 'If the customer confirms, the stub flow replaces this. If they decline or go quiet, delete it to release the slot.',
  ].join('\n');

  const event = await deps.cal.createEvent({
    summary: `${HOLD_TITLE_PREFIX}${customerName}`,
    start: start.toISOString(),
    end: end.toISOString(),
    colorId: HOLD_COLOR_ID,
    ...(customerAddress ? { location: customerAddress } : {}),
    description,
    sendUpdates: 'none',
  });

  log.info('Hold event created', {
    directiveId: directive.id,
    eventId: event.id,
    start: start.toISOString(),
  });

  return { status: 'created', eventId: event.id, htmlLink: event.htmlLink };
}
