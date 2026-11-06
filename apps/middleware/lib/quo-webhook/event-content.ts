/**
 * Pure readers over a Quo event: which phone is the customer's, what text
 * the AI should see, and whether the event is worth an extraction call.
 */

import type { QuoEventData, QuoEventType } from './types.js';

// Minimum message length for AI processing (skip trivial messages)
const MIN_MESSAGE_LENGTH = 10;

/**
 * Extract text content from event data for AI processing
 * For messages: returns body
 * For transcripts: returns formatted dialogue from external caller only
 */
export function extractTextForAI(
  eventData: QuoEventData
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
export function shouldProcessForAI(
  eventType: QuoEventType,
  eventData: QuoEventData
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
export function extractRemotePhone(
  eventData: QuoEventData
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
