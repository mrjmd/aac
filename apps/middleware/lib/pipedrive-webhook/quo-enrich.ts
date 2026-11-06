/**
 * After both syncs: stamp the Quo contact with the QuickBooks customer
 * link and the formatted address (Quo custom fields).
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { QuoClient } from '@aac/api-clients/quo';
import type { PipedrivePersonPayload } from './types.js';
import { logHealthError } from '../redis.js';

const log = createLogger('pipedrive-webhook');

// Quo custom field keys (from GET /contact-custom-fields)
const QUO_CUSTOM_FIELDS = {
  ADDRESS: '1725478449101',
  QUICKBOOKS: '69c6ac9e7d6fcf298f2a1cbc',
} as const;

/**
 * Write the QB link and address custom fields. Never throws: a failure is
 * logged and surfaced to /api/health without failing the webhook.
 */
export async function enrichQuoContact(
  quo: QuoClient,
  data: PipedrivePersonPayload,
  quoContactId: string,
  qbCustomerId: string | null,
  formattedAddress: string | undefined,
): Promise<void> {
  try {
    const customFields: Array<{ key: string; value: string }> = [];

    if (qbCustomerId) {
      customFields.push({
        key: QUO_CUSTOM_FIELDS.QUICKBOOKS,
        value: `https://app.qbo.intuit.com/app/customerdetail?nameId=${qbCustomerId}`,
      });
    }

    if (formattedAddress) {
      customFields.push({
        key: QUO_CUSTOM_FIELDS.ADDRESS,
        value: formattedAddress,
      });
    }

    await quo.updateContact(quoContactId, { customFields });
    log.info('Enriched Quo contact with custom fields', {
      quoId: quoContactId,
      fields: customFields.map((f) => f.key),
    });
  } catch (error) {
    // Don't fail the webhook if custom field enrichment fails
    log.error('Quo custom field enrichment failed', error as Error, {
      quoId: quoContactId,
      pipedriveId: data.id,
    });
    // Surface this in the health endpoint so we can see it
    await logHealthError('pipedrive', `Quo enrichment failed: ${(error as Error).message}`, {
      quoId: quoContactId,
      pipedriveId: String(data.id),
    });
  }
}
