import { NextResponse, type NextRequest } from "next/server";
import { cardByName, refreshCard } from "@/lib/cards";

/** POST {name} — re-read one card's source now and save it. */
export async function POST(req: NextRequest) {
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  if (!name || !cardByName(name)) return NextResponse.json({ error: "Unknown card" }, { status: 404 });
  try {
    const snap = await refreshCard(name);
    return NextResponse.json({ fetchedAt: snap?.fetchedAt });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
