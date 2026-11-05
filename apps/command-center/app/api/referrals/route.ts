import { NextRequest, NextResponse } from "next/server";
import { canHelpId, endRule, type Referral, type StandingRule } from "@aac/quoting";
import { nyDate } from "@aac/items";
import { parsePhone } from "@aac/shared-utils/phone";
import { getCanHelpStore } from "@/lib/can-help";

/** GET /api/referrals — the referral list and the standing rules. */
export async function GET() {
  return NextResponse.json(await snapshot());
}

type RuleFields = Pick<StandingRule, "short" | "text" | "referralIds" | "untilWhen" | "reviewBy">;

type Op =
  | { op: "putReferral"; id?: string; name: string; phone?: string; sends: string; note?: string }
  | { op: "removeReferral"; id: string }
  | ({ op: "putRule"; id?: string; kind?: StandingRule["kind"] } & RuleFields)
  | { op: "pauseRule"; id: string; paused: boolean }
  | { op: "endRule"; id: string };

/**
 * POST /api/referrals  { op, ... } — one change to the can-help store. The
 * drafters read the store fresh on every run, so a save is live right away.
 * Returns the whole store so the page re-renders from the saved state.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as Op;
  const store = getCanHelpStore();
  const today = nyDate(new Date());

  switch (body.op) {
    case "putReferral": {
      const name = body.name?.trim();
      const sends = body.sends?.trim();
      if (!name || !sends) return bad("name and what we send them are required");
      let phone: string | undefined;
      if (body.phone?.trim()) {
        phone = parsePhone(body.phone)?.national;
        if (!phone) return bad(`"${body.phone}" isn't a phone number`);
      }
      const all = await store.referrals();
      const prev = body.id ? all.find((r) => r.id === body.id) : undefined;
      if (body.id && !prev) return bad("referral not found", 404);
      const r: Referral = {
        id: prev?.id ?? canHelpId(name, all.map((x) => x.id)),
        name,
        sends,
        ...(phone ? { phone } : {}),
        ...(body.note?.trim() ? { note: body.note.trim() } : {}),
      };
      await store.putReferral(r);
      break;
    }
    case "removeReferral":
      await store.removeReferral(body.id);
      break;
    case "putRule": {
      const text = body.text?.trim();
      if (!text) return bad("rule text required");
      const all = await store.rules();
      const prev = body.id ? all.find((r) => r.id === body.id) : undefined;
      if (body.id && !prev) return bad("rule not found", 404);
      const short = body.short?.trim() || prev?.short;
      const { referralIds: _r, untilWhen: _u, reviewBy: _v, ...kept } = prev ?? { since: today };
      const r: StandingRule = {
        ...kept,
        id: prev?.id ?? canHelpId(short ?? text.split(/\s+/).slice(0, 4).join(" "), all.map((x) => x.id)),
        kind: prev?.kind ?? body.kind ?? "decline",
        text,
        ...(short ? { short } : {}),
        ...(body.referralIds?.length ? { referralIds: body.referralIds } : {}),
        ...(body.untilWhen?.trim() ? { untilWhen: body.untilWhen.trim() } : {}),
        ...(body.reviewBy ? { reviewBy: body.reviewBy } : {}),
      };
      await store.putRule(r);
      break;
    }
    case "pauseRule":
    case "endRule": {
      const r = (await store.rules()).find((x) => x.id === body.id);
      if (!r) return bad("rule not found", 404);
      if (body.op === "endRule") await store.putRule(endRule(r, today));
      else {
        const { paused: _p, ...rest } = r;
        await store.putRule(body.paused ? { ...rest, paused: true } : rest);
      }
      break;
    }
    default:
      return bad("unknown op");
  }
  return NextResponse.json(await snapshot());
}

async function snapshot() {
  const store = getCanHelpStore();
  const [referrals, rules] = await Promise.all([store.referrals(), store.rules()]);
  return { referrals, rules };
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
