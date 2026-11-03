import { NextResponse } from "next/server";
import { loadItemsView } from "@/lib/items";

export const dynamic = "force-dynamic";

/** GET /api/items — reconciled items for Today and the area pages. */
export async function GET() {
  return NextResponse.json(await loadItemsView());
}
