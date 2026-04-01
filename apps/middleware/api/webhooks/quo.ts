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

import crypto from 'crypto';
import { normalizePhone } from '@aac/shared-utils/phone';
import { createLogger } from '@aac/shared-utils/logger';
import { GeminiClient } from '@aac/api-clients/gemini';
import {
  markEventProcessed,
  getPipedriveIdFromPhone,
  storePhoneMapping,
  trackWebhookProcessed,
  logHealthError,
} from '../../lib/redis.js';
import { getEnv } from '../../lib/env.js';
import { getPipedrive, getGemini } from '../../lib/clients.js';

const log = createLogger('quo-webhook');

// Quo webhook event types we handle
type QuoEventType =
  | 'call.completed'
  | 'call.ringing'
  | 'message.received'
  | 'message.delivered'
  | 'call.transcript.completed';

// Dialogue entry in a call transcript
interface TranscriptDialogueEntry {
  start: number;
  end: number;
  content: string;
  identifier: string; // Phone number E.164
  userId?: string; // Present if from internal user, absent if from external caller
}

// Quo webhook payload structure (API v3)
// Wrapped in "object" with nested "data.object"
interface QuoWebhookPayload {
  object: {
    id: string; // Event ID for deduplication
    type: QuoEventType;
    createdAt: string;
    apiVersion: string;
    data: {
      object: {
        // Common fields
        id: string;
        object: 'message' | 'call' | 'callTranscript';
        createdAt: string;

        // For messages and calls
        direction?: 'incoming' | 'outgoing';
        from?: string; // E.164 phone
        to?: string; // E.164 phone
        userId?: string;
        phoneNumberId?: string;
        conversationId?: string;

        // For messages
        body?: string;
        media?: Array<{ url: string; type: string }>;
        status?: 'received' | 'sent' | 'delivered' | 'queued';

        // For calls
        duration?: number; // seconds
        recordingUrl?: string;
        voicemailUrl?: string;
        answeredAt?: string;

        // For transcripts
        callId?: string; // Reference to original call
        dialogue?: TranscriptDialogueEntry[];
      };
      deepLink?: string;
    };
  };
}

/**
 * Verify webhook signature from Quo/OpenPhone
 *
 * Header format: hmac;1;<timestamp>;<base64-signature>
 * Signed data: <timestamp>.<json-payload>
 * Secret: base64-encoded, must decode to binary for HMAC
 */
function verifySignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  // Parse header: hmac;1;timestamp;signature
  const parts = signatureHeader.split(';');
  if (parts.length !== 4) {
    log.warn('Invalid signature header format', { parts: parts.length });
    return false;
  }

  const [scheme, version, timestamp, providedSignature] = parts;

  if (scheme !== 'hmac' || version !== '1') {
    log.warn('Unsupported signature scheme/version', { scheme, version });
    return false;
  }

  // Prepare signed data: timestamp.payload
  const signedData = `${timestamp}.${payload}`;

  // Decode secret from base64 to binary
  const signingKey = Buffer.from(secret, 'base64');

  // Compute HMAC-SHA256 and encode as base64
  const computedSignature = crypto
    .createHmac('sha256', signingKey)
    .update(signedData)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedSignature),
      Buffer.from(computedSignature)
    );
  } catch {
    return false;
  }
}

// Minimum message length for AI processing (skip trivial messages)
const MIN_MESSAGE_LENGTH = 10;

/**
 * Extract text content from event data for AI processing
 * For messages: returns body
 * For transcripts: returns formatted dialogue from external caller only
 */
function extractTextForAI(
  eventData: QuoWebhookPayload['object']['data']['object']
): string {
  // For transcripts, extract just the external caller's dialogue
  if (eventData.object === 'callTranscript' && eventData.dialogue) {
    const externalDialogue = eventData.dialogue
      .filter((entry) => !entry.userId)
      .map((entry) => entry.content)
      .join(' ');
    return externalDialogue;
  }

  // For messages, use body
  return eventData.body || '';
}

/**
 * Check if a message should be processed by AI for entity extraction
 */
function shouldProcessForAI(
  eventType: QuoEventType,
  eventData: QuoWebhookPayload['object']['data']['object']
): boolean {
  if (eventType === 'message.delivered') return false;
  if (eventType === 'call.completed') return false;

  if (eventType === 'call.transcript.completed') {
    if (eventData.dialogue) {
      const externalDialogue = eventData.dialogue.filter((entry) => !entry.userId);
      if (externalDialogue.length === 0) return false;
    }
  }

  const text = extractTextForAI(eventData);
  if (text.length < MIN_MESSAGE_LENGTH) return false;

  return true;
}

/**
 * Extract the remote (external) phone number from the event data
 */
