import { daysBetween, nyDate } from './dates.js';
import { groupByPerson } from './group.js';
import { rankItem, shouldSuggest, SUGGEST_MAX } from './rank.js';
import type { HiddenReason, Item, ItemCandidate, ItemState, MuteRule, ReconcileResult } from './types.js';

const SEVERITY_ORDER = { red: 0, yellow: 1, info: 2 } as const;

export function isMuted(candidate: ItemCandidate, mutes: MuteRule[]): boolean {
  return mutes.some((rule) => {
    if (rule.detector.toLowerCase() !== candidate.detector.toLowerCase()) return false;
    if (!rule.match) return true;
    const needle = rule.match.toLowerCase();
    return [candidate.customer, candidate.title, candidate.phone].some((v) => v?.toLowerCase().includes(needle));
  });
}

/**
 * Merge this run's candidates with stored state. Pure.
 *
 * - Muted: hidden.
 * - Done / dismissed: hidden until the fingerprint changes, then reopened
 *   into the "new" band.
 * - Snoozed: hidden until snoozeUntil passes or the fingerprint changes.
 * - Open: shown. Band is "today" when pinned for today or earlier, "new"
 *   until Matt places it, otherwise "list".
 * - Ranking (rank.ts): every item gets a score. The top few that clear the
 *   bar (a deadline, a customer waiting since recently) are suggested onto
 *   Today above Matt's own order; a drag makes them his. New and list sort
 *   by score. Then one person = one item (group.ts).
 *
 * States for keys no candidate mentions are carried through untouched
 * (the detector stopped seeing the problem); prune them separately.
 *
 * `baseline` (first import): new states start placed, so the "new" band
 * holds only what appears after the system starts tracking.
 */
export function reconcile(
  candidates: ItemCandidate[],
  stored: Record<string, ItemState>,
  mutes: MuteRule[],
  now: Date,
  options: { baseline?: boolean } = {},
): ReconcileResult {
  const nowIso = now.toISOString();
  const today = nyDate(now);
  const states: Record<string, ItemState> = { ...stored };
  const items: Item[] = [];
  const hidden: ReconcileResult['hidden'] = [];

  for (const candidate of dedupeByKey(candidates)) {
    let state: ItemState = states[candidate.key]
      ? { ...states[candidate.key], lastSeenAt: nowIso }
      : {
          key: candidate.key,
          status: 'open',
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          ...(options.baseline ? { placedAt: nowIso } : {}),
        };

    if (state.status !== 'open') {
      const changed = state.actedFingerprint !== undefined && state.actedFingerprint !== candidate.fingerprint;
      const snoozeOver = state.status === 'snoozed' && !!state.snoozeUntil && state.snoozeUntil <= nowIso;
      if (changed || snoozeOver) state = reopen(state, nowIso);
    }
    states[candidate.key] = state;

    if (isMuted(candidate, mutes)) {
      hidden.push({ key: candidate.key, reason: 'muted', candidate });
      continue;
    }
    if (state.status !== 'open') {
      hidden.push({ key: candidate.key, reason: state.status as HiddenReason, candidate });
      continue;
    }

    const onToday = !!state.pinnedFor && state.pinnedFor <= today;
    const item: Item = {
      ...candidate,
      ...rankItem(candidate, now),
      state,
      band: onToday ? 'today' : state.placedAt ? 'list' : 'new',
    };
    if (onToday && state.pinnedSince) item.rolloverDays = daysBetween(state.pinnedSince, today);
    items.push(item);
  }

  const suggestable = items
    .filter((i) => i.band !== 'today' && shouldSuggest(i, i.state, i.score, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, SUGGEST_MAX);
  for (const i of suggestable) {
    i.band = 'today';
    i.suggested = true;
  }

  items.sort(compareItems);
  return { items: groupByPerson(items), hidden, states };
}

function reopen(state: ItemState, nowIso: string): ItemState {
  const next: ItemState = { ...state, status: 'open', reopenedAt: nowIso };
  delete next.placedAt;
  delete next.snoozeUntil;
  delete next.dismissReason;
  delete next.dismissNote;
  return next;
}

function dedupeByKey(candidates: ItemCandidate[]): ItemCandidate[] {
  const byKey = new Map<string, ItemCandidate>();
  for (const c of candidates) {
    const prev = byKey.get(c.key);
    if (!prev || SEVERITY_ORDER[c.severity] < SEVERITY_ORDER[prev.severity]) byKey.set(c.key, c);
  }
  return [...byKey.values()];
}

const BAND_ORDER = { today: 0, new: 1, list: 2 } as const;

function compareItems(a: Item, b: Item): number {
  if (a.band !== b.band) return BAND_ORDER[a.band] - BAND_ORDER[b.band];
  if (a.band === 'today') {
    // The ranking's suggestions sit above Matt's own order until he drags them in.
    if (!!a.suggested !== !!b.suggested) return a.suggested ? -1 : 1;
    if (a.suggested) return b.score - a.score;
    return (a.state.rank ?? Number.MAX_SAFE_INTEGER) - (b.state.rank ?? Number.MAX_SAFE_INTEGER);
  }
  if (a.score !== b.score) return b.score - a.score;
  return b.state.firstSeenAt.localeCompare(a.state.firstSeenAt);
}

/** States not seen by any detector for `days` and not acted on recently. */
export function staleStateKeys(states: Record<string, ItemState>, now: Date, days = 30): string[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return Object.values(states)
    .filter((s) => s.lastSeenAt < cutoff && (!s.actedAt || s.actedAt < cutoff))
    .map((s) => s.key);
}

/** Dismissed in the last `days` (newest first), for the Restore list. */
export function recentlyDismissed(states: Record<string, ItemState>, now: Date, days = 30): ItemState[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return Object.values(states)
    .filter((s) => s.status === 'dismissed' && (s.actedAt ?? '') >= cutoff)
    .sort((a, b) => (b.actedAt ?? '').localeCompare(a.actedAt ?? ''));
}
