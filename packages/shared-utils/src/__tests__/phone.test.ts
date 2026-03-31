import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  parsePhone,
  phonesMatch,
  toRedisPhone,
  quickNormalizePhone,
} from '../phone.js';

describe('normalizePhone', () => {
  it('normalizes standard US formats to E.164', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555-123-4567')).toBe('+15551234567');
    expect(normalizePhone('555.123.4567')).toBe('+15551234567');
    expect(normalizePhone('5551234567')).toBe('+15551234567');
  });

  it('normalizes 11-digit US numbers', () => {
    expect(normalizePhone('15551234567')).toBe('+15551234567');
    expect(normalizePhone('1-555-123-4567')).toBe('+15551234567');
  });

  it('normalizes E.164 format (passthrough)', () => {
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
    expect(normalizePhone('+1 555 123 4567')).toBe('+15551234567');
  });

  it('returns null for invalid input', () => {
    expect(normalizePhone('invalid')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('trims whitespace', () => {
    expect(normalizePhone('  (555) 123-4567  ')).toBe('+15551234567');
  });

  it('rejects numbers that are too short', () => {
    expect(normalizePhone('555-1234')).toBeNull(); // 7 digits
  });
});

describe('parsePhone', () => {
  it('returns detailed parse result for valid numbers', () => {
    const result = parsePhone('(415) 555-1234');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+14155551234');
    expect(result!.national).toBe('(415) 555-1234');
    expect(result!.country).toBe('US');
  });

  it('returns null for invalid numbers', () => {
    expect(parsePhone('invalid')).toBeNull();
    expect(parsePhone(null)).toBeNull();
    expect(parsePhone(undefined)).toBeNull();
  });
});

describe('phonesMatch', () => {
  it('matches same number in different formats', () => {
    expect(phonesMatch('(555) 123-4567', '5551234567')).toBe(true);
    expect(phonesMatch('+15551234567', '555-123-4567')).toBe(true);
    expect(phonesMatch('15551234567', '(555) 123-4567')).toBe(true);
  });

  it('rejects different numbers', () => {
    expect(phonesMatch('(555) 123-4567', '(555) 123-4568')).toBe(false);
  });

  it('returns false for null/invalid inputs', () => {
    expect(phonesMatch(null, '5551234567')).toBe(false);
    expect(phonesMatch('5551234567', null)).toBe(false);
    expect(phonesMatch(null, null)).toBe(false);
    expect(phonesMatch('invalid', '5551234567')).toBe(false);
  });
});

describe('toRedisPhone', () => {
  it('converts E.164 to 10-digit', () => {
    expect(toRedisPhone('+14155551234')).toBe('4155551234');
  });

  it('converts 11-digit with leading 1', () => {
    expect(toRedisPhone('14155551234')).toBe('4155551234');
  });

  it('passes through 10-digit', () => {
    expect(toRedisPhone('4155551234')).toBe('4155551234');
  });

  it('strips non-digits and normalizes', () => {
    expect(toRedisPhone('(415) 555-1234')).toBe('4155551234');
  });

  it('handles longer numbers by taking last 10 digits', () => {
    expect(toRedisPhone('+441234567890')).toBe('1234567890');
  });

  it('returns null for too-short numbers', () => {
    expect(toRedisPhone('12345')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(toRedisPhone(null)).toBeNull();
    expect(toRedisPhone(undefined)).toBeNull();
  });
});

describe('quickNormalizePhone', () => {
  it('normalizes 10-digit numbers to E.164', () => {
    expect(quickNormalizePhone('4155551234')).toBe('+14155551234');
  });

  it('normalizes 11-digit with leading 1', () => {
    expect(quickNormalizePhone('14155551234')).toBe('+14155551234');
  });

  it('strips non-digits first', () => {
    expect(quickNormalizePhone('(415) 555-1234')).toBe('+14155551234');
  });

  it('returns null for non-US formats', () => {
    expect(quickNormalizePhone('+441234567890')).toBeNull();
    expect(quickNormalizePhone('12345')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(quickNormalizePhone(null)).toBeNull();
    expect(quickNormalizePhone(undefined)).toBeNull();
  });
});
