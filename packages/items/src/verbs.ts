import { nyDate } from './dates.js';
import type { DismissReason, ItemCandidate, ItemState } from './types.js';

export type Verb =
  | { type: 'done' }
  | { type: 'snooze'; until: string }
  | { type: 'dismiss'; reason: DismissReason; note?: string; confirmed?: boolean }
  | { type: 'restore' }
  | { type: 'pin'; date?: string }
  | { type: 'unpin' }
  | { type: 'place' };

export class ConfirmRequiredError extends Error {
  constructor(public readonly sensitive: 'money' | 'legal') {
    super(`Dismissing a ${sensitive} item needs confirmation`);
    this.name = 'ConfirmRequiredError';
  }
}

/**
 * Apply one verb. Pure; returns the new state. `candidate` is the item as
 * currently emitted (its fingerprint is what a later run compares against).
 * Pinning appends to the end of Today; use `reorderToday` to set Matt's order.
 */
export function applyVerb(
  state: ItemState,
  verb: Verb,
  candidate: ItemCandidate,
  now: Date,
  todayRanks: number[] = [],
): ItemState {
  const nowIso = now.toISOString();
  const acted = {
    actedAt: nowIso,
    actedFingerprint: candidate.fingerprint,
    snapshot: { title: candidate.title, customer: candidate.customer, detector: candidate.detector },
  };
  switch (verb.type) {
    case 'done':
      return unpinned({ ...state, ...acted, status: 'done', placedAt: state.placedAt ?? nowIso });
    case 'snooze':
      return unpinned({ ...state, ...acted, status: 'snoozed', snoozeUntil: verb.until, placedAt: state.placedAt ?? nowIso });
    case 'dismiss':
      if (candidate.sensitive && !verb.confirmed) throw new ConfirmRequiredError(candidate.sensitive);
      return unpinned({
        ...state,
        ...acted,
        status: 'dismissed',
        dismissReason: verb.reason,
        dismissNote: verb.note,
        placedAt: state.placedAt ?? nowIso,
      });
    case 'restore': {
      const next: ItemState = { ...state, status: 'open', actedAt: nowIso, placedAt: nowIso };
      delete next.snoozeUntil;
      delete next.dismissReason;
      delete next.dismissNote;
      delete next.actedFingerprint;
      return next;
    }
    case 'pin': {
      const date = verb.date ?? nyDate(now);
      const rank = todayRanks.length ? Math.max(...todayRanks) + 1 : 0;
      return { ...state, placedAt: state.placedAt ?? nowIso, pinnedFor: date, pinnedSince: state.pinnedSince ?? date, rank };
    }
    case 'unpin':
      return unpinned({ ...state, placedAt: state.placedAt ?? nowIso });
    case 'place':
      return { ...state, placedAt: state.placedAt ?? nowIso };
  }
}

function unpinned(state: ItemState): ItemState {
  const next = { ...state };
  delete next.pinnedFor;
  delete next.pinnedSince;
  delete next.rank;
  return next;
}

/** Matt's drag order for Today: keys in the order he wants them. */
export function reorderToday(states: Record<string, ItemState>, orderedKeys: string[]): Record<string, ItemState> {
  const out: Record<string, ItemState> = {};
  orderedKeys.forEach((key, rank) => {
    const s = states[key];
    if (s) out[key] = { ...s, rank };
  });
  return out;
}
