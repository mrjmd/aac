import { describe, it, expect } from 'vitest';
import { matchTaps, parseRefCode, type AdTap, type InboundEvent } from '../src/index.js';

const T = (iso: string) => new Date(iso);
const tap = (at: string, gclid: string, refCode: string | null = null, kind: 'call' | 'text' = 'call'): AdTap => ({
  at: T(at), gclid, kind, refCode,
});
const ev = (phone: string, at: string, extra: Partial<InboundEvent> = {}): InboundEvent => ({
  phone, at: T(at), kind: 'call', firstContact: true, ...extra,
});

describe('parseRefCode', () => {
  it('reads the prefilled code', () => {
    expect(parseRefCode("Hi Attack A Crack, I'd like a free quote. (Ref: K7QM)")).toBe('K7QM');
    expect(parseRefCode('ref k7qm')).toBe('K7QM');
  });
  it('ignores look-alike characters and non-codes', () => {
    expect(parseRefCode('Ref: K0QM')).toBeNull();
    expect(parseRefCode('reference number please')).toBeNull();
    expect(parseRefCode(undefined)).toBeNull();
  });
});

describe('matchTaps', () => {
  it('matches a new number inside -2/+3 min', () => {
    const r = matchTaps([tap('2026-11-05T15:00:00Z', 'g1')], [ev('6175550001', '2026-11-05T15:01:30Z')]);
    expect(r.matches).toEqual([
      { phone: '6175550001', gclid: 'g1', tapAt: '2026-11-05T15:00:00.000Z', matchedBy: 'timing', contactAt: '2026-11-05T15:01:30.000Z' },
    ]);
  });

  it('skips numbers that are not new, and events outside the window', () => {
    const r = matchTaps(
      [tap('2026-11-05T15:00:00Z', 'g1')],
      [ev('6175550001', '2026-11-05T15:01:00Z', { firstContact: false }), ev('6175550002', '2026-11-05T15:06:00Z')],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatched).toBe(1);
  });

  it('skips a window holding two new numbers', () => {
    const r = matchTaps(
      [tap('2026-11-05T15:00:00Z', 'g1')],
      [ev('6175550001', '2026-11-05T15:00:30Z'), ev('6175550002', '2026-11-05T15:01:00Z')],
    );
    expect(r.matches).toEqual([]);
    expect(r.ambiguous).toBe(1);
  });

  it('skips a number claimed by two different gclids, keeps a double tap', () => {
    const two = matchTaps(
      [tap('2026-11-05T15:00:00Z', 'g1'), tap('2026-11-05T15:01:00Z', 'g2')],
      [ev('6175550001', '2026-11-05T15:01:30Z')],
    );
    expect(two.matches).toEqual([]);
    expect(two.ambiguous).toBe(1);

    const dbl = matchTaps(
      [tap('2026-11-05T15:00:00Z', 'g1'), tap('2026-11-05T15:01:00Z', 'g1')],
      [ev('6175550001', '2026-11-05T15:01:30Z')],
    );
    expect(dbl.matches[0]).toMatchObject({ gclid: 'g1', tapAt: '2026-11-05T15:00:00.000Z' });
  });

  it('prefers the ref code, even for a known number hours later', () => {
    const r = matchTaps(
      [tap('2026-11-05T15:00:00Z', 'gRef', 'K7QM', 'text'), tap('2026-11-05T18:00:00Z', 'gOther')],
      [
        ev('6175550009', '2026-11-05T18:00:40Z', { kind: 'text', firstContact: false, text: 'quote please (Ref: K7QM)' }),
      ],
    );
    expect(r.matches).toEqual([
      { phone: '6175550009', gclid: 'gRef', tapAt: '2026-11-05T15:00:00.000Z', matchedBy: 'ref', contactAt: '2026-11-05T18:00:40.000Z' },
    ]);
  });

  it('a ref-matched number is not reused by timing', () => {
    const r = matchTaps(
      [tap('2026-11-05T15:00:00Z', 'gRef', 'K7QM', 'text'), tap('2026-11-05T15:00:00Z', 'gCall')],
      [ev('6175550009', '2026-11-05T15:00:40Z', { kind: 'text', text: '(Ref: K7QM)' })],
    );
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].gclid).toBe('gRef');
  });
});
