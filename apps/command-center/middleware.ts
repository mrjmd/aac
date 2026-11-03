import { NextRequest, NextResponse } from "next/server";
import { readSession, SESSION_COOKIE_NAME } from "@/lib/session";

/**
 * Gate every request on a real Redis session lookup (not cookie presence).
 * Pages redirect to /login; API routes get a 401.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  const session = await readSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (session) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname + search);
  return NextResponse.redirect(loginUrl);
}

/**
 * Everything except /login, /auth/* (sign-in round trip) and static assets.
 * /api/health (uptime checks) passes in code above; /api/health/middleware
 * stays gated.
 */
export const config = {
  matcher: ["/((?!login|auth/|_next/static|_next/image|favicon.ico|fonts/).*)"],
};
