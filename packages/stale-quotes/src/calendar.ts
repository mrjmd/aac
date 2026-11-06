// ── calendar: booking check + horizon ────────────────────────────────
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { nameCorroborated } from '@aac/customers';
import { EVENT_CLASS_COLOR_IDS, HOLD_COLOR_ID, isBusyEvent } from '@aac/shared-utils/calendar';
import { DAY, isoDay } from './types.js';

export interface DayEvent {
  summary: string;
  location: string;
  colorId?: string;
  attendees: string[];
  days: string[]; // yyyy-mm-dd each day the event spans
  startMs: number;
}

export function expandEvent(e: CalendarEvent): DayEvent {
  const startMs = new Date(e.start).getTime();
  const endMs = new Date(e.end).getTime();
  const days: string[] = [];
  // All-day events have exclusive end dates; timed events may span midnight.
  for (let t = startMs; t < Math.max(endMs, startMs + 1); t += DAY) days.push(isoDay(t));
  if (!days.length) days.push(isoDay(startMs));
  return {
    summary: e.summary ?? '',
    location: e.location ?? '',
    colorId: e.colorId,
    attendees: e.attendees ?? [],
    days,
    startMs,
  };
}

/** Mike's time off, beyond isTechOutOfOffice's "Mike OOO": "Mike vacation",
 *  "Mike off", "day off". Needs Mike or "day off" so "Drop off check" can't match. */
const MIKE_AWAY_RE = /\bmike\b.*\b(vacation|away|off)\b|\bday off\b|\bvacation\b/i;

/** Is this day's capacity used? suggestSlot's rule, plus any job, callback or
 *  graphite event even without Mike's invite (a horizon estimate, so it
 *  errs toward busy), plus Mike's time off. */
export function consumesCapacity(ev: DayEvent, techEmails: readonly string[]): boolean {
  const c = ev.colorId;
  if (c === EVENT_CLASS_COLOR_IDS.job || c === EVENT_CLASS_COLOR_IDS.callback || c === HOLD_COLOR_ID) return true;
  return isBusyEvent(ev, techEmails) || MIKE_AWAY_RE.test(ev.summary);
}

export function computeBookingHorizon(events: DayEvent[], nowMs: number, techEmails: readonly string[]): { firstOpen: string; text: string } {
  const busy = new Set<string>();
  for (const ev of events) {
    if (consumesCapacity(ev, techEmails)) {
      for (const d of ev.days) busy.add(d);
    }
  }
  for (let i = 1; i <= 150; i++) {
    const t = nowMs + i * DAY;
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue; // no Saturdays by default
    const d = isoDay(t);
    if (!busy.has(d)) {
      const weeks = Math.round(i / 7);
      const pretty = new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
      return { firstOpen: d, text: `earliest realistic opening ≈ ${pretty} (~${weeks} weeks out)` };
    }
  }
  return { firstOpen: '', text: 'calendar full for the next 150 days' };
}

/**
 * Booked-on-calendar check: a recent/future green job whose title or
 * location names the customer, corroborated by first name or street
 * number (`nameCorroborated`). Fuzzy surname is what caught
 * Eriksen/"Erikson"; exact matching is insufficient (§8).
 */
export function findBookedEvent(
  events: DayEvent[],
  customerName: string,
  address: string,
  nowMs: number,
): DayEvent | null {
  for (const ev of events) {
    if (ev.colorId !== EVENT_CLASS_COLOR_IDS.job || ev.startMs < nowMs - 7 * DAY) continue; // green jobs, recent/future
    if (nameCorroborated(`${ev.summary} ${ev.location}`, customerName, address)) return ev;
  }
  return null;
}
