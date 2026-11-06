/**
 * Pipedrive Webhook Handler
 *
 * Triggers: person.added, person.updated
 * Actions:
 *   1. Sync contact to Quo (OpenPhone)
 *   2. Sync contact to QuickBooks Online
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { normalizePhone } from '@aac/shared-utils/phone';
import { createLogger } from '@aac/shared-utils/logger';
import {
  markEventProcessed,
  storePhoneMapping,
  trackWebhookProcessed,
  logHealthError,
} from '../../lib/redis.js';
import { getPipedrive, getQuo, getQuickBooks } from '../../lib/clients.js';
import { getEnv } from '../../lib/env.js';
import type { PersonSyncContext, PipedriveWebhookPayload } from '../../lib/pipedrive-webhook/types.js';
import { verifyPdWebhookAuth } from '../../lib/pipedrive-webhook/auth.js';
import { extractPrimaryPhone, loadPersonSyncData } from '../../lib/pipedrive-webhook/person-data.js';
import { syncPersonToQuo } from '../../lib/pipedrive-webhook/quo-sync.js';
import { syncPersonToQuickBooks } from '../../lib/pipedrive-webhook/qb-sync.js';
import { enrichQuoContact } from '../../lib/pipedrive-webhook/quo-enrich.js';

const log = createLogger('pipedrive-webhook');

/**
 * Main webhook handler
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // This endpoint writes into Quo/QB/Redis, so forged payloads are a real
  // poisoning vector. Fail closed in production when the credentials are
  // not configured (same convention as the QB webhook's 503).
  const env = getEnv();
  const { webhookUser, webhookPass } = env.pipedrive;
  if (!webhookUser || !webhookPass) {
    if (env.nodeEnv === 'production') {
      log.error('Pipedrive webhook hit but auth not configured', new Error('not_configured'));
      return res.status(503).json({ error: 'webhook not configured' });
    }
  } else if (!verifyPdWebhookAuth(req.headers.authorization, webhookUser, webhookPass)) {
    log.warn('Pipedrive webhook auth failed — invalid or missing Basic credentials');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body as PipedriveWebhookPayload;

  // Basic validation
  if (!payload?.meta || !payload.data) {
    log.warn('Invalid payload received', {
      hasBody: !!payload,
      keys: Object.keys(payload || {}),
      metaKeys: payload?.meta ? Object.keys(payload.meta) : 'no meta',
      dataKeys: payload?.data ? Object.keys(payload.data) : 'no data',
    });
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { meta, data } = payload;
  const eventId = `${meta.webhook_id}-${meta.id}-${meta.timestamp}`;

  log.info('Received Pipedrive webhook', {
    eventId,
    action: meta.action,
    personId: data.id,
    userId: meta.user_id,
  });

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    const dedupStart = Date.now();
    const isNew = await markEventProcessed('pipedrive', eventId);
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId });
      return res.status(200).json({ status: 'ignored', reason: 'duplicate' });
    }
    log.info('Phase: dedup', { elapsed: Date.now() - dedupStart });

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractPrimaryPhone(data.phones);
    if (!rawPhone) {
      log.info('No phone number on person, skipping', { personId: data.id });
      return res.status(200).json({ status: 'skipped', reason: 'no_phone' });
    }

    const e164Phone = normalizePhone(rawPhone);
    if (!e164Phone) {
      log.warn('Invalid phone number, skipping', { personId: data.id, rawPhone });
      return res.status(200).json({ status: 'skipped', reason: 'invalid_phone' });
    }

    const startTime = Date.now();

    // Store phone -> Pipedrive mapping for quick lookups later
    await storePhoneMapping(e164Phone, String(data.id));

    // ============================================
    // SHARED DATA FETCH
    // ============================================
    const pd = getPipedrive();
    const quo = getQuo();
    const qb = getQuickBooks();

    const person = await loadPersonSyncData(pd, data);
    const { formattedAddress } = person;

    log.info('Phase: data-fetch', { elapsed: Date.now() - startTime });

    // ============================================
    // PARALLEL SYNC: QUO + QUICKBOOKS
    // ============================================
    const ctx: PersonSyncContext = { data, e164Phone, pd, quo, qb, person };

    const [quoResult, qbResult] = await Promise.allSettled([syncPersonToQuo(ctx), syncPersonToQuickBooks(ctx)]);

    const quoContactId = quoResult.status === 'fulfilled' ? quoResult.value : null;
    const qbCustomerId = qbResult.status === 'fulfilled' ? qbResult.value : null;

    // Surface sync failures in health:errors (→ error-surface SMS). These
    // were previously only log.error'd, which meant a hard Quo outage could
    // run for weeks without anyone being paged.
    if (quoResult.status === 'rejected') {
      log.error('Quo sync failed', quoResult.reason as Error, { pipedriveId: data.id });
      await logHealthError('pipedrive', `Quo sync failed: ${(quoResult.reason as Error).message}`, {
        pipedriveId: String(data.id),
      });
    }
    if (qbResult.status === 'rejected') {
      log.error('QuickBooks sync failed', qbResult.reason as Error, { pipedriveId: data.id });
      await logHealthError('pipedrive', `QuickBooks sync failed: ${(qbResult.reason as Error).message}`, {
        pipedriveId: String(data.id),
      });
    }

    log.info('Phase: sync-complete', { elapsed: Date.now() - startTime });

    // ============================================
    // ENRICH QUO CONTACT: QB Link + Address
    // ============================================
    if (quoContactId && (qbCustomerId || formattedAddress)) {
      await enrichQuoContact(quo, data, quoContactId, qbCustomerId, formattedAddress);
    }

    // Track successful processing for health dashboard
    await trackWebhookProcessed('pipedrive');

    return res.status(200).json({
      status: 'synced',
      pipedriveId: data.id,
      quoId: quoContactId,
      qbCustomerId,
    });
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId });

    // Log error for health dashboard
    await logHealthError('pipedrive', (error as Error).message, { eventId });

    // Return 200 to acknowledge receipt (prevent retries that could cause issues)
    // The error is logged for investigation
    return res.status(200).json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
