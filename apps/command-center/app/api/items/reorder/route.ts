import { NextRequest, NextResponse } from "next/server";
import { reorderToday } from "@aac/items";
import { getItemStore } from "@/lib/items";

/** POST /api/items/reorder  { keys: string[] } — Matt's order for Today. */
export async function POST(request: NextRequest) {
  const { keys } = (await request.json()) as { keys?: string[] };
  if (!Array.isArray(keys)) return NextResponse.json({ error: "keys[] required" }, { status: 400 });
  const store = getItemStore();
  await store.putStates(reorderToday(await store.getStates(), keys));
  return NextResponse.json({ ok: true });
}
