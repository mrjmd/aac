import { NextRequest, NextResponse } from "next/server";
import { addCardFlag, fixCardFlag, listCardFlags } from "@/lib/card-flags";
import { requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/** GET /api/card-flags — every "this looks wrong" flag, open first. */
export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  return NextResponse.json(await listCardFlags());
}

/**
 * POST /api/card-flags
 *   { op: "add", page, card, note, text }  save a flag
 *   { op: "fix", id, fix? }                 mark it fixed
 */
export async function POST(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (b.op === "add") {
    if (!str(b.note) && !str(b.text)) return NextResponse.json({ error: "note or text required" }, { status: 400 });
    const flag = await addCardFlag({ page: str(b.page), card: str(b.card) || "Untitled card", note: str(b.note), text: str(b.text) });
    return NextResponse.json({ ok: true, flag });
  }
  if (b.op === "fix" && str(b.id)) {
    const flag = await fixCardFlag(str(b.id), str(b.fix));
    return flag ? NextResponse.json({ ok: true, flag }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ error: "op must be add or fix" }, { status: 400 });
}
