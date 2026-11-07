import { NextRequest, NextResponse } from "next/server";
import { PROMOTION_RULES, type PromotionRule } from "@aac/items";
import { getItemStore } from "@/lib/items";
import { requireApiSession } from "@/lib/api-auth";

/** POST /api/items/promotion  { rule, on } — flip one of the Rules page's "moves onto Today by itself" switches. */
export async function POST(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const body = (await request.json()) as { rule?: string; on?: boolean };
  const rule = PROMOTION_RULES.find((r) => r.id === body.rule)?.id as PromotionRule | undefined;
  if (!rule || typeof body.on !== "boolean") return NextResponse.json({ error: "rule and on required" }, { status: 400 });
  const store = getItemStore();
  const promote = { ...(await store.getPromotion()), [rule]: body.on };
  await store.putPromotion(promote);
  return NextResponse.json({ ok: true, promote });
}
