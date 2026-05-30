/**
 * resolveCallbackParent — find the original PD deal a callback should
 * attach to, plus how many callbacks already exist on that parent.
 *
 * Per Matt: the canonical source is the most recent Google Calendar
 * event with `colorId='10'` (job) whose summary matches the customer
 * name. The parent deal ID is extracted from the event description via
 * `[deal:N]` marker. Sequence is the count of prior `colorId='5'`
 * (callback) events for the same customer between the parent event and
 * today, plus one.
 *
 * Long-term plan (per Matt): once the PD deal-state backfill is solid,
 * this should switch to a PD field lookup — less brittle than scanning
 * calendar text. Keep this resolver wrapped in a single export so the
 * migration is one file's worth of change.
 *
 * Returns null when:
 *   - no job event found for the customer in the lookback window, OR
 *   - the event has no `[deal:N]` marker (older pre-deal-spine events)
 *
 * The caller (Quo webhook) treats null as "can't form a callback
 * directive" and logs to /api/health so Matt can intervene manually.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { parseDealMarker } from '@aac/api-clients/pipedrive';
import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';

const log = createLogger('resolve-callback-parent');

const DEFAULT_LOOKBACK_DAYS = 730; // ~2 years

export interface ResolveCallbackParentDeps {
  cal: GoogleCalendarClient;
}

export interface ResolveCallbackParentInput {
  /** Customer's PD person name — used for case-insensitive substring match against event.summary. */
  customerName: string;
  /** Lookback window in days (default 730). */
  lookbackDays?: number;
  /** Clock — defaults to new Date(). Injected for testability. */
  now?: () => Date;
}

export interface ResolveCallbackParentResult {
  parentDealId: number;
  /** 1 = first callback on parent, 2 = second, etc. */
  callbackSequence: number;
  /** Scope hint from the parent event summary, if extractable. */
  originalServiceType?: string;
}

export async function resolveCallbackParent(
  deps: ResolveCallbackParentDeps,
  input: ResolveCallbackParentInput,
): Promise<ResolveCallbackParentResult | null> {
  const name = input.customerName.trim();
  if (!name) {
    log.warn('resolveCallbackParent called with empty customer name');
    return null;
  }

  const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const now = (input.now ?? (() => new Date()))();
  const timeMax = now.toISOString();
  const timeMin = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();

  // Pull both jobs (colorId=10) and callbacks (colorId=5) in one call
  // so we can count the sequence without a second round-trip.
  let events: CalendarEvent[];
  try {
    events = await deps.cal.listEvents({
      timeMin,
      timeMax,
      colorIds: ['10', '5'],
      maxResults: 250,
    });
  } catch (err) {
    log.error('Calendar listEvents failed', err as Error, { customerName: name });
    return null;
  }

  const nameLower = name.toLowerCase();
  const matchesCustomer = (e: CalendarEvent): boolean =>
    e.summary.toLowerCase().includes(nameLower);

  const customerEvents = events.filter(matchesCustomer);
  if (customerEvents.length === 0) {
    log.info('No matching customer events for callback parent', {
      customerName: name,
      lookbackDays,
    });
    return null;
  }

  // Most recent job event = parent. Sort by start descending.
  const jobs = customerEvents
    .filter((e) => e.colorId === '10')
    .sort((a, b) => b.start.localeCompare(a.start));
  if (jobs.length === 0) {
    log.info('Customer has callbacks but no parent job in window', {
      customerName: name,
      lookbackDays,
    });
    return null;
  }

  const parent = jobs[0];
  const parentDealId = parseDealMarker(parent.description);
  if (!parentDealId) {
    log.warn('Parent job has no [deal:N] marker', {
      customerName: name,
      parentEventId: parent.id,
      parentStart: parent.start,
    });
    return null;
  }

  // Count callbacks that occurred AFTER the parent job.
  const callbacks = customerEvents.filter(
    (e) => e.colorId === '5' && e.start > parent.start,
  );
  const callbackSequence = callbacks.length + 1;

  const originalServiceType = extractServiceTypeFromSummary(parent.summary, name);

  log.info('Resolved callback parent', {
    customerName: name,
    parentDealId,
    parentStart: parent.start,
    callbackSequence,
  });

  return {
    parentDealId,
    callbackSequence,
    ...(originalServiceType ? { originalServiceType } : {}),
  };
}

/**
 * Calendar summaries follow patterns like "John Smith - Crack Injection"
 * or "Smith - Patio Resurfacing". Strip the customer name and dash to
 * surface the service type. Returns undefined if no service hint remains.
 */
function extractServiceTypeFromSummary(summary: string, customerName: string): string | undefined {
  const lowered = summary.toLowerCase();
  const nameLower = customerName.toLowerCase();
  const idx = lowered.indexOf(nameLower);
  if (idx === -1) return undefined;
  const after = summary.slice(idx + customerName.length).trim();
  // Strip leading punctuation/dash
  const cleaned = after.replace(/^[\s\-—–:|,]+/, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
