/**
 * Find or create the Pipedrive person behind a Quo customer phone.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import { getPipedriveIdFromPhone, storePhoneMapping } from '../redis.js';
import { ensureInboundLeadDeal } from '../inbound-deal.js';

const log = createLogger('quo-webhook');

/**
 * Resolve the PD person id for a phone: Redis cache, then PD search, then
 * create an "Unknown Lead" (plus its Lead-stage deal). Errors other than
 * the soft deal-creation failure propagate to the caller.
 */
export async function findOrCreatePipedrivePerson(
  pd: PipedriveClient,
  e164Phone: string,
): Promise<number> {
  let pipedrivePersonId: number | null = null;

  const cachedId = await getPipedriveIdFromPhone(e164Phone);
  if (cachedId) {
    pipedrivePersonId = parseInt(cachedId, 10);
    log.debug('Found person ID in cache', {
      phone: e164Phone,
      personId: pipedrivePersonId,
    });
  }

  if (!pipedrivePersonId) {
    const existingPerson = await pd.searchPersonByPhone(e164Phone);

    if (existingPerson) {
      pipedrivePersonId = existingPerson.id;
      await storePhoneMapping(e164Phone, String(pipedrivePersonId));
      log.info('Found existing Pipedrive person', {
        phone: e164Phone,
        personId: pipedrivePersonId,
      });
    }
  }

  if (!pipedrivePersonId) {
    log.info('Creating Unknown Lead', { phone: e164Phone });

    const newPerson = await pd.createPerson(`Unknown Lead ${e164Phone}`, e164Phone);

    pipedrivePersonId = newPerson.id;
    await storePhoneMapping(e164Phone, String(pipedrivePersonId));

    log.info('Created Unknown Lead', {
      phone: e164Phone,
      personId: pipedrivePersonId,
    });

    // Stamp a Lead-stage deal so the agent's deal spine has the inbound
    // signal from the start. Idempotent via external_id; failures are
    // surfaced to /api/health but never break the webhook.
    try {
      await ensureInboundLeadDeal(pd, pipedrivePersonId, e164Phone);
    } catch (error) {
      // Soft failure: the deal spine is downstream of the user's actual
      // signal — the nightly deal-reconcile cron sweeps any missed
      // inbound-lead deals. Log here for observability; don't page Matt.
      log.error('Inbound lead deal creation failed', error as Error, {
        personId: pipedrivePersonId,
        phone: e164Phone,
      });
    }
  }

  return pipedrivePersonId;
}
