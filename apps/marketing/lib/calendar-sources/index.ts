/**
 * Unified calendar event fetcher.
 * Calls all sources in parallel, merges results, surfaces partial failures.
 */
import { fetchSocialEvents } from "./social";
import { fetchGbpEvents } from "./gbp";
import { fetchBlogEvents } from "./blog";
import type { CalendarEvent } from "./types";

export type { CalendarEvent, CalendarSource, CalendarSourceResult, CalendarStatus } from "./types";

export interface CalendarFetchResult {
  events: CalendarEvent[];
  /** Per-source error messages — UI shows these as a non-blocking warning */
  errors: string[];
}

/**
 * Fetch all calendar events for the given window from all sources in parallel.
 * Each source is independent — if one fails, the others still return.
 */
export async function getCalendarEvents(
  start: Date,
  end: Date,
): Promise<CalendarFetchResult> {
  const results = await Promise.all([
    fetchSocialEvents(start, end),
    fetchGbpEvents(start, end),
    fetchBlogEvents(start, end),
  ]);

  const events: CalendarEvent[] = [];
  const errors: string[] = [];

  for (const result of results) {
    events.push(...result.events);
    if (result.error) errors.push(result.error);
  }

  // Sort chronologically
  events.sort((a, b) => a.date.localeCompare(b.date));

  return { events, errors };
}
