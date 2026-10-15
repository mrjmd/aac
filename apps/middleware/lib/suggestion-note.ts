/**
 * Suggestion note — the production version of the manual Sierra Harkin flow:
 * when a quote flips to Accepted, run suggestSlot (primary + backup on a
 * different day), place a graphite HOLD on the primary so the time can't be
 * double-offered, and post the tight 3-line note to the customer's Quo
 * contact panel so Matt can text the offer from inside the conversation.
 *
 * Matt stays the sender — nothing here messages the customer. The note is
 * the delivery channel to Matt (Quo contact notes surface in the
 * conversation side panel).
 *
 * Routing rules (Matt, 2026-10-15):
 *   - suggestSlot's manualReviewReason (customer >90min from home) → NO
 *     hold; note says "needs manual scheduling" with the computed slot as
 *     a starting point only.
 *   - multi-day / no slot in window → NO hold; short "book manually" note.
 *   - hold duplicate guard hit (an event already exists for this customer
 *     near the suggested time) → no note at all; the calendar already
 *     represents them.
 *
 * Idempotency: at-most-once per QB estimate via markCronAction NX marker,
 * claimed immediately before the side-effectful tail (hold + note) so the
 * webhook and the qb-reconcile cron can't double-post. Pre-marker failures
 * (calendar read, Quo contact miss) leave the marker unclaimed so the daily
 * reconcile retries.
 *
 * Gated by SCHEDULING_SUGGEST_NOTES (env.scheduling.suggestNotesEnabled)
 * at the call sites, plus the standard 0.7 confidence floor here.
 */

import { createLogger } from '@aac/shared-utils/logger';
import {
  executeHoldEvent,
  suggestSlot,
  syntheticDayBlocker,
  type SchedulingDirective,
  type SuggestSlotResult,
} from '@aac/scheduling';
import {
  getCalendar,
  getMaps,
  getPipedrive,
  getQuickBooks,
  getQuo,
} from './clients.js';
import { getEnv } from './env.js';
import {
  buildTravelDeps,
  fetchBusyEvents,
  fetchCustomer,
  type ProposalBuilderDeps,
} from './proposal-builder.js';
import {
  getRedis,
  logHealthError,
  markCronAction,
  SCHEDULING_AUTO_PROPOSE_THRESHOLD,
} from './redis.js';

const log = createLogger('suggestion-note');

const MARKER_ACTION = 'suggestion-note';
const MARKER_TTL_SECONDS = 90 * 86_400;
const ET = 'America/New_York';

export type SuggestionNoteDeps = Pick<
  ProposalBuilderDeps,
  'pd' | 'qb' | 'quo' | 'calendar' | 'maps' | 'redis' | 'homeAddress' | 'technicianEmails'
> & { now?: () => Date };

export type SuggestionNoteResult =
  | { status: 'posted'; noteId: string; holdEventId: string | null; manual: boolean }
  | {
      status: 'skipped';
      reason:
        | 'not_quote_approved'
        | 'low_confidence'
        | 'calendar_unavailable'
        | 'no_quo_contact'
        | 'already_posted'
        | 'already_on_calendar';
    };

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

