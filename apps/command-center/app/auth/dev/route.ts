import { NextResponse, type NextRequest } from "next/server";
import { safeReturnTo } from "@/lib/google-signin";
import { createSession, sessionCookieAttributes, SESSION_COOKIE_NAME } from "@/lib/session";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * GET /auth/dev?next=/path — local development only: signs in as the first
 * CC_ALLOWED_EMAILS address without the Google round trip, so the app can
 * be opened on this Mac before the production OAuth client exists. 404s
 * in any production build and on any non-local host.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const email = (process.env.CC_ALLOWED_EMAILS ?? "").split(",")[0]?.trim();
  if (process.env.NODE_ENV !== "development" || !LOCAL_HOSTS.has(url.hostname) || !email) {
    return new NextResponse("Not found", { status: 404 });
  }
  const sessionId = await createSession({ email, name: "Local dev" });
  const res = NextResponse.redirect(new URL(safeReturnTo(url.searchParams.get("next")), url.origin));
  res.cookies.set(SESSION_COOKIE_NAME, sessionId, sessionCookieAttributes());
  return res;
}
