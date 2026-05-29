/**
 * Tool: searchCalendar
 *
 * Returns events in a date range, optionally narrowed by location keyword
 * and color (job=10, assessment=3, callback=5, any=no filter). Date range
 * is required — the LLM should be explicit about the window it wants.
 */

import { parseDealMarker } from '@aac/api-clients/pipedrive';
import {
  toCalendarEventSummary,
  type CalendarEventSummary,
  type ToolDeps,
} from './types.js';

export type CalendarColor = 'job' | 'assessment' | 'callback' | 'any';

export interface SearchCalendarInput {
  /** ISO datetime — required. */
  rangeStart: string;
  /** ISO datetime — required. */
  rangeEnd: string;
  /** Case-insensitive substring match against event.location. */
  locationKeyword?: string;
  /** 'job' → 10, 'assessment' → 3, 'callback' → 5, 'any' (default) → no filter. */
  color?: CalendarColor;
}

const COLOR_IDS: Record<Exclude<CalendarColor, 'any'>, string> = {
  job: '10',
  assessment: '3',
  callback: '5',
};

export async function searchCalendar(
  deps: ToolDeps,
  input: SearchCalendarInput,
): Promise<CalendarEventSummary[]> {
  if (!input.rangeStart || !input.rangeEnd) {
    throw new Error('searchCalendar requires rangeStart and rangeEnd');
  }

  const colorIds = input.color && input.color !== 'any' ? [COLOR_IDS[input.color]] : undefined;

  const events = await deps.cal.listEvents({
    timeMin: input.rangeStart,
    timeMax: input.rangeEnd,
    ...(colorIds ? { colorIds } : {}),
  });

  const keyword = input.locationKeyword?.toLowerCase();
  return events
    .filter((e) => !keyword || (e.location ?? '').toLowerCase().includes(keyword))
    .map((e) => toCalendarEventSummary(e, parseDealMarker(e.description)));
}
