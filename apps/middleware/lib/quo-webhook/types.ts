/**
 * Quo (OpenPhone) webhook payload types, shared by the handler in
 * api/webhooks/quo.ts and the per-concern modules beside this file.
 */

// Quo webhook event types we handle
export type QuoEventType =
  | 'call.completed'
  | 'call.ringing'
  | 'message.received'
  | 'message.delivered'
  | 'call.transcript.completed';

// Dialogue entry in a call transcript
export interface TranscriptDialogueEntry {
  start: number;
  end: number;
  content: string;
  identifier: string; // Phone number E.164
  userId?: string; // Present if from internal user, absent if from external caller
}

// Quo webhook payload structure (API v3)
// Wrapped in "object" with nested "data.object"
export interface QuoWebhookPayload {
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

/** The unwrapped event (payload.object). */
export type QuoEvent = QuoWebhookPayload['object'];

/** The event's resource (payload.object.data.object): message, call or transcript. */
export type QuoEventData = QuoWebhookPayload['object']['data']['object'];
