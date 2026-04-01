import { NextResponse } from "next/server";
import { fetchMiddlewareHealth } from "@/lib/middleware-health";

export const revalidate = 30;

export async function GET() {
  const data = await fetchMiddlewareHealth();
  return NextResponse.json(data);
}
