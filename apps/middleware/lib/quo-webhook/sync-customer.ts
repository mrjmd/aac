/**
 * The deferred half of the Quo webhook: everything that waits on
 * Pipedrive / Gemini / Calendar runs here, after the response.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { trackWebhookProcessed, logHealthError } from '../redis.js';
import { getEnv } from '../env.js';
import { getPipedrive } from '../clients.js';
import { findOrCreatePipedrivePerson } from './pd-person.js';
import { logQuoActivity } from './activity.js';
import { extractAndApplyEntities } from './entity-extraction.js';
import { deferSchedulingDispatch } from './scheduling.js';
import type { QuoEvent, QuoEventData } from './types.js';

const log = createLogger('quo-webhook');

/**
 * Pipedrive person + activity sync, AI entity extraction, and scheduling
 * dispatch for one customer event. Runs after the webhook has responded.
 * Failures are logged + surfaced to /api/health, never propagate.
 */
export async function syncCustomer(
  event: QuoEvent,
  eventData: QuoEventData,
  e164Phone: string,
): Promise<void> {
  const env = getEnv();
  try {
    // ============================================
    // FIND OR CREATE PIPEDRIVE PERSON
    // ============================================
    const pd = getPipedrive();
    const pipedrivePersonId = await findOrCreatePipedrivePerson(pd, e164Phone);

    // ============================================
    // LOG ACTIVITY
    // ============================================
    await logQuoActivity(pd, event, eventData, pipedrivePersonId);

    // ============================================
    // AI ENTITY EXTRACTION
    // ============================================
    await extractAndApplyEntities(pd, event, eventData, pipedrivePersonId, e164Phone);

    // ============================================
    // SCHEDULING-INTENT CLASSIFICATION (deferred — ack-fast)
    // ============================================
    deferSchedulingDispatch(pd, env, event, eventData, e164Phone, pipedrivePersonId);

    await trackWebhookProcessed('quo');
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId: event.id });
    await logHealthError('quo', (error as Error).message, { eventId: event.id });
  }
}
