import {
  ItemStore,
  nyDate,
  reconcile,
  recentlyDismissed,
  staleStateKeys,
  type HiddenReason,
  type Item,
  type ItemState,
} from "@aac/items";
import { getRedis } from "./redis";

export function getItemStore(): ItemStore {
  return new ItemStore(getRedis());
}

export interface ItemsView {
  /** When the detectors last ran, and who ran them. */
  detectedAt: string | null;
  source: string | null;
  items: Item[];
  hiddenCounts: Record<HiddenReason, number>;
  dismissed: ItemState[];
}

/** Reconcile the latest candidates with stored state, persist, and return the view. */
export async function loadItemsView(now = new Date()): Promise<ItemsView> {
  const store = getItemStore();
  const [snapshot, stored, mutes] = await Promise.all([store.getCandidates(), store.getStates(), store.getMutes()]);
  const { items, hidden, states } = reconcile(snapshot?.candidates ?? [], stored, mutes, now, {
    baseline: Object.keys(stored).length === 0,
  });
  const stale = staleStateKeys(states, now);
  for (const key of stale) delete states[key];
  await Promise.all([store.putStates(states), store.deleteStates(stale)]);

  const hiddenCounts: Record<HiddenReason, number> = { done: 0, snoozed: 0, dismissed: 0, muted: 0 };
  for (const h of hidden) hiddenCounts[h.reason] += 1;
  return {
    detectedAt: snapshot?.at ?? null,
    source: snapshot?.source ?? null,
    items,
    hiddenCounts,
    dismissed: recentlyDismissed(states, now),
  };
}

/** Ranks currently on Today (for appending a newly pinned item at the end). */
export function todayRanks(states: Record<string, ItemState>, now = new Date()): number[] {
  const today = nyDate(now);
  return Object.values(states)
    .filter((s) => s.status === "open" && s.pinnedFor && s.pinnedFor <= today && s.rank !== undefined)
    .map((s) => s.rank as number);
}
