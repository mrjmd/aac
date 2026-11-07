import { describe, expect, it } from 'vitest';
import { fromObligation, markObligationDone, nextDue, type Obligation } from '../src/index.js';

const ob = (over: Partial<Obligation> = {}): Obligation => ({
  id: 'gl',
  title: 'General liability renewal (Kinsale via Titan)',
  category: 'insurance',
  due: '2026-11-20',
  repeat: 'yearly',
  leadDays: 14,
  confirmed: true,
  sensitive: 'money',
  ...over,
});

describe('nextDue', () => {
  it('rolls by the repeat, clamping month ends', () => {
    expect(nextDue('2026-10-13', 'yearly')).toBe('2027-10-13');
    expect(nextDue('2028-10-16', '2-yearly')).toBe('2030-10-16');
    expect(nextDue('2027-01-31', 'quarterly')).toBe('2027-04-30');
    expect(nextDue('2026-11-16', 'none')).toBeNull();
  });
});

describe('fromObligation', () => {
  it('stays quiet before its lead window, then pins to its day', () => {
    expect(fromObligation(ob(), '2026-11-05')).toBeNull();
    const c = fromObligation(ob(), '2026-11-07')!;
    expect(c).toMatchObject({ key: 'ob:gl:2026-11-20', detector: 'DATE', area: 'admin', severity: 'info', sensitive: 'money', dueOn: '2026-11-20T16:00:00.000Z' });
    expect(c.title).toContain('due in 13d');
  });

  it('turns yellow inside a week and red on the day and after', () => {
    expect(fromObligation(ob(), '2026-11-15')!.severity).toBe('yellow');
    expect(fromObligation(ob(), '2026-11-20')!.severity).toBe('red');
    expect(fromObligation(ob(), '2026-11-22')!.title).toContain('2d overdue');
  });

  it('says who handles it and flags an unconfirmed date', () => {
    const c = fromObligation(ob({ handledBy: 'Datapay', confirmed: false }), '2026-11-15')!;
    expect(c.action).toContain('Check Datapay');
    expect(c.detail).toContain('not confirmed');
  });

  it('a date we don\'t know never becomes an item', () => {
    expect(fromObligation(ob({ due: null }), '2026-11-15')).toBeNull();
  });
});

describe('markObligationDone', () => {
  it('moves a repeating one to its next date, which is a new item', () => {
    const done = markObligationDone(ob(), '2026-11-18');
    expect(done).toMatchObject({ due: '2027-11-20', lastDone: '2026-11-18' });
    expect(fromObligation(done, '2026-11-25')).toBeNull();
  });

  it('closes a one-off for good', () => {
    const done = markObligationDone(ob({ repeat: 'none' }), '2026-11-18');
    expect(done.closed).toBe(true);
    expect(fromObligation(done, '2026-11-20')).toBeNull();
  });
});
