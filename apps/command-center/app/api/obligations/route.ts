import { NextResponse, type NextRequest } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { changeObligation, isObligationOp } from "@/lib/obligations";

/** POST {op: "done", id} rolls a date to its next one; {op: "set", id, due, confirmed?} edits it. */
export async function POST(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;
  const body: unknown = await req.json().catch(() => null);
  if (!isObligationOp(body)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const list = await changeObligation(body);
  if (!list) return NextResponse.json({ error: "Unknown date" }, { status: 404 });
  return NextResponse.json({ obligations: list });
}
