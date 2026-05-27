import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/session';

/**
 * Edge middleware — gate every request behind a session cookie.
 *
 * We only check for the *presence* of a session cookie here (Edge runtime
 * can't import the Redis client). The cookie is HttpOnly and signed by the
 * server, so its presence is a reasonable cheap filter to bounce anonymous
 * traffic to /login. Server actions and pages do the *real* session lookup
 * via getCurrentSession() — if the cookie points at a session that no
 * longer exists in Redis, those will treat the user as logged-out.
 */
export function middleware(req: NextRequest) {
  // Preview-mode short-circuit: when FIELD_AUTH_BYPASS_EMAIL is set, every
  // request passes through. Removed by deleting the env var on Vercel.
  if (process.env.FIELD_AUTH_BYPASS_EMAIL) return NextResponse.next();

  const hasCookie = !!req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (hasCookie) return NextResponse.next();

  const url = req.nextUrl;
  const next = url.pathname + (url.search || '');
  const loginUrl = new URL('/login', url);
  loginUrl.searchParams.set('next', next);
  return NextResponse.redirect(loginUrl);
}

/**
 * Run on every route EXCEPT:
 *   - /login                — the sign-in page itself
 *   - /auth/*               — OAuth start, callback, signout (must be reachable while logged-out)
 *   - /_next/*, /favicon.*  — static assets
 *
 * /api/* IS gated — including the blob-upload token issuer.
 */
export const config = {
  matcher: ['/((?!login|auth|_next|favicon|.*\\.svg$|.*\\.png$|.*\\.jpg$|.*\\.ico$).*)'],
};
