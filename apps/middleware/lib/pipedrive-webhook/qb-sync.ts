/**
 * Pipedrive person → QuickBooks customer sync: update the linked customer,
 * link an existing one by email or name, or create it (recovering from the
 * duplicate-name race).
 */

import { createLogger } from '@aac/shared-utils/logger';
import { PIPEDRIVE_CROSS_SYSTEM_FIELDS } from '@aac/api-clients/pipedrive';
import {
  getQbCustomerIdFromPipedrive,
  storePipedriveToQbMapping,
  countCondition,
} from '../redis.js';
import type { PersonSyncContext } from './types.js';

const log = createLogger('pipedrive-webhook');

/**
 * Compute a unique QuickBooks DisplayName from the data we currently have.
 *
 * QB requires DisplayName to be unique across the customer base. When we only
 * have a first name (or nothing yet), bare values like "Sam" or "Unknown" will
 * collide with existing customers and fail. To keep all three systems in sync,
 * we append a phone-last-4 disambiguator until a real full name is available.
 *
 * Returns a name that's either:
 *   - a real multi-token name (used as-is)
 *   - "<FirstName> (·1234)" when only a single token is available
 *   - "Lead (·1234)" when no usable name has been extracted yet
 *
 * Subsequent webhooks should always recompute this — when the name fills in,
 * the disambiguator naturally falls away on the next updateCustomer call.
 */
export function buildQbDisplayName(rawName: string, e164Phone: string): string {
  const last4 = e164Phone.slice(-4);
  const trimmed = (rawName || '').trim();
  const isUnknownish =
    !trimmed ||
    trimmed.toLowerCase() === 'unknown' ||
    trimmed.startsWith('Unknown Lead');

  if (isUnknownish) {
    return `Lead (·${last4})`;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    return trimmed;
  }

  return `${tokens[0]} (·${last4})`;
}

/**
 * QB API errors surface as Error messages containing the raw fault JSON
 * (see QuickBooksClient.request). Match on the structured fault code rather
 * than the human-readable text, which Intuit has reworded before.
 */
export function isQbErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && error.message.includes(`"code":"${code}"`);
}

