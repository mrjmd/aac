import { NextRequest, NextResponse } from "next/server";
import type { Scorecard } from "@aac/metrics";
import { keys } from "@aac/shared-utils/redis";
import { getRedis } from "@/lib/redis";
import { requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/scorecard/records?row=<key>&week=<index | ly> — the records
 * behind one scorecard cell, from the saved nightly snapshot (the page
 * leaves them out so This week stays light). Never fetches the sources.
 */
export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const p = request.nextUrl.searchParams;
  const card = await getRedis().get<Scorecard>(keys.scorecard);
  const row = card?.rows.find((r) => r.key === p.get("row"));
  if (!card || !row) return NextResponse.json({ error: "no such row" }, { status: 404 });
  const week = p.get("week");
  if (week === "ly") return NextResponse.json({ records: row.lastYearRecords ?? null });
  const k = Number(week);
  if (!Number.isInteger(k) || k < 0 || k >= card.weeks.length) return NextResponse.json({ error: "bad week" }, { status: 400 });
  return NextResponse.json({ records: row.records?.[k] ?? null });
}
