/**
 * Command-center sessions (audit P0-5 fix).
 *
 * Opaque session ID in an HttpOnly cookie; the payload lives in Redis under
 * keys.ccSession(id), so a session is revocable and the gate is a real lookup,
 * not cookie presence. Edge-safe (Upstash Redis is fetch-based), so the
 * middleware verifies every request, API routes included.
 */

import { keys, ttl } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

export const SESSION_COOKIE_NAME = "cc_session";

export interface CcSession {
  email: string;
  name: string;
  picture?: string;
  createdAt: string;
  lastUsedAt: string;
}

export function sessionCookieAttributes() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: ttl.ccSession,
  };
}

/** Mint a session for a signed-in, allowlisted user; returns the cookie value. */
export async function createSession(profile: {
  email: string;
  name: string;
  picture?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const session: CcSession = {
    email: profile.email.toLowerCase(),
    name: profile.name,
    picture: profile.picture,
    createdAt: now,
    lastUsedAt: now,
  };
  await getRedis().set(keys.ccSession(id), session, { ex: ttl.ccSession });
  return id;
}

/**
 * Look up a session by cookie value. Renews the TTL on hit so an active
 * user stays signed in. Returns null for a missing or expired session.
 */
export async function readSession(id: string | undefined): Promise<CcSession | null> {
  if (!id) return null;
  const redis = getRedis();
  const session = await redis.get<CcSession>(keys.ccSession(id));
  if (!session) return null;
  const renewed: CcSession = { ...session, lastUsedAt: new Date().toISOString() };
  void redis.set(keys.ccSession(id), renewed, { ex: ttl.ccSession });
  return renewed;
}

export async function deleteSession(id: string | undefined): Promise<void> {
  if (id) await getRedis().del(keys.ccSession(id));
}

/** CC_ALLOWED_EMAILS is a comma-separated allowlist. Empty or unset denies everyone. */
export function isAllowed(email: string): boolean {
  const allowed = (process.env.CC_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}
