import { NextRequest, NextResponse } from "next/server";
import { applyVerb, ConfirmRequiredError, type Verb } from "@aac/items";
import { getItemStore, todayRanks } from "@/lib/items";

const VERBS = new Set(["done", "snooze", "dismiss", "restore", "pin", "unpin", "place"]);

/**
 * POST /api/items/verb  { key, verb: { type, ... } }
 * 409 { confirm: "money" | "legal" } when a dismiss needs confirmation.
 */
export async function POST(request: NextRequest) {
  const { key, verb } = (await request.json()) as { key?: string; verb?: Verb };
  if (!key || !verb || !VERBS.has(verb.type)) {
    return NextResponse.json({ error: "key and a valid verb are required" }, { status: 400 });
  }
  const store = getItemStore();
  const [snapshot, states] = await Promise.all([store.getCandidates(), store.getStates()]);
  const state = states[key];
  // Restore can target an item whose detector no longer emits it; fall back to its snapshot.
  const candidate =
    snapshot?.candidates.find((c) => c.key === key) ??
    (state?.snapshot && verb.type === "restore"
      ? {
          key,
          detector: state.snapshot.detector,
          area: "inbox" as const,
          lane: "needs-you" as const,
          severity: "info" as const,
          title: state.snapshot.title,
          customer: state.snapshot.customer,
          fingerprint: state.actedFingerprint ?? "",
        }
      : undefined);
  if (!state || !candidate) {
    return NextResponse.json({ error: `Unknown item ${key}` }, { status: 404 });
  }
  try {
    const next = applyVerb(state, verb, candidate, new Date(), todayRanks(states));
    await store.putStates({ [key]: next });
    return NextResponse.json({ ok: true, state: next });
  } catch (err) {
    if (err instanceof ConfirmRequiredError) {
      return NextResponse.json({ confirm: err.sensitive }, { status: 409 });
    }
    throw err;
  }
}
