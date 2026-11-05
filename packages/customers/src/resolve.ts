/**
 * Resolve a calendar event → Pipedrive person (and deal) → QBO customer.
 *
 * Used by the middleware reminder, follow-up and invoice crons and by the
 * field app (job page phone, day-list city, running-late text, payment).
 * Moved here from apps/middleware/lib/job-customer-match.ts on 2026-11-05;
 * the field app's own older copy was retired the same day (owner-approved).
 */

import { createLogger } from '@aac/shared-utils/logger';
import {
  PipedriveClient,
  type PipedrivePerson,
  type PipedriveDeal,
  parseDealMarker,
} from '@aac/api-clients/pipedrive';
import type { QuickBooksClient, QBCustomer } from '@aac/api-clients/quickbooks';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import { stripTitleMarker } from '@aac/shared-utils/multiday';
import { expandCompoundName, expandNicknames } from './match.js';

const log = createLogger('customers:resolve');

/** The Pipedrive reads the resolver needs. */
export type PipedriveLookup = Pick<
  PipedriveClient,
  'getDeal' | 'getPerson' | 'searchPersonByName' | 'searchPersonByPhone'
>;

// ── phone-in-description fallback ────────────────────────────────────

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/** E.164 phones found in an event description, deduped, max 5. */
export function extractPhonesFromDescription(description: string | undefined | null): string[] {
  if (!description) return [];
  const out: string[] = [];
  for (const raw of description.match(PHONE_RE) ?? []) {
    const normalized = quickNormalizePhone(raw);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= 5) break;
  }
  return out;
}

/** Guard for phone matches: descriptions also carry property managers and
 *  other third parties, so the matched person's last name must appear in
 *  the event title. */
function lastNameInSummary(personName: string | null | undefined, summary: string): boolean {
  if (!personName) return false;
  const words = personName.trim().split(/\s+/);
  const lastName = words[words.length - 1]?.toLowerCase().replace(/[^a-z'-]/g, '');
  if (!lastName || lastName.length < 2) return false;
  return summary.toLowerCase().includes(lastName);
}

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
  pipedrive: PipedriveLookup,
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
  pipedrive: PipedriveLookup,
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

  // Multi-day continuation days are titled "NAME [cont]" — strip any
  // trailing marker so they match the same person as day one
  // (Teddy Watler follow-up miss, 2026-10-18).
  const searchName = stripTitleMarker(event.summary);

  const direct = await pipedrive.searchPersonByName(searchName);
  if (direct) {
    const person = await pipedrive.getPerson(direct.id);
    if (person) return { deal: null, person };
  }

  const nameCandidates = [
    ...expandNicknames(searchName),
    ...expandCompoundName(searchName).flatMap((c) => [c, ...expandNicknames(c)]),
  ];
  for (const candidate of nameCandidates) {
    const found = await pipedrive.searchPersonByName(candidate);
    if (found) {
      const person = await pipedrive.getPerson(found.id);
      if (person) {
        log.info('Matched name candidate', { original: event.summary, candidate });
        return { deal: null, person };
      }
    }
  }

  for (const phone of extractPhonesFromDescription(event.description)) {
    // PD's phone search is format-literal: E.164 and national can hit
    // different stored records (verified live 2026-10-19) — try both.
    for (const term of [phone, phone.replace(/^\+1/, '')]) {
      const found = await pipedrive.searchPersonByPhone(term);
      if (found && lastNameInSummary(found.name, event.summary)) {
        const person = await pipedrive.getPerson(found.id);
        if (person) {
          log.info('Matched via phone in description', { original: event.summary, phone: term, personName: found.name });
          return { deal: null, person };
        }
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
  qb: Pick<QuickBooksClient, 'searchCustomerByEmail' | 'searchCustomerByName'>,
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
