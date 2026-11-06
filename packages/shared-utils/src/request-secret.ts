/**
 * Shared-secret request checks: "does this request carry the secret?"
 *
 * One implementation for every endpoint gated by a shared secret, whether it
 * arrives as `Authorization: Bearer <secret>` (Vercel cron, owner-only links)
 * or as a custom header (`x-worker-secret`, `x-scheduling-proposal-secret`).
 *
 * Both checks:
 *  - fail closed: an unset or empty secret never matches anything, so a
 *    missing env var cannot open an endpoint;
 *  - compare in constant time (via `timingSafeEqualString`).
 *
 * They return a boolean only. Endpoints that answer "not configured" (500 or
 * 503) differently from "wrong secret" (401) keep that pre-check themselves.
 *
 * Header values are accepted in every shape the runtimes hand back: a string
 * or null from Web `Headers.get()`, and string | string[] | undefined from
 * Node's `IncomingMessage.headers` (first value wins for repeated headers).
 */

import { timingSafeEqualString } from './webhook-signature.js';

/** A header value as either the Web or Node request APIs return it. */
export type HeaderValue = string | readonly string[] | null | undefined;

function firstValue(value: HeaderValue): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  return value[0];
}

/**
 * True when `authorization` is exactly `Bearer <secret>`. The scheme is
 * case-sensitive and takes a single space, matching the
 * `header === \`Bearer ${secret}\`` checks this replaces.
 */
export function hasBearerSecret(
  authorization: HeaderValue,
  secret: string | null | undefined,
): boolean {
  if (!secret) return false;
  return timingSafeEqualString(firstValue(authorization), `Bearer ${secret}`);
}

/** True when a custom secret header (e.g. `x-worker-secret`) equals `secret`. */
export function hasHeaderSecret(
  value: HeaderValue,
  secret: string | null | undefined,
): boolean {
  if (!secret) return false;
  return timingSafeEqualString(firstValue(value), secret);
}
