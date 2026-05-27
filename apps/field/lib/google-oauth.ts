/**
 * Google OAuth 2.0 helpers for the field app.
 *
 * Reuses the monorepo's existing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * (registered in Google Cloud Console). The field app adds its own
 * redirect URI: `${origin}/auth/google/callback`.
 *
 * Scopes requested at login (all up-front, so Phase B doesn't trigger a
 * second consent flow):
 *   - openid / email / profile  → identify the signed-in user
 *   - drive.file                 → upload photos to the user's Drive
 *                                  (only files the app creates — least privilege)
 *   - calendar.events            → attach the uploaded photo to the calendar event
 *
 * Refresh tokens don't expire and are stored per-user in Redis under
 * keys.fieldUserGoogleTokens(email).
 */

import 'server-only';

import { keys, ttl } from '@aac/shared-utils/redis';
import { getRedis } from './clients';
import { getEnv } from './env';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events',
];

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export function redirectUri(origin: string): string {
  return `${origin}/auth/google/callback`;
}

/** Build the Google consent URL with a freshly issued, Redis-tracked state nonce for CSRF. */
export async function buildAuthorizeUrl(origin: string, returnTo: string): Promise<string> {
  const env = getEnv();
  const state = crypto.randomUUID();
  // Store the return-to path under the state nonce so the callback can verify+redirect.
  await getRedis().set(keys.fieldOAuthState(state), returnTo, { ex: ttl.fieldOAuthState });

  const params = new URLSearchParams({
    client_id: env.fieldOAuth.clientId,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // access_type=offline + prompt=consent guarantees we get a refresh_token
    // even on repeat logins (Google omits it otherwise).
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Validates the CSRF state nonce and pops it from Redis. Returns the original returnTo. */
export async function consumeState(state: string | null): Promise<string | null> {
  if (!state) return null;
  const redis = getRedis();
  const returnTo = await redis.get<string>(keys.fieldOAuthState(state));
  if (!returnTo) return null;
  await redis.del(keys.fieldOAuthState(state));
  return returnTo;
}

export interface GoogleTokens {
  accessToken: string;
  /** Google only returns refresh_token on the first consent (or with prompt=consent). */
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  idToken?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

/** Exchange the authorization code from the callback for tokens. */
export async function exchangeCode(code: string, origin: string): Promise<GoogleTokens> {
  const env = getEnv();
  const body = new URLSearchParams({
    code,
    client_id: env.fieldOAuth.clientId,
    client_secret: env.fieldOAuth.clientSecret,
    redirect_uri: redirectUri(origin),
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    idToken: data.id_token,
  };
}

/** Look up profile (email, name, picture) for the signed-in user. */
export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google userinfo failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GoogleUserInfo;
}

/** Persist the user's refresh token + last access token. Keyed by lowercased email. */
export async function storeUserTokens(email: string, tokens: GoogleTokens): Promise<void> {
  // Only overwrite the refresh token if Google sent us a new one. (It only
  // returns refresh_token on first consent OR with prompt=consent — we use
  // prompt=consent so should always have it, but be defensive.)
  const redis = getRedis();
  const key = keys.fieldUserGoogleTokens(email);
  if (tokens.refreshToken) {
    await redis.set(key, tokens);
  } else {
    const existing = await redis.get<GoogleTokens>(key);
    await redis.set(key, { ...(existing ?? {}), ...tokens, refreshToken: existing?.refreshToken });
  }
}

/** Whitelist check — only emails in env.AUTH_WHITELIST_EMAILS may proceed past OAuth. */
export function isWhitelisted(email: string): boolean {
  const env = getEnv();
  return env.authWhitelist.includes(email.toLowerCase());
}
