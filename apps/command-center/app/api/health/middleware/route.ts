import { NextResponse, type NextRequest } from "next/server";
import { readMiddlewareHealth } from "@/lib/system-health";
import { requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const data = await readMiddlewareHealth();
  return NextResponse.json(data);
}
