/**
 * Shared helpers for matching a calendar event → Pipedrive person → QB customer.
 *
 * Used by the invoice-create and invoice-send crons. Mirrors the matching
 * sequence used inline by job-reminders and job-followups (single source of
 * truth long-term — those crons are sacrosanct so they're not refactored here).
 */

import { createLogger } from '@aac/shared-utils/logger';
import {
  PipedriveClient,
  type PipedrivePerson,
  type PipedriveDeal,
} from '@aac/api-clients/pipedrive';
import type { QuickBooksClient, QBCustomer } from '@aac/api-clients/quickbooks';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { expandCompoundName } from './followup.js';
import { parseDealMarker } from './cron.js';

const log = createLogger('job-customer-match');

/** "Description has 'PipedriveID: 12345'" → "12345" */
export function extractPipedriveId(description: string | undefined | null): string | null {
  if (!description) return null;
  const match = description.match(/PipedriveID:\s*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Resolve a calendar event to a Pipedrive person, using:
 *   1. PipedriveID marker in the event description, if present
 *   2. Person search by event.summary
 *   3. Compound-name fallback ("Lisa & John Hendrickson" → try each)
 *
 * Returns null if no person matched. Thin wrapper around
 * {@link matchEventToDealAndPerson} that discards the deal — callers
 * that need both should use that function directly.
 */
export async function matchEventToPerson(
  event: CalendarEvent,
  pipedrive: PipedriveClient
): Promise<PipedrivePerson | null> {
  const { person } = await matchEventToDealAndPerson(event, pipedrive);
  return person;
}

/**
 * Resolve a calendar event to a Pipedrive deal AND person.
 *
 * Match order:
 *   0. `[deal:N]` marker in event description → deal.personId → person
 *      (canonical link; lets invoice-create skip the estimate search by
 *      reading deal.qbEstimateId directly)
 *   1. PipedriveID marker → person
 *   2. Name search → person
 *   3. Compound-name fallback → person
 *
 * `deal` is non-null only when the marker resolved; the other paths
 * don't go looking for a deal because there isn't a cheap way to find one
 * from just a person ID, and the deal isn't load-bearing for them.
 *
 * Marker lookup failures (missing dealSpine config, deleted deal, etc.)
 * log a warning and fall through to the legacy matchers — name-match is
 * always a safe fallback.
 */
export async function matchEventToDealAndPerson(
  event: CalendarEvent,
  pipedrive: PipedriveClient
): Promise<{ deal: PipedriveDeal | null; person: PipedrivePerson | null }> {
  const dealId = parseDealMarker(event.description);
  if (dealId) {
    try {
      const deal = await pipedrive.getDeal(dealId);
      if (deal && deal.personId) {
        const person = await pipedrive.getPerson(deal.personId);
        if (person) {
          log.info('Matched event via deal marker', { eventId: event.id, dealId, personId: person.id });
          return { deal, person };
        }
        log.warn('Deal marker resolved but person fetch failed', {
          eventId: event.id, dealId, personId: deal.personId,
        });
      } else if (!deal) {
        log.warn('Deal marker resolved to no deal', { eventId: event.id, dealId });
      }
    } catch (err) {
      log.warn('Deal marker lookup threw, falling back to name-match', {
        eventId: event.id, dealId, error: (err as Error).message,
      });
    }
  }

  const pipedriveId = extractPipedriveId(event.description);
  if (pipedriveId) {
    const person = await pipedrive.getPerson(parseInt(pipedriveId, 10));
    if (person) return { deal: null, person };
  }

  const direct = await pipedrive.searchPersonByName(event.summary);
  if (direct) {
    const person = await pipedrive.getPerson(direct.id);
    if (person) return { deal: null, person };
  }

  for (const candidate of expandCompoundName(event.summary)) {
    const found = await pipedrive.searchPersonByName(candidate);
    if (found) {
      const person = await pipedrive.getPerson(found.id);
      if (person) {
        log.info('Matched compound-name candidate', { original: event.summary, candidate });
        return { deal: null, person };
      }
    }
  }

  return { deal: null, person: null };
}

/**
 * Resolve a Pipedrive person to a QB customer.
 * Tries the person's primary email first, then falls back to display name.
 */
export async function matchPersonToQBCustomer(
  person: PipedrivePerson,
  qb: QuickBooksClient
): Promise<QBCustomer | null> {
  const email = PipedriveClient.getPrimaryEmail(person);
  if (email) {
    const byEmail = await qb.searchCustomerByEmail(email);
    if (byEmail) return byEmail;
  }

  if (person.name) {
    const byName = await qb.searchCustomerByName(person.name);
    if (byName) return byName;
  }

  return null;
}
