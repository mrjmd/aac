import { NextResponse, type NextRequest } from "next/server";
import { deleteSession, SESSION_COOKIE_NAME } from "@/lib/session";

/** POST /auth/signout — revoke the session in Redis and clear the cookie. */
export async function POST(req: NextRequest) {
  await deleteSession(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
}
