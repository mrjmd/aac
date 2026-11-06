import { NextResponse, type NextRequest } from "next/server";
import { consumeState, getSignInClient, redirectUri, safeReturnTo } from "@/lib/google-signin";
import { createSession, isAllowed, sessionCookieAttributes, SESSION_COOKIE_NAME } from "@/lib/session";
import { createLogger } from "@aac/shared-utils/logger";

const log = createLogger("command-center:auth-callback");

/**
 * Google redirects back here with ?code= and ?state=.
 * Verify state (CSRF), exchange the code, check the email allowlist,
 * then mint a Redis-backed session.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error) return redirectToLogin(url.origin, `Google sign-in failed: ${error}`);
  if (!code) return redirectToLogin(url.origin, "Missing authorization code from Google.");

  const returnTo = await consumeState(url.searchParams.get("state"));
  if (!returnTo) return redirectToLogin(url.origin, "Sign-in expired. Please try again.");

  let userInfo;
  try {
    const client = getSignInClient();
    const tokens = await client.exchangeCode(code, redirectUri(url.origin));
    userInfo = await client.fetchUserInfo(tokens.accessToken);
  } catch (err) {
    log.error("OAuth exchange/userinfo failed", err as Error);
    return redirectToLogin(url.origin, "Could not complete Google sign-in. Please try again.");
  }

  if (!userInfo.email_verified || !isAllowed(userInfo.email)) {
    log.warn("Sign-in rejected", { email: userInfo.email });
    return redirectToLogin(url.origin, `${userInfo.email} is not allowed to use the command center.`);
  }

  const sessionId = await createSession({
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
  });
  log.info("Signed in", { email: userInfo.email });

  const res = NextResponse.redirect(new URL(safeReturnTo(returnTo, url.origin), url.origin));
  res.cookies.set(SESSION_COOKIE_NAME, sessionId, sessionCookieAttributes());
  return res;
}

function redirectToLogin(origin: string, message: string): NextResponse {
  const u = new URL("/login", origin);
  u.searchParams.set("error", message);
  return NextResponse.redirect(u);
}
