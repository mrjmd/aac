import { NextResponse, type NextRequest } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { isHandGrade, saveHandGrade } from "@/lib/automations";

/** POST {id, grade} — Matt's own grade on one draft (grade null clears it). */
export async function POST(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;
  const { id, grade } = (await req.json().catch(() => ({}))) as { id?: unknown; grade?: unknown };
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (grade !== null && !isHandGrade(grade)) return NextResponse.json({ error: "Unknown grade" }, { status: 400 });
  if (!(await saveHandGrade(id, grade))) return NextResponse.json({ error: "Unknown draft" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
