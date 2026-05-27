import { NextResponse, type NextRequest } from 'next/server';
import { buildAuthorizeUrl } from '@/lib/google-oauth';

/**
 * Kicks off the OAuth flow. Captures an optional ?next= return-to path
 * (the page the user originally tried to reach before being bounced to login),
 * stores it in Redis under a CSRF state nonce, then 302s to Google.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const next = url.searchParams.get('next') ?? '/';
  // Only allow relative paths back into the app — refuse open-redirect attempts.
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const target = await buildAuthorizeUrl(url.origin, safeNext);
  return NextResponse.redirect(target);
}
