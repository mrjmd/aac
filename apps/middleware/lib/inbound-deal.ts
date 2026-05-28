import { createLogger } from '@aac/shared-utils/logger';
import type { PipedriveClient, PipedriveDeal } from '@aac/api-clients/pipedrive';

const log = createLogger('inbound-deal');

/**
 * Invariant: every PD person created from an inbound signal (text / call /
 * web form) has exactly one Lead-stage deal stamped with
 * `external_id = pd-person-{personId}`. The external_id is the dedup key so
 * re-running this for the same person is a no-op.
 *
 * Returns the existing or newly-created deal. Throws on PD API errors —
 * caller decides whether to swallow or surface.
 */
export async function ensureInboundLeadDeal(
  pipedrive: PipedriveClient,
  personId: number,
  phone: string,
): Promise<PipedriveDeal> {
  const externalId = `pd-person-${personId}`;

  const existing = await pipedrive.findDealByExternalId(externalId);
  if (existing) {
    log.debug('Inbound lead deal already exists', {
      personId,
      dealId: existing.id,
      externalId,
    });
    return existing;
  }

  const deal = await pipedrive.createDeal({
    title: `Inbound lead ${phone}`,
    personId,
    stage: 'lead',
    externalId,
  });

  log.info('Created inbound lead deal', {
    personId,
    dealId: deal.id,
    externalId,
  });

  return deal;
}