export async function postSuggestionNoteForDirective(
  deps: SuggestionNoteDeps,
  directive: SchedulingDirective,
): Promise<SuggestionNoteResult> {
  if (directive.intent !== 'quote_approved') {
    return { status: 'skipped', reason: 'not_quote_approved' };
  }
  if (directive.confidence.score < SCHEDULING_AUTO_PROPOSE_THRESHOLD) {
    log.info('Suggestion note skipped — confidence below threshold', {
      directiveId: directive.id,
      score: directive.confidence.score,
    });
    return { status: 'skipped', reason: 'low_confidence' };
  }

  const now = (deps.now ?? (() => new Date()))();

  // ── Gather (no side effects; failures here leave the marker unclaimed) ──
  const { customerName, customerAddress } = await fetchCustomer(deps, directive);

  const busy = await fetchBusyEvents(deps, directive.id, now);
  if (busy === null) {
    // Never create holds/notes against an unknown calendar — a suggestion
    // computed on an empty busy set could double-book. Reconcile retries.
    return { status: 'skipped', reason: 'calendar_unavailable' };
  }

  const contact = await deps.quo.findContactByPhone(directive.customerPhone);
  if (!contact) {
    await logHealthError(
      'suggestion-note',
      'No Quo contact for customer phone — suggestion note not posted',
      { directiveId: directive.id, customerPhone: directive.customerPhone },
    );
    return { status: 'skipped', reason: 'no_quo_contact' };
  }

  const travel = buildTravelDeps(deps, directive);
  const baseInput = {
    directive,
    now,
    ...(travel ? { travel } : {}),
    ...(customerAddress ? { customerAddress } : {}),
  };
  const primary = await suggestSlot({ ...baseInput, existingEvents: busy });

  // ── Claim the at-most-once marker before any side effect ──────────────
  const markerId = directive.qbEstimateId ?? directive.id;
  const isNew = await markCronAction(MARKER_ACTION, markerId, MARKER_TTL_SECONDS);
  if (!isNew) {
    log.info('Suggestion note already posted for estimate', { markerId });
    return { status: 'skipped', reason: 'already_posted' };
  }

  // ── Manual-routing paths: note only, never a hold ──────────────────────
  const manualReason = manualRoutingReason(primary);
  if (manualReason) {
    const lines = [
      `📅 ${customerName} quote accepted — needs manual scheduling: ${manualReason}.`,
      ...(primary.slot ? [`Starting point: ${fmtSlot(primary.slot.startIso)}`] : []),
    ];
    const note = await deps.quo.createContactNote(contact.id, lines.join('\n'));
    log.info('Manual-scheduling note posted', {
      directiveId: directive.id,
      noteId: note.id,
      reason: manualReason,
    });
    return { status: 'posted', noteId: note.id, holdEventId: null, manual: true };
  }

  // manualRoutingReason returned null, so primary.slot exists.
  const slot = primary.slot!;

  // ── Hold on the primary slot (duplicate guard doubles as "already booked") ──
  const hold = await executeHoldEvent(
    { cal: deps.calendar, now: () => now },
    {
      directive,
      customerName,
      customerAddress,
      suggestedSlot: { startIso: slot.startIso, endIso: slot.endIso },
    },
  );
  if (hold.status === 'skipped' && hold.reason === 'duplicate_event') {
    log.info('Suggestion note skipped — customer already on calendar near slot', {
      directiveId: directive.id,
    });
    return { status: 'skipped', reason: 'already_on_calendar' };
  }

  // ── Backup suggestion on a different day ───────────────────────────────
  const backup = await suggestSlot({
    ...baseInput,
    existingEvents: [...busy, syntheticDayBlocker(slot.startIso)],
  });

  const estHours = Math.round(primary.durationHours * 2) / 2;
  const lines = [
    `📅 ${customerName} looks ready to schedule — est ~${estHours}h.`,
    `Suggested: ${fmtSlot(slot.startIso)}`,
    ...(backup.slot && !backup.manualReviewReason
      ? [`Backup: ${fmtSlot(backup.slot.startIso)}`]
      : []),
  ];
  const note = await deps.quo.createContactNote(contact.id, lines.join('\n'));
  log.info('Suggestion note posted', {
    directiveId: directive.id,
    noteId: note.id,
    holdEventId: hold.status === 'created' ? hold.eventId : null,
    primary: slot.startIso,
    backup: backup.slot?.startIso ?? null,
  });
  return {
    status: 'posted',
    noteId: note.id,
    holdEventId: hold.status === 'created' ? hold.eventId : null,
    manual: false,
  };
}

/**
 * Why this result must go to Matt instead of the automated note+hold path.
 * Returns a short clause for the note, or null when automation may proceed.
 */
function manualRoutingReason(result: SuggestSlotResult): string | null {
  if (result.manualReviewReason) {
    // Keep the note tight: drop the trailing "— needs Matt's…" clause.
    return result.manualReviewReason.split(' — ')[0];
  }
  if (!result.slot) {
    return result.reasoning.startsWith('multi-day')
      ? 'multi-day job'
      : `nothing free in the next ${result.daysConsidered} weekdays`;
  }
  return null;
}

function fmtSlot(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: ET,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