function extractRemotePhone(
  eventData: QuoWebhookPayload['object']['data']['object']
): string | null {
  if (eventData.object === 'callTranscript' && eventData.dialogue) {
    const externalEntry = eventData.dialogue.find((entry) => !entry.userId);
    if (externalEntry) {
      return externalEntry.identifier || null;
    }
    return null;
  }

  if (eventData.direction === 'incoming') {
    return eventData.from || null;
  } else {
    return eventData.to || null;
  }
}

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

  if (!verifySignature(rawBody, signature, env.quo.webhookSecret)) {
    // Fallback: try re-serialized body in case edge middleware consumed/re-encoded the raw body
    let fallbackPassed = false;
    try {
      const reserialized = JSON.stringify(JSON.parse(rawBody));
      if (reserialized !== rawBody) {
        fallbackPassed = verifySignature(reserialized, signature, env.quo.webhookSecret);
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
    // FIND OR CREATE PIPEDRIVE PERSON
    // ============================================
    const pd = getPipedrive();
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
    }

    // ============================================
    // LOG ACTIVITY
    // ============================================
    if (event.type === 'call.completed') {
      const direction = eventData.direction === 'incoming' ? 'Inbound' : 'Outbound';
      const duration = eventData.duration || 0;

      let note = `${direction} call`;
      if (eventData.recordingUrl) {
        note += `\n\nRecording: ${eventData.recordingUrl}`;
      }
      if (eventData.voicemailUrl) {
        note += `\n\nVoicemail: ${eventData.voicemailUrl}`;
      }

      await pd.logActivity(pipedrivePersonId, 'call', {
        subject: `${direction} Call (${Math.round(duration / 60)}m ${duration % 60}s)`,
        note,
        duration,
      });

      log.info('Logged call activity', {
        personId: pipedrivePersonId,
        duration,
      });
    }

    if (event.type === 'message.received' || event.type === 'message.delivered') {
      const messageBody = eventData.body || '(no content)';
      const truncatedBody =
        messageBody.length > 100 ? messageBody.substring(0, 100) + '...' : messageBody;

      const direction = event.type === 'message.received' ? 'Received' : 'Sent';

      await pd.logActivity(pipedrivePersonId, 'sms', {
        subject: `SMS ${direction}: "${truncatedBody}"`,
        note: `Full message:\n\n${messageBody}`,
      });

      log.info('Logged SMS activity', {
        personId: pipedrivePersonId,
        direction,
      });
    }

    if (event.type === 'call.transcript.completed') {
      let transcript = '(no transcript)';
      if (eventData.dialogue && eventData.dialogue.length > 0) {
        transcript = eventData.dialogue
          .map((entry) => {
            const speaker = entry.userId ? 'AAC' : 'Caller';
            return `${speaker}: ${entry.content}`;
          })
          .join('\n');
      }

      await pd.logActivity(pipedrivePersonId, 'call', {
        subject: 'Call Transcript Available',
        note: `Transcript:\n\n${transcript}`,
      });

      log.info('Logged transcript activity', { personId: pipedrivePersonId });
    }

    // ============================================
    // AI ENTITY EXTRACTION
    // ============================================
    if (shouldProcessForAI(event.type, eventData)) {
      const textContent = extractTextForAI(eventData);
      log.info('Processing for AI entity extraction', {
        personId: pipedrivePersonId,
        type: event.type,
        textLength: textContent.length,
      });

      try {
        const gemini = getGemini();
        const entities = await gemini.extractEntities(textContent);

        if (GeminiClient.hasUsefulEntities(entities)) {
          let extractedName: string | undefined;
          if (entities!.fullName) {
            extractedName = entities!.fullName;
          } else if (entities!.firstName && entities!.lastName) {
            extractedName = `${entities!.firstName} ${entities!.lastName}`;
          } else if (entities!.firstName) {
            extractedName = entities!.firstName;
          } else if (entities!.lastName) {
            extractedName = entities!.lastName;
          }

          const updateResult = await pd.updatePersonIncremental(pipedrivePersonId, {
            name: extractedName,
            phone: e164Phone,
            email: entities!.email || undefined,
            address: entities!.streetAddress || undefined,
            city: entities!.city || undefined,
            state: entities!.state || undefined,
            zipCode: entities!.zipCode || undefined,
          });

          if (updateResult.updated) {
            log.info('AI extracted and updated contact', {
              personId: pipedrivePersonId,
              fields: updateResult.fields,
              confidence: entities!.confidence,
            });
          }
        }
      } catch (error) {
        log.error('AI entity extraction failed', error as Error, {
          personId: pipedrivePersonId,
        });
      }
    }

    await trackWebhookProcessed('quo');

    return json({
      status: 'processed',
      pipedrivePersonId,
      eventType: event.type,
    });
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId: event.id });

    await logHealthError('quo', (error as Error).message, { eventId: event.id });

    return json({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
