/**
 * "Is this customer already on the calendar?" — shared by qb-reconcile and
 * qb-webhook so an Accepted quote for a booked customer never produces a
 * scheduling directive or a "here are some slots" note.
 */

import { summaryMatchesCustomer } from '@aac/customers';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { getCalendar } from './clients.js';

/** How far ahead to look for a booked event for the customer. */
export const BOOKED_LOOKAHEAD_DAYS = 60;

/** Upcoming calendar events (now → BOOKED_LOOKAHEAD_DAYS). */
export async function listUpcomingEvents(now = new Date()): Promise<CalendarEvent[]> {
  return getCalendar().listEvents({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + BOOKED_LOOKAHEAD_DAYS * 86_400_000).toISOString(),
    maxResults: 500,
  });
}

/** The first upcoming event naming this customer (strict name match). */
export function bookedEventFor(
  events: CalendarEvent[],
  customerName: string,
): CalendarEvent | undefined {
  return events.find((e) => summaryMatchesCustomer(e.summary, customerName));
}
