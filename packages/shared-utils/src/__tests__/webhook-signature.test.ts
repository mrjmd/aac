import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { verifyOpenPhoneWebhookSignature } from '../webhook-signature.js';

// Use a base64-encoded "secret" (OpenPhone keys are b64-encoded in their UI;
// the verifier decodes to binary before HMAC). The exact bytes don't matter
// for the test — only that the same secret is used on both ends.
const SECRET = Buffer.from('test-secret-bytes', 'utf8').toString('base64');

function sign(payload: string, timestamp: string, secret: string): string {
  const signedData = `${timestamp}.${payload}`;
  const signingKey = Buffer.from(secret, 'base64');
  return crypto.createHmac('sha256', signingKey).update(signedData).digest('base64');
}

function header(timestamp: string, signature: string): string {
  return `hmac;1;${timestamp};${signature}`;
}

describe('verifyOpenPhoneWebhookSignature', () => {
  it('accepts a valid signature', () => {
    const payload = '{"object":{"id":"evt_1","type":"message.received"}}';
    const ts = '1700000000000';
    const sig = sign(payload, ts, SECRET);
    expect(verifyOpenPhoneWebhookSignature(payload, header(ts, sig), SECRET)).toBe(true);
  });

  it('rejects when the payload is tampered', () => {
    const ts = '1700000000000';
    const sig = sign('{"a":1}', ts, SECRET);
    expect(verifyOpenPhoneWebhookSignature('{"a":2}', header(ts, sig), SECRET)).toBe(false);
  });

  it('rejects when the timestamp is changed', () => {
    const payload = '{"a":1}';
    const sig = sign(payload, '1700000000000', SECRET);
    expect(verifyOpenPhoneWebhookSignature(payload, header('1700000099999', sig), SECRET)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const payload = '{"a":1}';
    const ts = '1700000000000';
    const sig = sign(payload, ts, SECRET);
    const otherSecret = Buffer.from('different', 'utf8').toString('base64');
    expect(verifyOpenPhoneWebhookSignature(payload, header(ts, sig), otherSecret)).toBe(false);
  });

  it('returns false when the header is missing', () => {
    expect(verifyOpenPhoneWebhookSignature('{}', undefined, SECRET)).toBe(false);
  });

  it('returns false when the header is malformed (wrong segment count)', () => {
    expect(verifyOpenPhoneWebhookSignature('{}', 'hmac;1;ts', SECRET)).toBe(false);
    expect(verifyOpenPhoneWebhookSignature('{}', 'too;many;segments;here;extra', SECRET)).toBe(false);
  });

  it('returns false on unsupported scheme or version', () => {
    const ts = '1700000000000';
    const sig = sign('{}', ts, SECRET);
    expect(verifyOpenPhoneWebhookSignature('{}', `sha256;1;${ts};${sig}`, SECRET)).toBe(false);
    expect(verifyOpenPhoneWebhookSignature('{}', `hmac;2;${ts};${sig}`, SECRET)).toBe(false);
  });

  it('returns false (no throw) on garbage signatures of different length', () => {
    const ts = '1700000000000';
    expect(verifyOpenPhoneWebhookSignature('{}', header(ts, 'short'), SECRET)).toBe(false);
    expect(verifyOpenPhoneWebhookSignature('{}', header(ts, 'a'.repeat(1000)), SECRET)).toBe(false);
  });
});
