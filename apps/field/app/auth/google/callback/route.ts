import { NextResponse, type NextRequest } from 'next/server';
import {
  consumeState,
  exchangeCode,
  fetchUserInfo,
  isWhitelisted,
  storeUserTokens,
} from '@/lib/google-oauth';
import { createSession, sessionCookieAttributes, SESSION_COOKIE_NAME } from '@/lib/session';
import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('field:auth-callback');

/**
 * Google redirects back here with ?code= and ?state=.
 *
 *   1. Verify the state nonce (CSRF) and pop the returnTo path
 *   2. Exchange the code for tokens
 *   3. Fetch user info (email, name, picture)
 *   4. Enforce email whitelist
 *   5. Persist the refresh token under keys.fieldUserGoogleTokens(email)
 *   6. Mint a session and set the cookie
 *   7. Redirect back to wherever the user originally wanted to go
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return redirectToLogin(url.origin, `Google sign-in failed: ${error}`);
  }
  if (!code) {
    return redirectToLogin(url.origin, 'Missing authorization code from Google.');
  }

  const returnTo = await consumeState(state);
  if (!returnTo) {
    return redirectToLogin(url.origin, 'Sign-in session expired or invalid. Please try again.');
  }

  let tokens, userInfo;
  try {
    tokens = await exchangeCode(code, url.origin);
    userInfo = await fetchUserInfo(tokens.accessToken);
  } catch (err) {
    log.error('OAuth exchange/userinfo failed', err as Error);
    return redirectToLogin(url.origin, 'Could not complete Google sign-in. Please try again.');
  }

  if (!userInfo.email_verified) {
    return redirectToLogin(url.origin, 'Your Google email is not verified.');
  }

  if (!isWhitelisted(userInfo.email)) {
    log.warn('Whitelist rejection', { email: userInfo.email });
    return redirectToLogin(
      url.origin,
      `Access denied: ${userInfo.email} is not authorized to use this app.`,
    );
  }

  await storeUserTokens(userInfo.email, tokens);
  const sessionId = await createSession({
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
  });

  log.info('Signed in', { email: userInfo.email });

  const res = NextResponse.redirect(new URL(returnTo, url.origin));
  res.cookies.set(SESSION_COOKIE_NAME, sessionId, sessionCookieAttributes());
  return res;
}

function redirectToLogin(origin: string, message: string): NextResponse {
  const u = new URL('/login', origin);
  u.searchParams.set('error', message);
  return NextResponse.redirect(u);
}
