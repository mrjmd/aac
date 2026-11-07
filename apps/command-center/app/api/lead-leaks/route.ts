import { NextResponse, type NextRequest } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { setLeadHandled } from "@/lib/lead-leaks";

/** POST {phone, lastActivityAt} marks a lead handled until its thread moves; lastActivityAt null undoes it. */
export async function POST(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;
  const { phone, lastActivityAt } = (await req.json().catch(() => ({}))) as { phone?: unknown; lastActivityAt?: unknown };
  if (typeof phone !== "string" || !/^\+\d{10,15}$/.test(phone)) return NextResponse.json({ error: "Missing phone" }, { status: 400 });
  if (lastActivityAt !== null && typeof lastActivityAt !== "string") return NextResponse.json({ error: "Missing lastActivityAt" }, { status: 400 });
  await setLeadHandled(phone, lastActivityAt);
  return NextResponse.json({ ok: true });
}
