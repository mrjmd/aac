/**
 * Resolve a calendar event → Pipedrive person → QB customer.
 *
 * TODO: this duplicates apps/middleware/lib/job-customer-match.ts almost
 * verbatim. When the agent app needs the same logic (per docs/projects/
 * apps-agent.md), hoist this into a shared package and migrate both
 * apps/middleware and apps/field to import it. Until then, keep this
 * file's behavior identical to middleware's so the two can't drift.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { PipedriveClient, type PipedrivePerson } from '@aac/api-clients/pipedrive';
import type { QuickBooksClient, QBCustomer } from '@aac/api-clients/quickbooks';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const log = createLogger('field:customer-match');

/** "PipedriveID: 12345" in the event description → "12345" */
export function extractPipedriveId(description: string | undefined | null): string | null {
  if (!description) return null;
  const match = description.match(/PipedriveID:\s*(\d+)/i);
  return match ? match[1] : null;
}

const COMPOUND_SEPARATOR = /\s+(?:&|\+|and)\s+/i;

/** "Lisa & John Hendrickson" → ["Lisa Hendrickson", "John Hendrickson"] */
export function expandCompoundName(summary: string): string[] {
  if (!summary || !COMPOUND_SEPARATOR.test(summary)) return [];
  const parts = summary.split(COMPOUND_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [];

  let sharedLastName: string | null = null;
  for (const part of parts) {
    const words = part.split(/\s+/);
    if (words.length >= 2) {
      sharedLastName = words[words.length - 1];
      break;
    }
  }
  if (!sharedLastName) return [];

  const out: string[] = [];
  for (const part of parts) {
    const words = part.split(/\s+/);
    if (words.length >= 2) {
      out.push(part);
    } else {
      out.push(`${part} ${sharedLastName}`);
    }
  }
  return out;
}

export async function matchEventToPerson(
  event: CalendarEvent,
  pipedrive: PipedriveClient,
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

export async function matchPersonToQBCustomer(
  person: PipedrivePerson,
  qb: QuickBooksClient,
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
