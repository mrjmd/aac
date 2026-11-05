import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  easternDate,
  easternDayRange,
  easternMinuteOfDay,
  easternOffset,
  easternWallTime,
  isCalendarDate,
  shiftDate,
} from '../eastern';

describe('easternDate', () => {
  it('uses the Eastern calendar day, not UTC', () => {
    // 02:30Z on Nov 6 is still 9:30 PM Nov 5 in Eastern.
    expect(easternDate('2026-11-06T02:30:00Z')).toBe('2026-11-05');
    expect(easternDate(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30');
  });
});

describe('easternOffset / easternDayRange', () => {
  it('follows DST', () => {
    expect(easternOffset('2026-11-05')).toBe('-05:00');
    expect(easternOffset('2026-07-01')).toBe('-04:00');
    expect(easternDayRange('2026-11-05')).toEqual({
      timeMin: '2026-11-05T00:00:00-05:00',
      timeMax: '2026-11-05T23:59:59-05:00',
      dateLabel: '2026-11-05',
    });
  });
  it('covers clock-change days midnight to midnight', () => {
    // Fall back: 25h day, starts EDT, ends EST.
    const fall = easternDayRange('2026-11-01');
    expect(fall.timeMin).toBe('2026-11-01T00:00:00-04:00');
    expect(fall.timeMax).toBe('2026-11-01T23:59:59-05:00');
    // Spring forward: 23h day, starts EST, ends EDT.
    const spring = easternDayRange('2026-03-08');
    expect(spring.timeMin).toBe('2026-03-08T00:00:00-05:00');
    expect(spring.timeMax).toBe('2026-03-08T23:59:59-04:00');
  });
});

describe('isCalendarDate', () => {
  it('accepts real days and rejects impossible ones', () => {
    expect(isCalendarDate('2026-11-05')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-11-00')).toBe(false);
    expect(isCalendarDate('nope')).toBe(false);
  });
});

describe('easternWallTime / easternMinuteOfDay', () => {
  it('round-trips a wall-clock time in both seasons', () => {
    expect(easternWallTime('2026-11-05', 9, 30).toISOString()).toBe('2026-11-05T14:30:00.000Z');
    expect(easternWallTime('2026-07-01', 9).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(easternMinuteOfDay('2026-11-05T14:30:00Z')).toBe(9 * 60 + 30);
  });
});

describe('shiftDate / daysBetween', () => {
  it('does plain calendar math across month and DST edges', () => {
    expect(shiftDate('2026-10-31', 2)).toBe('2026-11-02');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-11-01', '2026-11-08')).toBe(7);
    expect(daysBetween('2026-11-01T23:00:00Z', '2026-11-08')).toBe(7);
  });
});
