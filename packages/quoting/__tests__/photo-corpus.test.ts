import { describe, it, expect } from 'vitest';
import {
  attributePhoto,
  daysBetween,
  messagesWithinWindow,
  type CorpusEstimateRef,
} from '../src/photo-corpus.js';

const est = (id: string, txnDate: string): CorpusEstimateRef => ({
  estimateId: id,
  docNumber: `#${id}`,
  txnDate,
});

describe('daysBetween', () => {
  it('counts whole days from timestamp to date', () => {
    expect(daysBetween('2026-10-01T15:30:00Z', '2026-10-05')).toBe(4);
    expect(daysBetween('2026-10-05T00:00:00Z', '2026-10-05')).toBe(0);
    expect(daysBetween('2026-10-08T09:00:00Z', '2026-10-05')).toBe(-3);
  });

  it('crosses month and year boundaries', () => {
    expect(daysBetween('2025-12-28', '2026-01-02')).toBe(5);
  });
});

describe('attributePhoto', () => {
  it('attributes a photo sent days before the estimate', () => {
    const r = attributePhoto('2026-09-28T12:00:00Z', [est('100', '2026-10-01')]);
    expect(r.estimateId).toBe('100');
    expect(r.daysBeforeEstimate).toBe(3);
    expect(r.ambiguousWith).toEqual([]);
  });

  it('attributes a photo sent shortly after the estimate', () => {
    const r = attributePhoto('2026-10-04T12:00:00Z', [est('100', '2026-10-01')]);
    expect(r.estimateId).toBe('100');
    expect(r.daysBeforeEstimate).toBe(-3);
  });

  it('returns an orphan outside the window', () => {
    const r = attributePhoto('2026-06-01T12:00:00Z', [est('100', '2026-10-01')]);
    expect(r.estimateId).toBeNull();
    expect(r.daysBeforeEstimate).toBeNull();
  });

  it('rejects photos beyond afterDays even when close', () => {
    const r = attributePhoto('2026-10-15T12:00:00Z', [est('100', '2026-10-01')], {
      afterDays: 10,
    });
    expect(r.estimateId).toBeNull();
  });

  it('picks the nearest estimate and flags the other as ambiguous', () => {
    const r = attributePhoto('2026-09-28T12:00:00Z', [
      est('100', '2026-10-01'),
      est('200', '2026-10-20'),
    ]);
    expect(r.estimateId).toBe('100');
    expect(r.ambiguousWith).toEqual(['200']);
  });

  it('is unambiguous when only one window contains the photo', () => {
    const r = attributePhoto('2026-09-28T12:00:00Z', [
      est('100', '2026-10-01'),
      est('200', '2027-03-01'),
    ]);
    expect(r.estimateId).toBe('100');
    expect(r.ambiguousWith).toEqual([]);
  });
});

describe('messagesWithinWindow', () => {
  const msgs = [
    { at: '2026-08-01T10:00:00Z', text: 'way early' },
    { at: '2026-09-20T10:00:00Z', text: 'in window' },
    { at: '2026-10-05T10:00:00Z', text: 'just after' },
    { at: '2026-11-01T10:00:00Z', text: 'way late' },
  ];

  it('keeps only messages inside the attribution window', () => {
    const kept = messagesWithinWindow(msgs, '2026-10-01');
    expect(kept.map((m) => m.text)).toEqual(['in window', 'just after']);
  });
});
