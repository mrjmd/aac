import { NextRequest, NextResponse } from "next/server";
import { rankFeatures, reorderToday } from "@aac/items";
import { getItemStore, loadCandidates } from "@/lib/items";

/**
 * POST /api/items/reorder  { keys: string[] } — Matt's order for Today.
 * Each drag is logged with every listed item's rank features, so the
 * ranking can learn from where he moved things.
 */
export async function POST(request: NextRequest) {
  const { keys } = (await request.json()) as { keys?: string[] };
  if (!Array.isArray(keys)) return NextResponse.json({ error: "keys[] required" }, { status: 400 });
  const store = getItemStore();
  const now = new Date();
  const [states, { candidates }] = await Promise.all([store.getStates(), loadCandidates(now)]);
  await store.putStates(reorderToday(states, keys));
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const items = keys.flatMap((k) => {
    const c = byKey.get(k);
    return c ? [rankFeatures(c, states[k], now)] : [];
  });
  await store.logRank({ at: now.toISOString(), action: "reorder", order: keys, items }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
