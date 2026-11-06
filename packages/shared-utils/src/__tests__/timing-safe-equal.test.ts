import { describe, it, expect } from 'vitest';
import { timingSafeEqualString } from '../webhook-signature.js';

describe('timingSafeEqualString', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqualString('s3cret-value', 's3cret-value')).toBe(true);
    expect(timingSafeEqualString('ünïcødé', 'ünïcødé')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(timingSafeEqualString('s3cret-value', 's3cret-valuX')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(timingSafeEqualString('short', 'much-longer-secret')).toBe(false);
    expect(timingSafeEqualString('s3cret-value-and-more', 's3cret-value')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(timingSafeEqualString('Secret', 'secret')).toBe(false);
  });

  it('fails closed on missing or empty values', () => {
    expect(timingSafeEqualString(undefined, 'secret')).toBe(false);
    expect(timingSafeEqualString(null, 'secret')).toBe(false);
    expect(timingSafeEqualString('', 'secret')).toBe(false);
    expect(timingSafeEqualString('secret', undefined)).toBe(false);
    expect(timingSafeEqualString('secret', '')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(false);
    expect(timingSafeEqualString(undefined, undefined)).toBe(false);
  });
});
