import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function POST() {
  const jar = await cookies();
  jar.delete("aac-session");
  return NextResponse.json({ ok: true });
}
