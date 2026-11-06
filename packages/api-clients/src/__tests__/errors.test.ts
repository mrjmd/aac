import { describe, it, expect } from 'vitest';
import { VendorHttpError, isVendorHttpError } from '../errors.js';

describe('VendorHttpError', () => {
  it('is an Error with vendor, status and the original message', () => {
    const err = new VendorHttpError('quo', 503, 'Quo API error: 503 - down');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('VendorHttpError');
    expect(err.vendor).toBe('quo');
    expect(err.status).toBe(503);
    expect(err.message).toBe('Quo API error: 503 - down');
  });
});

describe('isVendorHttpError', () => {
  it('matches 4xx and 5xx vendor errors', () => {
    expect(isVendorHttpError(new VendorHttpError('quo', 400, 'x'))).toBe(true);
    expect(isVendorHttpError(new VendorHttpError('quickbooks', 599, 'x'))).toBe(true);
  });

  it('rejects transport errors and non-errors', () => {
    expect(isVendorHttpError(new TypeError('fetch failed'))).toBe(false);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isVendorHttpError(abort)).toBe(false);
    expect(isVendorHttpError({ name: 'VendorHttpError', status: 500 })).toBe(false);
    expect(isVendorHttpError(undefined)).toBe(false);
  });

  it('rejects a status outside 4xx/5xx', () => {
    expect(isVendorHttpError(new VendorHttpError('quo', 302, 'x'))).toBe(false);
  });

  it('matches structurally across module copies', () => {
    const copy = Object.assign(new Error('Quo API error: 500'), { name: 'VendorHttpError', status: 500 });
    expect(isVendorHttpError(copy)).toBe(true);
  });
});
