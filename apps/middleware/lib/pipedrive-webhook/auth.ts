/**
 * Pipedrive webhook authentication (HTTP Basic on the subscription).
 */

import crypto from 'crypto';

/**
 * Verify the HTTP Basic credentials Pipedrive attaches to webhook deliveries
 * (set on the webhook subscription). Timing-safe comparison, mirroring the
 * QB webhook's signature check.
 */
export function verifyPdWebhookAuth(
  authHeader: string | undefined,
  user: string,
  pass: string,
): boolean {
  if (!authHeader?.startsWith('Basic ')) return false;
  const provided = Buffer.from(authHeader.slice(6));
  const expected = Buffer.from(Buffer.from(`${user}:${pass}`).toString('base64'));
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
