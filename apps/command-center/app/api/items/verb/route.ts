import { NextRequest, NextResponse } from "next/server";
import { applyVerb, ConfirmRequiredError, rankFeatures, TODO_KEY_PREFIX, type Verb } from "@aac/items";
import { getItemStore, loadCandidates, todayRanks } from "@/lib/items";
import { completeTodo } from "@/lib/todos";

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
  const [{ candidates }, states] = await Promise.all([loadCandidates(), store.getStates()]);
  const state = states[key];
  // Restore can target an item whose detector no longer emits it; fall back to its snapshot.
  const candidate =
    candidates.find((c) => c.key === key) ??
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
    const now = new Date();
    const next = applyVerb(state, verb, candidate, now, todayRanks(states));
    await store.putStates({ [key]: next });
    // Training data for the Today ranking: what he did, and what it looked like when he did it.
    await store
      .logRank({ at: now.toISOString(), action: verb.type, items: [rankFeatures(candidate, state, now)] })
      .catch(() => undefined);
    // Done on a to-do completes it in the to-do store too (CLI, triage, /todos).
    if (verb.type === "done" && key.startsWith(TODO_KEY_PREFIX)) await completeTodo(key.slice(TODO_KEY_PREFIX.length));
    return NextResponse.json({ ok: true, state: next });
  } catch (err) {
    if (err instanceof ConfirmRequiredError) {
      return NextResponse.json({ confirm: err.sensitive }, { status: 409 });
    }
    throw err;
  }
}
