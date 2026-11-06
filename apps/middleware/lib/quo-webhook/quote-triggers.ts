/**
 * Quote-trigger enqueue for the Quo webhook (photo-quote-training Phase 6).
 * Enqueue-only: all filtering, debounce and classification happens in the
 * out-of-band runner. Runs in the ack path, before the internal-number
 * cut, because T2 needs Mike's debrief calls.
 */

import { enqueueQuoteTrigger } from '../redis.js';
import type { QuoEvent, QuoEventData } from './types.js';

/**
 * Technician phones whose completed call transcripts mark the T2 debrief
 * moment (quote-trigger). Mirrors TECHNICIAN_EMAILS; env-overridable.
 */
export const TECHNICIAN_PHONES = new Set(
  (process.env.TECHNICIAN_PHONES || '+18573126761').split(',').map((p) => p.trim()),
);

/**
 * Enqueue every quote trigger this event carries: messages (T1/T3),
 * technician debrief transcripts (T2), customer call transcripts (T4) and
 * missed incoming calls (possible voicemail).
 */
export async function enqueueQuoteTriggers(
  event: QuoEvent,
  eventData: QuoEventData,
  e164Phone: string,
): Promise<void> {
  if (event.type === 'message.received' || event.type === 'message.delivered') {
    await enqueueQuoteTrigger({
      phone: e164Phone,
      direction: event.type === 'message.received' ? 'incoming' : 'outgoing',
      at: eventData.createdAt || event.createdAt || new Date().toISOString(),
      hasMedia: Boolean(eventData.media?.length),
      snippet: (eventData.body ?? '').slice(0, 300),
      kind: 'message',
    });
  }
  // T2: the technician debrief moment — a Matt↔Mike call transcript is
  // ready right after they hang up. The runner matches it to the day's
  // site visits and drafts post-assessment quotes.
  if (event.type === 'call.transcript.completed' && TECHNICIAN_PHONES.has(e164Phone)) {
    await enqueueQuoteTrigger({
      phone: e164Phone,
      direction: 'incoming',
      at: eventData.createdAt || event.createdAt || new Date().toISOString(),
      hasMedia: false,
      snippet: '',
      kind: 'mike-debrief',
    });
  }
  // T4 (scope-change gate): customer call transcripts and voicemails are
  // scope evidence too. Enqueue the callId only — the runner fetches the
  // transcript/voicemail body at gate time and ignores phones with no
  // open quote. (Internal numbers are filtered by the runner's drain.)
  if (event.type === 'call.transcript.completed' && !TECHNICIAN_PHONES.has(e164Phone)) {
    await enqueueQuoteTrigger({
      phone: e164Phone,
      direction: 'incoming',
      at: eventData.createdAt || event.createdAt || new Date().toISOString(),
      hasMedia: false,
      snippet: '',
      kind: 'call-transcript',
      callId: eventData.callId || eventData.id,
    });
  }
  if (
    event.type === 'call.completed' &&
    eventData.direction === 'incoming' &&
    !(eventData.duration ?? 0) &&
    !eventData.answeredAt
  ) {
    // Missed incoming call — any such call may carry a voicemail (the
    // runner probes GET /call-voicemails/{callId} and drops rang-outs).
    await enqueueQuoteTrigger({
      phone: e164Phone,
      direction: 'incoming',
      at: eventData.createdAt || event.createdAt || new Date().toISOString(),
      hasMedia: false,
      snippet: '',
      kind: 'voicemail',
      callId: eventData.id,
    });
  }
}
