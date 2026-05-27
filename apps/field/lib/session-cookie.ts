/**
 * Cookie-only constants for the field session. Lives in its own file so the
 * Edge middleware can import the cookie name without dragging in session.ts,
 * which transitively pulls in the Google / Redis SDKs (Node-only modules
 * that don't bundle for the Edge runtime).
 */

import { ttl } from '@aac/shared-utils/redis';

export const SESSION_COOKIE_NAME = 'field_session';

export function sessionCookieAttributes() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ttl.fieldSession,
  };
}
