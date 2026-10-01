/**
 * executeStubEvent — create a STUB calendar event from a directive that
 * carries a concrete, agreed slot.
 *
 * This is the reduced-risk first slice of Walk #7 (executeDirective):
 * instead of full autonomous scheduling, it materializes appointments
 * Matt has already committed to in conversation ("I'm putting you down
 * for Tuesday at 10" / customer confirming an offered time) as calendar
 * stubs, saving the manual data entry. A stub:
 *
 *   - is titled "STUB — {Customer Name}" so Matt knows it's incomplete
 *   - carries the event-class color (job=10 green, assessment=3 grape,
 *     callback=5 yellow)
 *   - defaults duration: assessment 30 min; job and callback 3.5 h
 *   - has the technician as attendee but sends NO email (sendUpdates:
 *     'none') — Matt reviews before Mike hears about it
 *   - puts the customer address in location and the classifier's scope
 *     summary + provenance in the description
 *
 * Failure mode is intentionally cheap: a wrong stub is one tap to delete.
 * The duplicate guard (any event naming the same customer within a day of
 * the slot) keeps re-fired directives and already-hand-created events from
 * producing doubles.
 */

import type { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { createLogger } from '@aac/shared-utils/logger';
import type { EventClass, KnownSlot, SchedulingDirective } from './types.js';
import { isAppointmentConfirmed, isManualSchedule } from './types.js';

const log = createLogger('scheduling:execute-stub');

export const STUB_TITLE_PREFIX = 'STUB — ';

/** Mirrors project_calendar_color_ids: Job green, Assessment grape, Callback yellow. */
export const EVENT_CLASS_COLOR_IDS: Record<EventClass, string> = {
  job: '10',
  assessment: '3',
  callback: '5',
};

/** Default stub durations in hours, per Matt (2026-09-30). */
export const STUB_DEFAULT_HOURS: Record<EventClass, number> = {
  assessment: 0.5,
  job: 3.5,
  callback: 3.5,
};

/** How far around the slot to scan for an existing event for the same customer. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ExecuteStubDeps {
  cal: GoogleCalendarClient;
  now: () => Date;
}

export interface ExecuteStubInput {
  directive: SchedulingDirective;
  /** Display name for the event title + duplicate matching. */
  customerName: string;
  /** Street address for the event location; omitted when unknown. */
  customerAddress?: string | null;
  /** Attendees added WITHOUT notification (e.g. Mike). */
  technicianEmails: string[];
}

export type ExecuteStubResult =
  | { status: 'created'; eventId: string; htmlLink: string }
  | { status: 'skipped'; reason: 'no_slot' | 'slot_in_past' | 'duplicate_event' };

/**
 * Extract the agreed slot from a directive, if it carries one. Only
 * booked manual-schedules and customer confirmations qualify — an
 * 'offered' manual-schedule slot is still awaiting the customer's yes.
 */
export function getActionableSlot(directive: SchedulingDirective): KnownSlot | null {
  if (isAppointmentConfirmed(directive)) return directive.knownSlot;
  if (isManualSchedule(directive) && directive.slotCommitment === 'booked') {
    return directive.knownSlot ?? null;
  }
  return null;
}

export async function executeStubEvent(
  deps: ExecuteStubDeps,
  input: ExecuteStubInput,
): Promise<ExecuteStubResult> {
  const { directive, customerName, customerAddress, technicianEmails } = input;

  const slot = getActionableSlot(directive);
  if (!slot) return { status: 'skipped', reason: 'no_slot' };

  const start = new Date(slot.startIso);
  if (Number.isNaN(start.getTime())) return { status: 'skipped', reason: 'no_slot' };
  if (start.getTime() <= deps.now().getTime()) {
    log.warn('Stub slot is in the past — skipping', {
      directiveId: directive.id,
      startIso: slot.startIso,
    });
    return { status: 'skipped', reason: 'slot_in_past' };
  }

  const end = slot.endIso
    ? new Date(slot.endIso)
    : new Date(start.getTime() + STUB_DEFAULT_HOURS[directive.eventClass] * 60 * 60 * 1000);

  // Duplicate guard: any event mentioning this customer within a day of
  // the slot means either a previous stub or Matt's own hand-made event.
  const nearby = await deps.cal.listEvents({
    timeMin: new Date(start.getTime() - DUPLICATE_WINDOW_MS).toISOString(),
    timeMax: new Date(end.getTime() + DUPLICATE_WINDOW_MS).toISOString(),
  });
  const nameLc = customerName.trim().toLowerCase();
  const existing = nearby.find((e) => e.summary?.toLowerCase().includes(nameLc));
  if (nameLc.length > 0 && existing) {
    log.info('Stub skipped — event already exists for customer near slot', {
      directiveId: directive.id,
      existingEventId: existing.id,
      existingSummary: existing.summary,
    });
    return { status: 'skipped', reason: 'duplicate_event' };
  }

  const description = [
    directive.scopeSummary,
    '',
    `Auto-created stub from ${directive.source} directive ${directive.id}`
      + ` (${directive.intent}, confidence ${directive.confidence.score}).`,
    'Review time, scope, and duration before confirming with the customer.',
  ].join('\n');

  const event = await deps.cal.createEvent({
    summary: `${STUB_TITLE_PREFIX}${customerName}`,
    start: start.toISOString(),
    end: end.toISOString(),
    colorId: EVENT_CLASS_COLOR_IDS[directive.eventClass],
    ...(customerAddress ? { location: customerAddress } : {}),
    description,
    attendees: technicianEmails,
    sendUpdates: 'none',
  });

  log.info('Stub event created', {
    directiveId: directive.id,
    eventId: event.id,
    eventClass: directive.eventClass,
    start: start.toISOString(),
  });

  return { status: 'created', eventId: event.id, htmlLink: event.htmlLink };
}
