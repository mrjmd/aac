import {
  dismissalPatterns,
  fromInvoiceNudge,
  fromObligation,
  fromRuleReview,
  fromTodo,
  ItemStore,
  reconcile,
  recentlyDismissed,
  staleStateKeys,
  type HiddenReason,
  type Item,
  type DismissReason,
  type ItemCandidate,
  type ItemState,
} from "@aac/items";
import { isRuleActive } from "@aac/quoting";
import { cards, type NudgeRow } from "./cards";
import { getCanHelpStore } from "./can-help";
import { getRedis } from "./redis";
import { readSnapshot } from "./snapshots";
import { loadObligations } from "./obligations";
import { loadTodos } from "./todos";
import { loadSystemCandidates } from "./system-health";
import { easternDate } from "@aac/shared-utils/eastern";

export function getItemStore(): ItemStore {
  return new ItemStore(getRedis());
}

/**
 * Everything that can be an item right now: the latest detector run, the
 * saved invoice nudge ladder, Matt's pending to-dos, owner policies whose
 * review date has arrived, and System problems that became ongoing.
 */
export async function loadCandidates(now = new Date()): Promise<{
  candidates: ItemCandidate[];
  detectedAt: string | null;
  source: string | null;
}> {
  const [snapshot, todos, nudges, rules, system, obligations] = await Promise.all([
    getItemStore().getCandidates(),
    loadTodos(),
    readSnapshot<NudgeRow[]>(cards.nudges().name),
    getCanHelpStore()
      .rules()
      .catch(() => []),
    // Jobs not invoiced / CI red, only once ongoing (lib/system-rules.ts). Redis + saved CI snapshot.
    loadSystemCandidates(now),
    loadObligations(),
  ]);
  const today = easternDate(now);
  // The saved nudge ladder replaces triage's plain overdue items (same d3:
  // keys, so Matt's state carries over). Saved only: never fetched here.
  const laddered = new Set(nudges?.data.map((n) => `d3:${n.invoiceId}`) ?? []);
  return {
    candidates: [
      ...(snapshot?.candidates ?? []).filter((c) => !laddered.has(c.key)),
      ...(nudges?.data ?? []).flatMap((n) => (n.next ? [fromInvoiceNudge({ ...n, next: n.next })] : [])),
      ...todos.filter((t) => t.status === "pending").map((t) => fromTodo(t, today)),
      ...rules.flatMap((r) => {
        if (!r.reviewBy || !isRuleActive(r, today)) return [];
        const c = fromRuleReview({ id: r.id, label: r.short ?? r.id, text: r.text, reviewBy: r.reviewBy, ...(r.untilWhen ? { untilWhen: r.untilWhen } : {}) }, today);
        return c ? [c] : [];
      }),
      ...system,
      ...obligations.flatMap((o) => {
        const c = fromObligation(o, today);
        return c ? [c] : [];
      }),
    ],
    detectedAt: snapshot?.at ?? null,
    source: snapshot?.source ?? null,
  };
}

export interface ItemsView {
  /** When the detectors last ran, and who ran them. */
  detectedAt: string | null;
  source: string | null;
  items: Item[];
  hiddenCounts: Record<HiddenReason, number>;
  dismissed: ItemState[];
  /** The same dismiss reason used on one kind of item 2+ times in 30 days (Rules page). */
  teaching: Array<{ detector: string; reason: DismissReason; count: number }>;
  /** Snoozed items, soonest back first. */
  snoozed: Array<{ key: string; title: string; customer?: string; until?: string }>;
}

/** Reconcile the latest candidates with stored state, persist, and return the view. */
export async function loadItemsView(now = new Date()): Promise<ItemsView> {
  const store = getItemStore();
  const [{ candidates, detectedAt, source }, stored, mutes, promote] = await Promise.all([
    loadCandidates(now),
    store.getStates(),
    store.getMutes(),
    store.getPromotion(),
  ]);
  const { items, hidden, states } = reconcile(candidates, stored, mutes, now, {
    baseline: Object.keys(stored).length === 0,
    promote,
  });
  const stale = staleStateKeys(states, now);
  for (const key of stale) delete states[key];
  await Promise.all([store.putStates(states), store.deleteStates(stale)]);

  const hiddenCounts: Record<HiddenReason, number> = { done: 0, snoozed: 0, dismissed: 0, muted: 0 };
  for (const h of hidden) hiddenCounts[h.reason] += 1;
  const dismissed = recentlyDismissed(states, now);
  return {
    detectedAt,
    source,
    items,
    hiddenCounts,
    dismissed,
    teaching: dismissalPatterns(dismissed),
    snoozed: hidden
      .filter((h) => h.reason === "snoozed")
      .map((h) => ({ key: h.key, title: h.candidate.title, customer: h.candidate.customer, until: states[h.key]?.snoozeUntil }))
      .sort((a, b) => (a.until ?? "").localeCompare(b.until ?? "")),
  };
}

/** Ranks currently on Today (for appending a newly pinned item at the end). */
export function todayRanks(states: Record<string, ItemState>, now = new Date()): number[] {
  const today = easternDate(now);
  return Object.values(states)
    .filter((s) => s.status === "open" && s.pinnedFor && s.pinnedFor <= today && s.rank !== undefined)
    .map((s) => s.rank as number);
}
