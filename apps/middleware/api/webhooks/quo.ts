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
 * This handler uses Edge Runtime to access the Web API Request object,
 * which provides .text() for reading the raw body needed for HMAC
 * signature verification. The Node.js serverless runtime's bodyParser
 * config was not reliably disabling parsing in this monorepo setup.
 */

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

export const config = {
  runtime: 'edge',
};

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
 * Verify webhook signature from Quo/OpenPhone using Web Crypto API
 *
 * Header format: hmac;1;<timestamp>;<base64-signature>
 * Signed data: <timestamp>.<json-payload>
 * Secret: base64-encoded, must decode to binary for HMAC
 */
async function verifySignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string
): Promise<boolean> {
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
  const signingKeyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));

  // Import key for Web Crypto API
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    signingKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Compute HMAC-SHA256
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(signedData)
  );

  // Encode as base64
  const computedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBytes))
  );

  // Constant-time comparison
  if (providedSignature.length !== computedSignature.length) return false;

  let mismatch = 0;
  for (let i = 0; i < providedSignature.length; i++) {
    mismatch |= providedSignature.charCodeAt(i) ^ computedSignature.charCodeAt(i);
  }
  return mismatch === 0;
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
    // Get only entries from external caller (no userId)
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
 * Rules: Only inbound messages/transcripts with sufficient content
 */
function shouldProcessForAI(
  eventType: QuoEventType,
  eventData: QuoWebhookPayload['object']['data']['object']
): boolean {
  // Only process inbound messages and transcripts
  if (eventType === 'message.delivered') return false; // Outbound SMS
  if (eventType === 'call.completed') return false; // Call without transcript

  // For transcripts, always process (external caller initiated)
  if (eventType === 'call.transcript.completed') {
    // Check if we have dialogue from external caller
    if (eventData.dialogue) {
      const externalDialogue = eventData.dialogue.filter((entry) => !entry.userId);
      if (externalDialogue.length === 0) return false;
    }
  }

  // Get the text content
  const text = extractTextForAI(eventData);

  // Skip trivial content
  if (text.length < MIN_MESSAGE_LENGTH) return false;

  return true;
}

/**
 * Extract the remote (external) phone number from the event data
 * For incoming: it's the "from" number
 * For outgoing: it's the "to" number
 * For transcripts: find dialogue entries without userId (external caller)
 */
function extractRemotePhone(
  eventData: QuoWebhookPayload['object']['data']['object']
): string | null {
  // For transcripts, extract from dialogue entries
  if (eventData.object === 'callTranscript' && eventData.dialogue) {
    // Find an entry from the external caller (no userId = not internal user)
    const externalEntry = eventData.dialogue.find((entry) => !entry.userId);
    if (externalEntry) {
      return externalEntry.identifier || null;
    }
    return null;
  }

  // For messages and calls, use from/to based on direction
  if (eventData.direction === 'incoming') {
    return eventData.from || null;
  } else {
    return eventData.to || null;
  }
}

/**
 * Helper to create JSON responses (Edge Runtime uses Web API Response)
 */
function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main webhook handler (Edge Runtime — uses Web API Request for raw body access)
 */
