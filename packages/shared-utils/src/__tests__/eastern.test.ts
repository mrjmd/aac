import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  easternDate,
  easternDayRange,
  easternMinuteOfDay,
  easternOffset,
  easternWallTime,
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
