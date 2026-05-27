/**
 * Field-app session management.
 *
 * Sessions are opaque IDs in an HttpOnly Secure cookie, with the actual
 * session payload stored server-side in Redis. This makes sessions
 * revocable (delete the Redis entry) and lets us extend TTL on use.
 *
 * Refresh tokens from Google live in a separate keyspace
 * (keys.fieldUserGoogleTokens) so a session can be revoked without
 * dropping the user's Google authorization (and vice versa).
 */

import 'server-only';
import { cookies } from 'next/headers';
import { keys, ttl } from '@aac/shared-utils/redis';
import { getRedis } from './clients';
import { SESSION_COOKIE_NAME } from './session-cookie';

export { SESSION_COOKIE_NAME, sessionCookieAttributes } from './session-cookie';

export interface FieldSession {
  email: string;
  name: string;
  picture?: string;
  createdAt: string;
  lastUsedAt: string;
}

/** Mint a new session for an authenticated user; returns the session ID to put in the cookie. */
export async function createSession(profile: {
  email: string;
  name: string;
  picture?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const session: FieldSession = {
    email: profile.email.toLowerCase(),
    name: profile.name,
    picture: profile.picture,
    createdAt: now,
    lastUsedAt: now,
  };
  await getRedis().set(keys.fieldSession(id), session, { ex: ttl.fieldSession });
  return id;
}

/**
 * Look up the current session from the cookie, if any. Renews TTL on hit so
 * an active user effectively never logs out. Returns null when no cookie,
 * no Redis entry, or the entry has expired.
 *
 * Preview short-circuit: when FIELD_AUTH_BYPASS_EMAIL is set, returns a
 * synthetic session with that email. No cookie or Redis lookup happens.
 */
export async function getCurrentSession(): Promise<FieldSession | null> {
  const bypass = process.env.FIELD_AUTH_BYPASS_EMAIL?.trim().toLowerCase();
  if (bypass) {
    const now = new Date().toISOString();
    return {
      email: bypass,
      name: 'Preview Mode',
      createdAt: now,
      lastUsedAt: now,
    };
  }

  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!id) return null;

  const redis = getRedis();
  const session = await redis.get<FieldSession>(keys.fieldSession(id));
  if (!session) return null;

  // Renew (extend TTL + bump lastUsedAt). Fire-and-forget — don't block the response.
  const renewed: FieldSession = { ...session, lastUsedAt: new Date().toISOString() };
  void redis.set(keys.fieldSession(id), renewed, { ex: ttl.fieldSession });
  return renewed;
}

/** Requires an active session — for use in server actions and protected pages. */
export async function requireSession(): Promise<FieldSession> {
  const session = await getCurrentSession();
  if (!session) throw new Error('Not authenticated');
  return session;
}

/** Wipe the current session both in Redis and in the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE_NAME)?.value;
  if (id) {
    await getRedis().del(keys.fieldSession(id));
    jar.delete(SESSION_COOKIE_NAME);
  }
}

