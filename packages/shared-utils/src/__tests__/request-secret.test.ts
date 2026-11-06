import { describe, it, expect } from 'vitest';
import { hasBearerSecret, hasHeaderSecret } from '../request-secret.js';

describe('hasBearerSecret', () => {
  it('accepts exactly "Bearer <secret>"', () => {
    expect(hasBearerSecret('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong secret, wrong scheme, case, or spacing', () => {
    expect(hasBearerSecret('Bearer nope', 's3cret')).toBe(false);
    expect(hasBearerSecret('bearer s3cret', 's3cret')).toBe(false);
    expect(hasBearerSecret('Basic s3cret', 's3cret')).toBe(false);
    expect(hasBearerSecret('Bearer  s3cret', 's3cret')).toBe(false);
    expect(hasBearerSecret('Bearer s3cret ', 's3cret')).toBe(false);
    expect(hasBearerSecret('s3cret', 's3cret')).toBe(false);
    expect(hasBearerSecret('Bearer ', 's3cret')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(hasBearerSecret(undefined, 's3cret')).toBe(false);
    expect(hasBearerSecret(null, 's3cret')).toBe(false);
    expect(hasBearerSecret('', 's3cret')).toBe(false);
  });

  it('fails closed when the secret is unset or empty', () => {
    expect(hasBearerSecret('Bearer ', '')).toBe(false);
    expect(hasBearerSecret('Bearer undefined', undefined)).toBe(false);
    expect(hasBearerSecret('Bearer null', null)).toBe(false);
    expect(hasBearerSecret(undefined, undefined)).toBe(false);
  });

  it('uses the first value of a repeated (array) header', () => {
    expect(hasBearerSecret(['Bearer s3cret', 'Bearer nope'], 's3cret')).toBe(true);
    expect(hasBearerSecret(['Bearer nope', 'Bearer s3cret'], 's3cret')).toBe(false);
    expect(hasBearerSecret([], 's3cret')).toBe(false);
  });
});

describe('hasHeaderSecret', () => {
  it('accepts an exact match', () => {
    expect(hasHeaderSecret('s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong value, case, or surrounding whitespace', () => {
    expect(hasHeaderSecret('nope', 's3cret')).toBe(false);
    expect(hasHeaderSecret('S3CRET', 's3cret')).toBe(false);
    expect(hasHeaderSecret(' s3cret', 's3cret')).toBe(false);
    expect(hasHeaderSecret('Bearer s3cret', 's3cret')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(hasHeaderSecret(undefined, 's3cret')).toBe(false);
    expect(hasHeaderSecret(null, 's3cret')).toBe(false);
    expect(hasHeaderSecret('', 's3cret')).toBe(false);
  });

  it('fails closed when the secret is unset or empty', () => {
    expect(hasHeaderSecret('', '')).toBe(false);
    expect(hasHeaderSecret('x', undefined)).toBe(false);
    expect(hasHeaderSecret('x', null)).toBe(false);
  });

  it('uses the first value of a repeated (array) header', () => {
    expect(hasHeaderSecret(['s3cret', 'nope'], 's3cret')).toBe(true);
    expect(hasHeaderSecret(['nope', 's3cret'], 's3cret')).toBe(false);
  });
});
