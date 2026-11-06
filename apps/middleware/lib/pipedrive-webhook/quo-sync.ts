/**
 * Pipedrive person → Quo contact sync: update the linked contact, link an
 * existing one by externalId, or create it under a per-phone lock.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { PIPEDRIVE_CROSS_SYSTEM_FIELDS } from '@aac/api-clients/pipedrive';
import {
  storeIdMapping,
  getQuoIdFromPipedrive,
  tryAcquireContactCreateLock,
} from '../redis.js';
import type { PersonSyncContext } from './types.js';

const log = createLogger('pipedrive-webhook');

/** Returns the Quo contact id, or null when none could be linked or created. */
export async function syncPersonToQuo(ctx: PersonSyncContext): Promise<string | null> {
  const { data, e164Phone, pd, quo } = ctx;
  const { firstName, lastName, company, jobTitle, primaryEmail } = ctx.person;

  // Check Redis cache first, then fall back to Pipedrive custom field
  let quoContactId = await getQuoIdFromPipedrive(String(data.id));
  if (!quoContactId) {
    quoContactId = await pd.getPersonCustomField(
      data.id,
      PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID
    );
    if (quoContactId) {
      // Re-populate Redis cache
      await storeIdMapping(String(data.id), quoContactId);
      log.debug('Restored Quo mapping from Pipedrive field', {
        pipedriveId: data.id,
        quoId: quoContactId,
      });
    }
  }

  if (quoContactId) {
    // Update existing contact
    log.info('Updating existing Quo contact', {
      pipedriveId: data.id,
      quoId: quoContactId,
    });

    await quo.updateContact(quoContactId, {
      defaultFields: {
        firstName,
        lastName: lastName || undefined,
        company,
        role: jobTitle,
        phoneNumbers: [{ value: e164Phone, name: 'mobile' }],
        emails: primaryEmail ? [{ value: primaryEmail, name: 'email' }] : undefined,
      },
    });
  } else {
    // Look up Quo contact by externalId only (O(1)). We deliberately
    // skip the slow phone-scan fallback: at ~9,000+ contacts it times
    // out the Vercel function before any sync can complete, which was
    // silently breaking every new lead. Trade-off: if a Quo contact
    // already exists for this phone without externalId set, we'll
    // create a duplicate. The externalId backfill closes that gap
    // for all legacy contacts.
    const existingContact = await quo.findContactByExternalId(e164Phone);

    if (existingContact) {
      // Link existing contact
      quoContactId = existingContact.id;
      await storeIdMapping(String(data.id), quoContactId);
      await pd.setPersonCustomField(
        data.id,
        PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID,
        quoContactId
      );

      // Update with latest info
      await quo.updateContact(quoContactId, {
        defaultFields: {
          firstName,
          lastName: lastName || undefined,
          company,
          role: jobTitle,
          emails: primaryEmail ? [{ value: primaryEmail, name: 'email' }] : undefined,
        },
      });

      log.info('Linked existing Quo contact', {
        pipedriveId: data.id,
        quoId: quoContactId,
      });
    } else {
      // Acquire a lock before creating to prevent duplicate contacts
      // when multiple Pipedrive webhooks fire simultaneously
      const gotLock = await tryAcquireContactCreateLock('quo', e164Phone);

      if (!gotLock) {
        // Another handler is creating for this phone — wait and re-search
        log.info('Contact create lock held by another handler, waiting', {
          pipedriveId: data.id,
          phone: e164Phone,
        });
        await new Promise((r) => setTimeout(r, 2000));
        const retryContact = await quo.findContactByExternalId(e164Phone);
        if (retryContact) {
          quoContactId = retryContact.id;
          await storeIdMapping(String(data.id), quoContactId);
          await pd.setPersonCustomField(
            data.id,
            PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID,
            quoContactId
          );
          log.info('Found Quo contact after lock wait', {
            pipedriveId: data.id,
            quoId: quoContactId,
          });
        } else {
          log.warn('No Quo contact found after lock wait, skipping create', {
            pipedriveId: data.id,
            phone: e164Phone,
          });
        }
      } else {
        // We hold the lock — create the contact. Set externalId = E.164
        // phone so subsequent lookups go through findContactByExternalId
        // (O(1)) instead of paginating every Quo contact (O(N), times out
        // at ~30s once the contact list gets large).
        const newContact = await quo.createContact({
          defaultFields: {
            firstName,
            lastName: lastName || undefined,
            company,
            role: jobTitle,
            phoneNumbers: [{ value: e164Phone, name: 'mobile' }],
            emails: primaryEmail ? [{ value: primaryEmail, name: 'email' }] : undefined,
          },
          externalId: e164Phone,
          source: 'aac-middleware',
        });

        quoContactId = newContact.id;
        await storeIdMapping(String(data.id), quoContactId);
        await pd.setPersonCustomField(
          data.id,
          PIPEDRIVE_CROSS_SYSTEM_FIELDS.QUO_CONTACT_ID,
          quoContactId
        );

        log.info('Created new Quo contact', {
          pipedriveId: data.id,
          quoId: quoContactId,
        });
      }
    }
  }

  return quoContactId;
}