export default async function handler(request: Request) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const env = getEnv();

  // ============================================
  // SIGNATURE VERIFICATION
  // ============================================
  // Read raw body using Web API — preserves exact bytes for HMAC
  const rawBody = await request.text();
  const signature = request.headers.get('openphone-signature') || undefined;

  if (!(await verifySignature(rawBody, signature, env.quo.webhookSecret))) {
    // Fallback: try re-serialized body in case edge middleware consumed/re-encoded the raw body
    let fallbackPassed = false;
    try {
      const reserialized = JSON.stringify(JSON.parse(rawBody));
      if (reserialized !== rawBody) {
        fallbackPassed = await verifySignature(reserialized, signature, env.quo.webhookSecret);
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
      return jsonResponse({ error: 'Invalid signature' }, 401);
    }
  }

  let payload: QuoWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('Invalid JSON payload');
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  // Handle both wrapped and unwrapped payload formats
  // Wrapped: { object: { id, type, data: { object: {...} } } }
  // Unwrapped: { id, type, data: { object: {...} } }
  const rawPayload = payload as unknown as Record<string, unknown>;

  // Detect format and normalize
  let event: QuoWebhookPayload['object'];
  if (rawPayload?.object && typeof rawPayload.object === 'object') {
    // Wrapped format
    event = rawPayload.object as QuoWebhookPayload['object'];
  } else if (rawPayload?.id && rawPayload?.type) {
    // Unwrapped format - payload IS the event
    event = rawPayload as unknown as QuoWebhookPayload['object'];
  } else {
    log.warn('Invalid payload structure', {
      keys: Object.keys(rawPayload || {}),
    });
    return jsonResponse({ error: 'Invalid payload' }, 400);
  }

  // Validate event has required fields
  if (!event?.id || !event?.type || !event?.data?.object) {
    log.warn('Invalid event structure', {
      hasId: !!event?.id,
      hasType: !!event?.type,
      hasData: !!event?.data,
    });
    return jsonResponse({ error: 'Invalid payload' }, 400);
  }

  const eventData = event.data.object;

  log.info('Received Quo webhook', {
    eventId: event.id,
    type: event.type,
  });

  // ============================================
  // FILTER EVENTS
  // ============================================
  // Process calls, messages (both directions), and transcripts
  const allowedEvents: QuoEventType[] = [
    'call.completed',
    'message.received',
    'message.delivered',
    'call.transcript.completed',
  ];
  if (!allowedEvents.includes(event.type)) {
    log.debug('Ignoring event type', { type: event.type });
    return jsonResponse({ status: 'ignored', reason: 'event_type' });
  }

  try {
    // ============================================
    // DEDUPLICATION
    // ============================================
    const isNew = await markEventProcessed('quo', event.id);
    if (!isNew) {
      log.info('Duplicate event ignored', { eventId: event.id });
      return jsonResponse({ status: 'ignored', reason: 'duplicate' });
    }

    // ============================================
    // EXTRACT & VALIDATE PHONE
    // ============================================
    const rawPhone = extractRemotePhone(eventData);
    if (!rawPhone) {
      log.warn('Could not extract remote phone', { eventId: event.id });
      return jsonResponse({ status: 'skipped', reason: 'no_phone' });
    }

    const e164Phone = normalizePhone(rawPhone);
    if (!e164Phone) {
      log.warn('Invalid phone number', { rawPhone });
      return jsonResponse({ status: 'skipped', reason: 'invalid_phone' });
    }

    // ============================================
    // FIND OR CREATE PIPEDRIVE PERSON
    // ============================================
    const pd = getPipedrive();
    let pipedrivePersonId: number | null = null;

    // Check cache first
    const cachedId = await getPipedriveIdFromPhone(e164Phone);
    if (cachedId) {
      pipedrivePersonId = parseInt(cachedId, 10);
      log.debug('Found person ID in cache', {
        phone: e164Phone,
        personId: pipedrivePersonId,
      });
    }

    // If not cached, search Pipedrive
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

    // If still not found, create "Unknown Lead"
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
      // Format transcript dialogue for activity note
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
          // Build name from extracted entities
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

          // Incrementally update Pipedrive (only add new fields)
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
        // Don't fail the webhook if AI extraction fails
        log.error('AI entity extraction failed', error as Error, {
          personId: pipedrivePersonId,
        });
      }
    }

    // Track successful processing for health dashboard
    await trackWebhookProcessed('quo');

    return jsonResponse({
      status: 'processed',
      pipedrivePersonId,
      eventType: event.type,
    });
  } catch (error) {
    log.error('Webhook processing failed', error as Error, { eventId: event.id });

    // Log error for health dashboard
    await logHealthError('quo', (error as Error).message, { eventId: event.id });

    // Return 200 to acknowledge receipt
    return jsonResponse({
      status: 'error',
      message: 'Processing failed, logged for investigation',
    });
  }
}
