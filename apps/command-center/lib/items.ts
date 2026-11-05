import {
  fromInvoiceNudge,
  fromRuleReview,
  fromTodo,
  ItemStore,
  reconcile,
  recentlyDismissed,
  staleStateKeys,
  type HiddenReason,
  type Item,
  type ItemCandidate,
  type ItemState,
} from "@aac/items";
import { isRuleActive } from "@aac/quoting";
import { cards, type NudgeRow } from "./cards";
import { getCanHelpStore } from "./can-help";
import { getRedis } from "./redis";
import { readSnapshot } from "./snapshots";
import { loadTodos } from "./todos";
import { easternDate } from "@aac/shared-utils/eastern";

export function getItemStore(): ItemStore {
  return new ItemStore(getRedis());
}

/**
 * Everything that can be an item right now: the latest detector run, the
 * saved invoice nudge ladder, Matt's pending to-dos, and owner policies
 * whose review date has arrived.
 */
export async function loadCandidates(now = new Date()): Promise<{
  candidates: ItemCandidate[];
  detectedAt: string | null;
  source: string | null;
}> {
  const [snapshot, todos, nudges, rules] = await Promise.all([
    getItemStore().getCandidates(),
    loadTodos(),
    readSnapshot<NudgeRow[]>(cards.nudges().name),
    getCanHelpStore()
      .rules()
      .catch(() => []),
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
  /** Snoozed items, soonest back first. */
  snoozed: Array<{ key: string; title: string; customer?: string; until?: string }>;
}

/** Reconcile the latest candidates with stored state, persist, and return the view. */
export async function loadItemsView(now = new Date()): Promise<ItemsView> {
  const store = getItemStore();
  const [{ candidates, detectedAt, source }, stored, mutes] = await Promise.all([
    loadCandidates(now),
    store.getStates(),
    store.getMutes(),
  ]);
  const { items, hidden, states } = reconcile(candidates, stored, mutes, now, {
    baseline: Object.keys(stored).length === 0,
  });
  const stale = staleStateKeys(states, now);
  for (const key of stale) delete states[key];
  await Promise.all([store.putStates(states), store.deleteStates(stale)]);

  const hiddenCounts: Record<HiddenReason, number> = { done: 0, snoozed: 0, dismissed: 0, muted: 0 };
  for (const h of hidden) hiddenCounts[h.reason] += 1;
  return {
    detectedAt,
    source,
    items,
    hiddenCounts,
    dismissed: recentlyDismissed(states, now),
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
