import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnPath } from '@aac/shared-utils/return-path';
import { buildAuthorizeUrl } from '@/lib/google-oauth';

/**
 * Kicks off the OAuth flow. Captures an optional ?next= return-to path
 * (the page the user originally tried to reach before being bounced to login),
 * stores it in Redis under a CSRF state nonce, then 302s to Google.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // Only same-origin paths back into the app — refuse open-redirect attempts
  // (including `/\evil.com`, which a prefix check misses).
  const safeNext = safeReturnPath(url.searchParams.get('next'), url.origin);
  const target = await buildAuthorizeUrl(url.origin, safeNext);
  return NextResponse.redirect(target);
}
