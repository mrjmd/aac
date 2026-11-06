/**
 * Quo (OpenPhone) Webhook Handler
 *
 * Triggers: call.completed, message.received, message.delivered, call.transcript.completed
 * Actions:
 *   1. Find or create Pipedrive contact for the phone number
 *   2. Log the call/SMS as an activity on the contact
 *   3. AI entity extraction from messages and transcripts
 *
 * Note: Creating an "Unknown Lead" in Pipedrive will trigger the
 * Pipedrive webhook, which syncs back to Quo. The Pipedrive webhook
 * uses loop prevention (system user ID) to avoid infinite loops.
 *
 * Uses Web Standard API handler format (export POST) to get reliable
 * raw body access via request.text() for HMAC signature verification.
 * This matches how the old Next.js App Router handler worked.
 */

import { isInternalPhone, normalizePhone } from '@aac/shared-utils/phone';
import { createLogger } from '@aac/shared-utils/logger';
import { verifyOpenPhoneWebhookSignature } from '@aac/shared-utils/webhook-signature';
import {
  markEventProcessed,
  trackWebhookProcessed,
  logHealthError,
  scheduleIntakeDraft,
  scheduleInboundSettle,
} from '../../lib/redis.js';
import { defer } from '../../lib/defer.js';
import { getEnv } from '../../lib/env.js';
import type { QuoEventType, QuoWebhookPayload } from '../../lib/quo-webhook/types.js';
import { extractRemotePhone } from '../../lib/quo-webhook/event-content.js';
import { enqueueQuoteTriggers, TECHNICIAN_PHONES } from '../../lib/quo-webhook/quote-triggers.js';
import { syncCustomer } from '../../lib/quo-webhook/sync-customer.js';

const log = createLogger('quo-webhook');

/**
 * Helper to create JSON responses
 */
function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Web Standard API handler — export named POST function
 * Uses request.text() for raw body access (same as Next.js App Router)
 */
