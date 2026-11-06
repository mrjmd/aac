/**
 * Pipedrive activity logging for Quo events, one function per event type.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import type { QuoEvent, QuoEventData } from './types.js';

const log = createLogger('quo-webhook');

/** Log the event as a PD activity on the person (no-op for other event types). */
export async function logQuoActivity(
  pd: PipedriveClient,
  event: QuoEvent,
  eventData: QuoEventData,
  pipedrivePersonId: number,
): Promise<void> {
  if (event.type === 'call.completed') {
    await logCallActivity(pd, eventData, pipedrivePersonId);
  }

  if (event.type === 'message.received' || event.type === 'message.delivered') {
    await logSmsActivity(pd, event, eventData, pipedrivePersonId);
  }

  if (event.type === 'call.transcript.completed') {
    await logTranscriptActivity(pd, eventData, pipedrivePersonId);
  }
}

/** call.completed */
export async function logCallActivity(
  pd: PipedriveClient,
  eventData: QuoEventData,
  pipedrivePersonId: number,
): Promise<void> {
  const direction = eventData.direction === 'incoming' ? 'Inbound' : 'Outbound';

  // Compute call duration: prefer eventData.duration, fall back to
  // answeredAt→createdAt delta (createdAt is call end time per OpenPhone)
  let duration = eventData.duration || 0;
  if (!duration && eventData.answeredAt && eventData.createdAt) {
    const answered = new Date(eventData.answeredAt).getTime();
    const ended = new Date(eventData.createdAt).getTime();
    if (answered > 0 && ended > answered) {
      duration = Math.round((ended - answered) / 1000);
    }
  }

  log.info('Call duration debug', {
    rawDuration: eventData.duration,
    answeredAt: eventData.answeredAt,
    createdAt: eventData.createdAt,
    computedDuration: duration,
  });

  // Determine which AAC line handled the call (for attribution filtering)
  const aacLine = eventData.direction === 'incoming' ? eventData.to : eventData.from;

  const durationMin = Math.floor(duration / 60);
  const durationSec = duration % 60;

  let note = `${direction} call`;
  if (aacLine) {
    note += `\nLine: ${aacLine}`;
  }
  if (duration > 0) {
    note += `\nDuration: ${durationMin}m ${durationSec}s`;
  }
  if (eventData.recordingUrl) {
    note += `\n\nRecording: ${eventData.recordingUrl}`;
  }
  if (eventData.voicemailUrl) {
    note += `\n\nVoicemail: ${eventData.voicemailUrl}`;
  }

  await pd.logActivity(pipedrivePersonId, 'call', {
    subject: `${direction} Call (${durationMin}m ${durationSec}s)`,
    note,
    duration,
  });

  log.info('Logged call activity', {
    personId: pipedrivePersonId,
    duration,
  });
}

/** message.received / message.delivered */
export async function logSmsActivity(
  pd: PipedriveClient,
  event: QuoEvent,
  eventData: QuoEventData,
  pipedrivePersonId: number,
): Promise<void> {
  const messageBody = eventData.body || '(no content)';
  const truncatedBody =
    messageBody.length > 100 ? messageBody.substring(0, 100) + '...' : messageBody;

  const direction = event.type === 'message.received' ? 'Received' : 'Sent';

  // Determine which AAC line handled the message (for attribution filtering)
  const smsLine = event.type === 'message.received' ? eventData.to : eventData.from;
  let smsNote = `Full message:\n\n${messageBody}`;
  if (smsLine) {
    smsNote += `\n\nLine: ${smsLine}`;
  }

  await pd.logActivity(pipedrivePersonId, 'sms', {
    subject: `SMS ${direction}: "${truncatedBody}"`,
    note: smsNote,
  });

  log.info('Logged SMS activity', {
    personId: pipedrivePersonId,
    direction,
  });
}

/** call.transcript.completed */
export async function logTranscriptActivity(
  pd: PipedriveClient,
  eventData: QuoEventData,
  pipedrivePersonId: number,
): Promise<void> {
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
