import { describe, it, expect } from 'vitest';
import { parseDealMarker, getDayRangeEastern, isoDateDaysAgo, extractFirstName } from '../lib/cron.js';

describe('parseDealMarker', () => {
  it('extracts the id from a [deal:N] marker', () => {
    expect(parseDealMarker('Foundation repair [deal:42]')).toBe(42);
  });

  it('is case-insensitive on the keyword', () => {
    expect(parseDealMarker('Notes here [DEAL:7]')).toBe(7);
  });

  it('finds the marker anywhere in the description', () => {
    expect(parseDealMarker('[deal:1] then more text')).toBe(1);
    expect(parseDealMarker('multi\nline\n[deal:99]\nstuff')).toBe(99);
  });

  it('returns null when no marker is present', () => {
    expect(parseDealMarker('Plain description')).toBeNull();
    expect(parseDealMarker('PipedriveID: 5')).toBeNull();
    expect(parseDealMarker('[deal:abc]')).toBeNull();
  });

  it('returns null on null/undefined/empty input', () => {
    expect(parseDealMarker(null)).toBeNull();
    expect(parseDealMarker(undefined)).toBeNull();
    expect(parseDealMarker('')).toBeNull();
  });
});

describe('extractFirstName', () => {
  it('returns the first whitespace-delimited token', () => {
    expect(extractFirstName('John Smith')).toBe('John');
    expect(extractFirstName('John')).toBe('John');
    expect(extractFirstName('John  Q  Smith')).toBe('John');
  });

  it('falls back to "there" for empty input', () => {
    expect(extractFirstName('')).toBe('there');
    expect(extractFirstName('   ')).toBe('there');
  });
});

describe('getDayRangeEastern', () => {
  it('produces a same-day Eastern range when offsetDays = 0', () => {
    const { timeMin, timeMax, dateLabel } = getDayRangeEastern(0, '2026-05-28');
    expect(dateLabel).toBe('2026-05-28');
    expect(timeMin).toBe('2026-05-28T00:00:00-04:00');
    expect(timeMax).toBe('2026-05-28T23:59:59-04:00');
  });

  it('shifts forward by +N days', () => {
    expect(getDayRangeEastern(1, '2026-05-28').dateLabel).toBe('2026-05-29');
  });

  it('shifts backward by -N days', () => {
    expect(getDayRangeEastern(-2, '2026-05-28').dateLabel).toBe('2026-05-26');
  });

  it('crosses month boundaries cleanly', () => {
    expect(getDayRangeEastern(1, '2026-05-31').dateLabel).toBe('2026-06-01');
    expect(getDayRangeEastern(-1, '2026-06-01').dateLabel).toBe('2026-05-31');
  });

  it('ignores malformed runDate and uses today', () => {
    const { dateLabel } = getDayRangeEastern(0, 'not-a-date');
    expect(dateLabel).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isoDateDaysAgo', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(isoDateDaysAgo(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoDateDaysAgo(7)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is earlier when days is larger', () => {
    const today = isoDateDaysAgo(0);
    const weekAgo = isoDateDaysAgo(7);
    expect(weekAgo < today).toBe(true);
  });
});
