/**
 * Shared helpers for matching a calendar event → Pipedrive person → QB customer.
 *
 * Used by the invoice-create and invoice-send crons. Mirrors the matching
 * sequence used inline by job-reminders and job-followups (single source of
 * truth long-term — those crons are sacrosanct so they're not refactored here).
 */

import { createLogger } from '@aac/shared-utils/logger';
import { PipedriveClient, type PipedrivePerson } from '@aac/api-clients/pipedrive';
import type { QuickBooksClient, QBCustomer } from '@aac/api-clients/quickbooks';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { expandCompoundName } from './followup.js';

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
 * Returns null if no person matched.
 */
export async function matchEventToPerson(
  event: CalendarEvent,
  pipedrive: PipedriveClient
): Promise<PipedrivePerson | null> {
  const pipedriveId = extractPipedriveId(event.description);
  if (pipedriveId) {
    const person = await pipedrive.getPerson(parseInt(pipedriveId, 10));
    if (person) return person;
  }

  const direct = await pipedrive.searchPersonByName(event.summary);
  if (direct) {
    const person = await pipedrive.getPerson(direct.id);
    if (person) return person;
  }

  for (const candidate of expandCompoundName(event.summary)) {
    const found = await pipedrive.searchPersonByName(candidate);
    if (found) {
      const person = await pipedrive.getPerson(found.id);
      if (person) {
        log.info('Matched compound-name candidate', { original: event.summary, candidate });
        return person;
      }
    }
  }

  return null;
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
