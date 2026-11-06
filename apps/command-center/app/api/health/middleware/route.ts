import { NextResponse, type NextRequest } from "next/server";
import { fetchMiddlewareHealth } from "@/lib/middleware-health";
import { requireApiSession } from "@/lib/api-auth";

export const revalidate = 30;

export async function GET(request: NextRequest) {
  const denied = await requireApiSession(request);
  if (denied) return denied;
  const data = await fetchMiddlewareHealth();
  return NextResponse.json(data);
}
