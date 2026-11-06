/**
 * Suggestion note, middleware entry point. The flow itself (suggestSlot,
 * HOLD on the primary slot, the 3-line Quo contact note, at-most-once per
 * QB estimate) lives in @aac/scheduling (suggestion-note.ts). This module
 * gates it on SCHEDULING_SUGGEST_NOTES and wires the clients and store.
 */

import { createLogger } from '@aac/shared-utils/logger';
import {
  postSuggestionNoteForDirective,
  type SchedulingDirective,
  type SuggestionNoteResult,
} from '@aac/scheduling';
import {
  getCalendar,
  getMaps,
  getPipedrive,
  getQuickBooks,
  getQuo,
} from './clients.js';
import { getEnv } from './env.js';
import { getRedis, logHealthError } from './redis.js';
import { schedulingStore } from './scheduling-store.js';

const log = createLogger('suggestion-note');

/**
 * Flag-gated, fail-soft entry point for the QB webhook and reconcile cron:
 * builds the client bundle, runs the flow, and swallows (but health-logs)
 * every error so directive queueing is never jeopardized by the note leg.
 */
export async function maybePostSuggestionNote(
  directive: SchedulingDirective,
  caller: string,
): Promise<SuggestionNoteResult | null> {
  const env = getEnv();
  if (!env.scheduling?.suggestNotesEnabled) return null;
  try {
    const result = await postSuggestionNoteForDirective(
      {
        store: schedulingStore,
        pd: getPipedrive(),
        qb: getQuickBooks(),
        quo: getQuo(),
        calendar: getCalendar(),
        maps: getMaps(),
        redis: getRedis(),
        technicianEmails: env.google.technicianEmails,
      },
      directive,
    );
    log.info('Suggestion note flow finished', { caller, directiveId: directive.id, result });
    return result;
  } catch (err) {
    log.error('Suggestion note flow failed', err as Error, {
      caller,
      directiveId: directive.id,
    });
    await logHealthError(
      'suggestion-note',
      `${caller}: ${(err as Error).message}`,
      { directiveId: directive.id },
    );
    return null;
  }
}
