/**
 * What a Google Calendar event means to AAC: the color and title
 * conventions, and which events take the technician's time. The one home
 * for these rules; every app, package and tool imports from here.
 *
 * Structural event types only (no @aac/api-clients dependency): pass any
 * event object with the listed fields.
 */

/** Work colors (Google colorId): Job green, Assessment grape, Callback yellow. */
export const EVENT_CLASS_COLOR_IDS = {
  job: '10',
  assessment: '3',
  callback: '5',
} as const;

/** HOLD placeholders are graphite, deliberately none of the work colors. */
export const HOLD_COLOR_ID = '8';

/** Title prefixes of scheduling-pipeline placeholders (@aac/scheduling writes them). */
export const HOLD_TITLE_PREFIX = 'HOLD — ';
export const STUB_TITLE_PREFIX = 'STUB — ';

/** Mike's addresses; deployments override with TECHNICIAN_EMAILS. */
export const DEFAULT_TECHNICIAN_EMAILS: readonly string[] = ['mike@attackacrack.com', 'harrringtonm@gmail.com'];

/** TECHNICIAN_EMAILS (comma-separated) or the default, lowercased. */
export function technicianEmails(raw: string | undefined): string[] {
  const list = raw ? raw.split(',') : [...DEFAULT_TECHNICIAN_EMAILS];
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/**
 * "Mike OOO" / "Mike out of office" entries. Matt creates these without
 * inviting Mike, so the attendee test misses them (2026-10-15: suggestSlot
 * offered slots on Mike's day off). Requires BOTH the name and an OOO
 * marker so Matt's own time off and customer events never match; a looser
 * test (any "off" or "away") blocked days for unrelated events.
 */
export function isTechOutOfOffice(summary: string | undefined): boolean {
  if (!summary) return false;
  return /\bmike\b/i.test(summary) && /\booo\b|out of office/i.test(summary);
}

export interface BusyCheckEvent {
  summary?: string;
  colorId?: string;
  attendees?: readonly string[];
}

/**
 * Does this event take the technician's time? Four kinds do:
 *   1. Events Mike attends (jobs, assessments, callbacks, stubs).
 *   2. Job and callback colors even without the invite: that is Mike's work.
 *   3. HOLD placeholders: attendee-less so Mike never sees unconfirmed
 *      offers, but they exist to keep the offered time free.
 *   4. "Mike OOO" entries (isTechOutOfOffice).
 * Matt's own meetings (no Mike, no work color) never block. Assessments
 * Matt runs alone (grape, no Mike) don't either.
 */
export function isBusyEvent(e: BusyCheckEvent, techEmails: readonly string[]): boolean {
  const summary = e.summary ?? '';
  if (summary.startsWith(HOLD_TITLE_PREFIX) || e.colorId === HOLD_COLOR_ID) return true;
  if (e.colorId === EVENT_CLASS_COLOR_IDS.job || e.colorId === EVENT_CLASS_COLOR_IDS.callback) return true;
  if (isTechOutOfOffice(summary)) return true;
  const emails = techEmails.map((t) => t.toLowerCase());
  return (e.attendees ?? []).some((a) => emails.includes(a.toLowerCase()));
}

/**
 * The events that block scheduling. With no technician emails configured
 * everything blocks (the historical degraded behavior; callers warn).
 */
export function selectBusyEvents<T extends BusyCheckEvent>(events: T[], techEmails: readonly string[]): T[] {
  if (techEmails.length === 0) return events;
  return events.filter((e) => isBusyEvent(e, techEmails));
}
