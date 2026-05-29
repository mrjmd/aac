/**
 * Shared HMAC-SHA256 webhook signature verifiers.
 *
 * Quo / OpenPhone uses a single header format across every webhook
 * destination they sign, so the verifier doesn't change per app — both
 * apps/middleware (main line) and apps/agent (comms line) need an
 * identical implementation. This module is the single source of truth.
 */

import crypto from 'crypto';

/**
 * Verify a Quo/OpenPhone webhook signature.
 *
 * Header format: `hmac;1;<timestamp>;<base64-signature>`
 * Signed data: `<timestamp>.<json-payload>`
 * Secret: base64-encoded; decode to binary before HMAC.
 *
 * Returns false on any malformed header or signature mismatch. Returns
 * false (never throws) if `signatureHeader` is undefined so callers can
 * fail closed without try/catch.
 *
 * Caveat: pass the EXACT raw request body. Re-serializing JSON can
 * change byte ordering / whitespace and break verification. The
 * `request.text()` path on Vercel's Web Standard API handlers gives
 * the raw bytes; the `@vercel/node` `req.body` path does not.
 */
export function verifyOpenPhoneWebhookSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(';');
  if (parts.length !== 4) return false;

  const [scheme, version, timestamp, providedSignature] = parts;
  if (scheme !== 'hmac' || version !== '1') return false;

  const signedData = `${timestamp}.${payload}`;
  const signingKey = Buffer.from(secret, 'base64');

  const computedSignature = crypto
    .createHmac('sha256', signingKey)
    .update(signedData)
    .digest('base64');

  const provided = Buffer.from(providedSignature);
  const computed = Buffer.from(computedSignature);
  if (provided.length !== computed.length) return false;

  try {
    return crypto.timingSafeEqual(provided, computed);
  } catch {
    return false;
  }
}