/** Returns the QB customer id, or null when QB is disconnected or nothing was linked. */
export async function syncPersonToQuickBooks(ctx: PersonSyncContext): Promise<string | null> {
  const { data, e164Phone, pd, qb } = ctx;
  const { personName, firstName, lastName, company, primaryEmail, addressLine1, locality, state, postalCode } = ctx.person;

  const qbConnected = await qb.isConnected();
  if (!qbConnected) {
    log.debug('QuickBooks not connected, skipping sync');
    await countCondition('pd-webhook.qb_disconnected');
    return null;
  }

  // Compute the DisplayName to use for create AND update. When the Pipedrive
  // name only has one token (or none), append a phone-last-4 disambiguator
  // so QB's unique-DisplayName constraint doesn't reject the create. On
  // subsequent updates this naturally rewrites to the full name once it fills in.
  const qbDisplayName = buildQbDisplayName(personName, e164Phone);

  // Check Redis cache first, then fall back to Pipedrive custom field
  let qbCustomerId: string | null = await getQbCustomerIdFromPipedrive(String(data.id));
  if (!qbCustomerId) {
    qbCustomerId = await pd.getPersonCustomField(
      data.id,
      PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID
    );
    if (qbCustomerId) {
      // storePipedriveToQbMapping stores bidirectionally
      await storePipedriveToQbMapping(String(data.id), qbCustomerId);
      log.debug('Restored QB mapping from Pipedrive field', {
        pipedriveId: data.id,
        qbId: qbCustomerId,
      });
    }
  }

  if (qbCustomerId) {
    // Update existing QuickBooks customer — recomputes DisplayName each time
    // so the temp "(·1234)" suffix falls away once a full name is available.
    const existingCustomer = await qb.getCustomer(qbCustomerId);
    if (existingCustomer && existingCustomer.Id) {
      const syncToken = (existingCustomer as unknown as Record<string, unknown>)
        .SyncToken as string;

      try {
        await qb.updateCustomer(qbCustomerId, {
          SyncToken: syncToken,
          DisplayName: qbDisplayName,
          GivenName: firstName,
          FamilyName: lastName || undefined,
          CompanyName: company,
          PrimaryEmailAddr: primaryEmail ? { Address: primaryEmail } : undefined,
          PrimaryPhone: { FreeFormNumber: e164Phone },
          BillAddr: addressLine1
            ? {
                Line1: addressLine1,
                City: locality,
                CountrySubDivisionCode: state,
                PostalCode: postalCode,
              }
            : undefined,
        });

        log.info('Updated QuickBooks customer', {
          pipedriveId: data.id,
          qbCustomerId,
          displayName: qbDisplayName,
        });
      } catch (error) {
        // Pipedrive fires person.added + person.updated near-simultaneously,
        // so a concurrent invocation may have updated this customer between
        // our SyncToken read and this write. The winner wrote the same data —
        // treat the stale-token rejection (5010) as success.
        if (!isQbErrorCode(error, '5010')) throw error;
        log.info('Concurrent QB update won the race, skipping (stale SyncToken)', {
          pipedriveId: data.id,
          qbCustomerId,
        });
      }
    }
  } else {
    // Search by email first (most reliable identity match)
    let existingCustomer = primaryEmail
      ? await qb.searchCustomerByEmail(primaryEmail)
      : null;

    // Fall back to display name. Only meaningful for full names — a
    // single-token search like "Sam" would either miss the right customer
    // or match a wrong one, so we use the disambiguated form.
    if (!existingCustomer) {
      existingCustomer = await qb.searchCustomerByName(qbDisplayName);
    }

    if (existingCustomer && existingCustomer.Id) {
      // Link existing customer
      qbCustomerId = existingCustomer.Id;
      // storePipedriveToQbMapping stores bidirectionally
      await storePipedriveToQbMapping(String(data.id), qbCustomerId);
      await pd.setPersonCustomField(
        data.id,
        PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID,
        qbCustomerId
      );
      log.info('Linked existing QuickBooks customer', {
        pipedriveId: data.id,
        qbCustomerId,
      });
    } else {
      // Create new customer in QuickBooks
      let newCustomer: { Id?: string } | null = null;
      try {
        newCustomer = await qb.createCustomer({
          displayName: qbDisplayName,
          firstName,
          lastName: lastName || undefined,
          companyName: company,
          email: primaryEmail,
          phone: e164Phone,
        });
        log.info('Created new QuickBooks customer', {
          pipedriveId: data.id,
          qbCustomerId: newCustomer.Id,
          displayName: qbDisplayName,
        });
      } catch (error) {
        // Duplicate name (6240): either a concurrent invocation created the
        // customer between our search and this create (Pipedrive fires
        // person.added + person.updated near-simultaneously for new leads),
        // or the name belongs to an inactive customer, which the plain
        // search can't see but QB's uniqueness constraint still spans.
        // Recover by re-searching including inactive and linking instead.
        if (!isQbErrorCode(error, '6240')) throw error;
        const existing = await qb.searchCustomerByName(qbDisplayName, {
          includeInactive: true,
        });
        if (!existing || !existing.Id) throw error;
        if (existing.Active === false) {
          await qb.updateCustomer(existing.Id, {
            SyncToken: existing.SyncToken ?? '0',
            Active: true,
            DisplayName: qbDisplayName,
            GivenName: firstName,
            FamilyName: lastName || undefined,
            CompanyName: company,
            PrimaryEmailAddr: primaryEmail ? { Address: primaryEmail } : undefined,
            PrimaryPhone: { FreeFormNumber: e164Phone },
          });
        }
        newCustomer = existing;
        log.info('Recovered from QB duplicate-name (6240), linked existing customer', {
          pipedriveId: data.id,
          qbCustomerId: existing.Id,
          displayName: qbDisplayName,
          reactivated: existing.Active === false,
        });
      }

      qbCustomerId = newCustomer.Id || null;
      if (qbCustomerId) {
        // storePipedriveToQbMapping stores bidirectionally
        await storePipedriveToQbMapping(String(data.id), qbCustomerId);
        await pd.setPersonCustomField(
          data.id,
          PIPEDRIVE_CROSS_SYSTEM_FIELDS.QB_CUSTOMER_ID,
          qbCustomerId
        );
      }
    }
  }

  return qbCustomerId;
}
