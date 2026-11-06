import { NextResponse, type NextRequest } from "next/server";
import { cardByName, refreshCard } from "@/lib/cards";
import { requireApiSession } from "@/lib/api-auth";

/** POST {name} — re-read one card's source now and save it. */
export async function POST(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  if (!name || !cardByName(name)) return NextResponse.json({ error: "Unknown card" }, { status: 404 });
  try {
    const snap = await refreshCard(name);
    return NextResponse.json({ fetchedAt: snap?.fetchedAt });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
