import { GoogleSignInClient } from "@aac/api-clients/google-signin";
import { keys, ttl } from "@aac/shared-utils/redis";
import { safeReturnPath } from "@aac/shared-utils/return-path";
import { getRedis } from "./redis";

export function getSignInClient(): GoogleSignInClient {
  const clientId = process.env.CC_GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CC_GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("CC_GOOGLE_OAUTH_CLIENT_ID and CC_GOOGLE_OAUTH_CLIENT_SECRET must be set");
  }
  return new GoogleSignInClient({ clientId, clientSecret });
}

export function redirectUri(origin: string): string {
  return `${origin}/auth/google/callback`;
}

/** Issue a CSRF state nonce that remembers where to land after sign-in. */
export async function issueState(returnTo: string): Promise<string> {
  const state = crypto.randomUUID();
  await getRedis().set(keys.ccOAuthState(state), returnTo, { ex: ttl.ccOAuthState });
  return state;
}

/** Validate and pop the state nonce. Returns the return-to path, or null. */
export async function consumeState(state: string | null): Promise<string | null> {
  if (!state) return null;
  const redis = getRedis();
  const returnTo = await redis.get<string>(keys.ccOAuthState(state));
  if (!returnTo) return null;
  await redis.del(keys.ccOAuthState(state));
  return returnTo;
}

/**
 * Only same-origin paths (pathname + search); anything else, including
 * `/\evil.com`-style tricks, falls back to the home page.
 */
export function safeReturnTo(next: string | null, origin?: string): string {
  return safeReturnPath(next, origin);
}