export async function POST(request: Request): Promise<Response> {
  const env = getEnv();

  // ============================================
  // SIGNATURE VERIFICATION
  // ============================================
  // request.text() gives us the raw body bytes — critical for HMAC
  const rawBody = await request.text();
  const signature = request.headers.get('openphone-signature') || undefined;

  if (!verifyOpenPhoneWebhookSignature(rawBody, signature, env.quo.webhookSecret)) {
    // Fallback: try re-serialized body in case edge middleware consumed/re-encoded the raw body
    let fallbackPassed = false;
    try {
      const reserialized = JSON.stringify(JSON.parse(rawBody));
      if (reserialized !== rawBody) {
        fallbackPassed = verifyOpenPhoneWebhookSignature(reserialized, signature, env.quo.webhookSecret);
      }
    } catch {
      // rawBody wasn't valid JSON, fallback not applicable
    }

    if (!fallbackPassed) {
      log.warn('Invalid webhook signature', {
        bodyLength: rawBody.length,
        hasSignature: !!signature,
        signaturePrefix: signature?.substring(0, 30),
      });
      return json({ error: 'Invalid signature' }, 401);
    }
  }

  let payload: QuoWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('Invalid JSON payload');
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Handle both wrapped and unwrapped payload formats
  const rawPayload = payload as unknown as Record<string, unknown>;

  let event: QuoWebhookPayload['object'];
  if (rawPayload?.object && typeof rawPayload.object === 'object') {
    event = rawPayload.object as QuoWebhookPayload['object'];
  } else if (rawPayload?.id && rawPayload?.type) {
    event = rawPayload as unknown as QuoWebhookPayload['object'];
  } else {
    log.warn('Invalid payload structure', {
      keys: Object.keys(rawPayload || {}),
    });
    return json({ error: 'Invalid payload' }, 400);
  }

  if (!event?.id || !event?.type || !event?.data?.object) {
    log.warn('Invalid event structure', {
      hasId: !!event?.id,
      hasType: !!event?.type,
      hasData: !!event?.data,
    });
    return json({ error: 'Invalid payload' }, 400);
  }

  const eventData = event.data.object;

  log.info('Received Quo webhook', {
    eventId: event.id,
    type: event.type,
  });

  // ============================================
  // FILTER EVENTS
  // ============================================
  const allowedEvents: QuoEventType[] = [
    'call.completed',
    'message.received',
    'message.delivered',
    'call.transcript.completed',
  ];
  if (!allowedEvents.includes(event.type)) {
    log.debug('Ignoring event type', { type: event.type });
    return json({ status: 'ignored', reason: 'event_type' });
  }

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    const isNew = await markEventProcessed('quo', event.id);
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId: event.id });
      return json({ status: 'ignored', reason: 'duplicate' });
    }

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractRemotePhone(eventData);
    if (!rawPhone) {
      log.warn('Could not extract remote phone', { eventId: event.id });
      return json({ status: 'skipped', reason: 'no_phone' });
    }

    const e164Phone = normalizePhone(rawPhone);
    if (!e164Phone) {
      log.warn('Invalid phone number', { rawPhone });
      return json({ status: 'skipped', reason: 'invalid_phone' });
    }

    // ============================================
    // QUOTE TRIGGER ENQUEUE (photo-quote-training Phase 6)
    // Enqueue-only — all filtering/debounce/classification happens in the
    // out-of-band runner. Fire-safe: never affects webhook processing.
    // ============================================
    await enqueueQuoteTriggers(event, eventData, e164Phone);

    // ============================================
    // INTERNAL NUMBERS STOP HERE
    // Matt↔Ed, Matt↔Mike, and the business line itself (Ed's line texting
    // it) are not customers. Past this point everything treats the remote
    // phone as a customer: PD person sync, AI extraction, and scheduling
    // dispatch, which minted holds/stubs (with Mike invited) from internal
    // texts like "can we move our meeting to 2pm" (2026-11-04/05). The
    // quote-trigger enqueue above stays: T2 needs Mike's debrief calls.
    // ============================================
    if (isInternalPhone(e164Phone, env.quo.phoneNumber) || TECHNICIAN_PHONES.has(e164Phone)) {
      log.info('Internal number, skipping customer pipeline', { eventId: event.id, type: event.type });
      await trackWebhookProcessed('quo');
      return json({ status: 'skipped', reason: 'internal_phone' });
    }

    // ============================================
    // FIRST-TOUCH INTAKE SCHEDULING (message-drafts)
    // Start the 10-min preemption window (INTAKE_REPLY_WINDOW_MIN in
    // @aac/message-drafts) the moment a first inbound lands — the worker
    // tick drains it exactly on time instead of a sweep finding it up to
    // 10 min late. ZADD NX: burst texts don't reset the window. The
    // worker re-validates everything (Matt replied, spam, internal, …).
    // ============================================
    if (
      event.type === 'message.received' ||
      (event.type === 'call.completed' && eventData.direction === 'incoming' && !(eventData.duration ?? 0) && !eventData.answeredAt)
    ) {
      await scheduleIntakeDraft(e164Phone, Date.now() + 10 * 60_000);
      // Inbound router (shadow): read the burst once it goes quiet.
      await scheduleInboundSettle(e164Phone, Date.now());
    }

    // ============================================
    // CUSTOMER SYNC (deferred — ack-fast)
    // Pipedrive person/activity sync, AI entity extraction and scheduling
    // dispatch all wait on Pipedrive/Gemini/Calendar. A slow one is how the
    // 2026-10-19 timeout → webhook auto-disable incident happened, so they
    // run after the response, in the same order and with the same error
    // handling as before.
    // ============================================
    defer(syncCustomer(event, eventData, e164Phone));

    return json({ status: 'accepted', eventType: event.type });
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId: event.id });

    await logHealthError('quo', (error as Error).message, { eventId: event.id });

    return json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
