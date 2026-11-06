/**
 * Scheduling-intent dispatch from the Quo webhook: map the raw event onto
 * a dispatch context and run the dispatch after the response (defer).
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { PipedriveClient } from '@aac/api-clients/pipedrive';
import { readFieldCompletion, logHealthError } from '../redis.js';
import { defer } from '../defer.js';
import type { EnvConfig } from '../env.js';
import { getCalendar, getDrive, getGmail, getGemini, getQuickBooks, getQuo } from '../clients.js';
import {
  dispatchSchedulingIntent,
  type DialogueEntry,
  type SchedulingDispatchContext,
  type SchedulingEventType,
} from '@aac/scheduling';
import { maybePostSuggestionNote } from '../suggestion-note.js';
import { schedulingStore } from '../scheduling-store.js';
import type { QuoEvent, QuoEventData } from './types.js';

const log = createLogger('quo-webhook');

/**
 * Build the scheduling-dispatch context from the raw event. Returns null
 * for event types that don't carry classifiable content (call.completed,
 * call.ringing). Maps Quo's `userId` flag on dialogue entries to the
 * dispatch helper's `isMatt` boolean.
 */
export function buildDispatchContext(
  event: QuoEvent,
  eventData: QuoEventData,
  customerPhone: string,
  pdPersonId: number,
): SchedulingDispatchContext | null {
  const type = event.type;
  if (
    type !== 'message.received'
    && type !== 'message.delivered'
    && type !== 'call.transcript.completed'
  ) {
    return null;
  }

  const eventType: SchedulingEventType = type;

  if (eventType === 'call.transcript.completed') {
    if (!eventData.dialogue || eventData.dialogue.length === 0) return null;
    const dialogue: DialogueEntry[] = eventData.dialogue.map((d) => ({
      content: d.content,
      isMatt: !!d.userId,
    }));
    return {
      eventId: event.id,
      eventType,
      dialogue,
      customerPhone,
      pdPersonId,
    };
  }

  return {
    eventId: event.id,
    eventType,
    text: eventData.body ?? '',
    customerPhone,
    pdPersonId,
  };
}

// ============================================
// SCHEDULING-INTENT CLASSIFICATION (deferred — ack-fast)
// ============================================
// Dispatch helper runs the classifier (one or two calls depending on
// event type), resolves callback parent via calendar when needed, calls
// the right normalizer, and writes any resulting directives to the
// shadow queue. It can take 10s+ (Gemini + Calendar), which is how the
// 2026-10-19 timeout → webhook auto-disable incident happened — so it
// now runs AFTER the response via defer(); the ack never waits on it.
// Failures are logged + surfaced to /api/health, never propagate.
export function deferSchedulingDispatch(
  pd: PipedriveClient,
  env: EnvConfig,
  event: QuoEvent,
  eventData: QuoEventData,
  e164Phone: string,
  pipedrivePersonId: number,
): void {
  const dispatchCtx = buildDispatchContext(event, eventData, e164Phone, pipedrivePersonId);
  if (dispatchCtx) {
    defer((async () => {
      try {
        const summary = await dispatchSchedulingIntent(
          {
            store: schedulingStore,
            pd,
            cal: getCalendar(),
            gemini: getGemini(),
            quo: getQuo(),
            qb: getQuickBooks(),
            stub: {
              enabled: env.scheduling.stubEventsEnabled,
              technicianEmails: env.scheduling.stubAttendeeEmails,
              drive: getDrive(),
              gmail: getGmail(),
              fetchFieldCompletion: readFieldCompletion,
            },
            holds: {
              enabled: env.scheduling.holdEventsEnabled,
            },
            postSuggestionNote: maybePostSuggestionNote,
          },
          dispatchCtx,
        );
        log.info('Scheduling dispatch complete', {
          eventId: event.id,
          eventType: event.type,
          summary,
        });
      } catch (error) {
        log.error('Scheduling dispatch threw', error as Error, { eventId: event.id });
        await logHealthError('quo', `Scheduling dispatch threw: ${(error as Error).message.substring(0, 200)}`, {
          eventId: event.id,
          eventType: event.type,
        });
      }
    })());
  }
}
