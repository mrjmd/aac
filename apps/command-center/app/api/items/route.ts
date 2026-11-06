import { NextResponse, type NextRequest } from "next/server";
import { loadItemsView } from "@/lib/items";
import { requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/** GET /api/items — reconciled items for Today and the area pages. */
export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  return NextResponse.json(await loadItemsView());
}
