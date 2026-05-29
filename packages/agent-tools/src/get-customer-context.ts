/**
 * Tool: getCustomerContext
 *
 * Pulls together everything an LLM needs to answer "what's going on with
 * so-and-so?" — PD person, all PD deals for them, recent Quo messages/calls,
 * and recent calendar events tagged with any of those deals' `[deal:N]` markers.
 *
 * Resolves identity by either personId (preferred when known) or phone
 * (E.164; uses PD's phone search). Never throws on "not found": missing
 * person → returns `{ person: null, deals: [], ... }` so the LLM can reason
 * about the gap.
 */

import { parseDealMarker } from '@aac/api-clients/pipedrive';
import {
  toPersonSummary,
  toDealSummary,
  toCalendarEventSummary,
  toQuoMessageSummary,
  toQuoCallSummary,
  type PersonSummary,
  type DealSummary,
  type CalendarEventSummary,
  type QuoMessageSummary,
  type QuoCallSummary,
  type ToolDeps,
} from './types.js';

export interface GetCustomerContextInput {
  personId?: number;
  /** E.164 phone, e.g. "+16175551212" */
  phone?: string;
  /** Bound recent messages/calls/events to this lookback window. Default 90. */
  recentDays?: number;
}

export interface CustomerContext {
  person: PersonSummary | null;
  deals: DealSummary[];
  recentMessages: QuoMessageSummary[];
  recentCalls: QuoCallSummary[];
  recentEvents: CalendarEventSummary[];
}

export interface GetCustomerContextConfig {
  /** Used to format pdUrl on the PersonSummary. */
  pdCompanyDomain: string;
}

const DEFAULT_RECENT_DAYS = 90;

export async function getCustomerContext(
  deps: ToolDeps,
  config: GetCustomerContextConfig,
  input: GetCustomerContextInput,
): Promise<CustomerContext> {
  if (input.personId === undefined && !input.phone) {
    throw new Error('getCustomerContext requires either personId or phone');
  }

  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;
  const since = new Date();
  since.setDate(since.getDate() - recentDays);
  const sinceISO = since.toISOString();

  // 1. Resolve the person
  let person = input.personId
    ? await deps.pd.getPerson(input.personId)
    : null;
  if (!person && input.phone) {
    person = await deps.pd.searchPersonByPhone(input.phone);
  }

  if (!person) {
    return {
      person: null,
      deals: [],
      recentMessages: [],
      recentCalls: [],
      recentEvents: [],
    };
  }

  // 2. Deals + Quo activity (parallel — independent)
  const personPhone =
    input.phone ??
    person.phone?.find((p) => p.primary)?.value ??
    person.phone?.[0]?.value ??
    null;

  const [deals, activity, events] = await Promise.all([
    deps.pd.getDealsByPerson(person.id),
    personPhone
      ? deps.quo.getRecentActivityForContact(personPhone, { since, limit: 50 })
      : Promise.resolve({ messages: [], calls: [] }),
    deps.cal.listEvents({
      timeMin: sinceISO,
      timeMax: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      requireDescription: true,
    }),
  ]);

  // 3. Filter calendar events to ones tagged with any of this person's deal IDs
  const dealIds = new Set(deals.map((d) => d.id));
  const taggedEvents: CalendarEventSummary[] = [];
  for (const event of events) {
    const dealId = parseDealMarker(event.description);
    if (dealId !== null && dealIds.has(dealId)) {
      taggedEvents.push(toCalendarEventSummary(event, dealId));
    }
  }

  return {
    person: toPersonSummary(person, config.pdCompanyDomain),
    deals: deals.map(toDealSummary),
    recentMessages: activity.messages.map(toQuoMessageSummary),
    recentCalls: activity.calls.map(toQuoCallSummary),
    recentEvents: taggedEvents,
  };
}
