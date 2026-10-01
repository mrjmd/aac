/**
 * Multi-day job detection for the field app.
 *
 * Wraps the shared `findContinuation` convention (@aac/shared-utils/multiday)
 * with the calendar lookup: a repair event has a continuation when another
 * green event within the window matches by base title ("[cont]" stripped)
 * or street address. Non-final days get the "Wrap up for today" flow — no
 * payment, no invoice email — see docs/projects/multiday-jobs.md.
 */

import {
  findContinuation,
  CONTINUATION_WINDOW_DAYS,
  type MultidayEvent,
} from '@aac/shared-utils/multiday';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { getCalendar } from './clients';

const DAY_MS = 86_400_000;

/**
 * The next same-job day after `evt`, or null when `evt` is the final (or
 * only) day. Only green (job) events can continue; anything else is null.
 * Calendar lookup failures degrade to null — the normal completion flow —
 * rather than blocking Mike in the field.
 */
export async function findEventContinuation(evt: CalendarEvent): Promise<CalendarEvent | null> {
  if (evt.colorId !== '10') return null;
  const startMs = new Date(evt.start).getTime();
  if (Number.isNaN(startMs)) return null;

  try {
    const candidates = await getCalendar().listEvents({
      timeMin: evt.start,
      timeMax: new Date(startMs + CONTINUATION_WINDOW_DAYS * DAY_MS).toISOString(),
      colorIds: ['10'],
    });
    return findContinuation<CalendarEvent & MultidayEvent>(evt, candidates);
  } catch (err) {
    console.error('continuation lookup failed — treating as final day', evt.id, err);
    return null;
  }
}
