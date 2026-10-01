import { describe, it, expect } from 'vitest';
import {
  baseTitle,
  normalizedStreet,
  findContinuation,
  hasContinuation,
  type MultidayEvent,
} from '../multiday';

const ev = (over: Partial<MultidayEvent> & { id: string; start: string }): MultidayEvent => ({
  summary: 'Ed Spooner',
  location: '188 King Street, Hanover, Massachusetts, 02339',
  colorId: '10',
  ...over,
});

describe('baseTitle', () => {
  it('strips a trailing [cont] marker', () => {
    expect(baseTitle('Ed Spooner [cont]')).toBe('ed spooner');
  });
  it('strips parenthesized markers and extra whitespace', () => {
    expect(baseTitle('Kevin Malderelli  (cont) ')).toBe('kevin malderelli');
    expect(baseTitle('  Geoff  O’Donnell ')).toBe('geoff o’donnell');
  });
  it('leaves plain titles alone and handles undefined', () => {
    expect(baseTitle('Lisa Martin')).toBe('lisa martin');
    expect(baseTitle(undefined)).toBe('');
  });
  it('only strips a marker at the END of the title', () => {
    expect(baseTitle('[rush] Ed Spooner')).toBe('[rush] ed spooner');
  });
});

describe('normalizedStreet', () => {
  it('keeps only the street line, lowercased, punctuation stripped', () => {
    expect(normalizedStreet('17 Montague Ave, Lake Pleasant, MA 01347, USA')).toBe('17 montague ave');
  });
  it('collapses whitespace and handles leading spaces', () => {
    expect(normalizedStreet(' 840  Willard Street Quincy')).toBe('840 willard street quincy');
  });
  it('handles undefined and empty', () => {
    expect(normalizedStreet(undefined)).toBe('');
    expect(normalizedStreet('')).toBe('');
  });
});

describe('findContinuation', () => {
  const day1 = ev({ id: 'a', start: '2026-09-10T08:00:00-04:00' });
  const day2 = ev({ id: 'b', start: '2026-09-11T14:30:00-04:00' });
  const day3 = ev({ id: 'c', start: '2026-09-16T08:00:00-04:00', summary: 'Ed Spooner [cont]' });

  it('finds the EARLIEST later matching day (Ed Spooner chain)', () => {
    expect(findContinuation(day1, [day3, day2, day1])?.id).toBe('b');
    expect(findContinuation(day2, [day1, day2, day3])?.id).toBe('c');
  });

  it('returns null for the final day of the chain', () => {
    expect(findContinuation(day3, [day1, day2, day3])).toBeNull();
  });

  it('matches by [cont] base title even when locations differ in format', () => {
    const cont = ev({
      id: 'd',
      start: '2026-09-12T08:00:00-04:00',
      summary: 'Ed Spooner [cont]',
      location: '188 King St, Hanover MA',
    });
    expect(findContinuation(day2, [cont])?.id).toBe('d');
  });

  it('matches by street when the [cont] suffix was forgotten and names drift', () => {
    const sloppy = ev({
      id: 'e',
      start: '2026-09-12T08:00:00-04:00',
      summary: 'Spooner day 2', // different title, no marker
    });
    expect(findContinuation(day2, [sloppy])?.id).toBe('e');
  });

  it('ignores events outside the 10-day window', () => {
    const later = ev({ id: 'f', start: '2026-09-25T08:00:00-04:00', summary: 'Ed Spooner [cont]' });
    expect(findContinuation(day3, [later])?.id).toBe('f'); // 9 days — inside window
    const wayLater = ev({ id: 'g', start: '2026-09-27T08:00:00-04:00' });
    expect(findContinuation(day3, [wayLater])).toBeNull(); // 11 days — outside
    expect(findContinuation(day2, [wayLater])).toBeNull(); // 16 days — outside
  });

  it('ignores earlier and same-start events', () => {
    expect(findContinuation(day2, [day1])).toBeNull();
    const twin = ev({ id: 'h', start: day2.start });
    expect(findContinuation(day2, [twin])).toBeNull();
  });

  it('ignores non-job candidates (assessments, callbacks)', () => {
    const assessment = ev({ id: 'i', start: '2026-09-12T08:00:00-04:00', colorId: '3' });
    const callback = ev({ id: 'j', start: '2026-09-12T09:00:00-04:00', colorId: '5' });
    expect(findContinuation(day2, [assessment, callback])).toBeNull();
  });

  it('treats missing colorId as job (pre-filtered callers)', () => {
    const prefiltered = { id: 'k', summary: 'Ed Spooner [cont]', location: '', start: '2026-09-12T08:00:00-04:00' };
    expect(findContinuation(day2, [prefiltered])?.id).toBe('k');
  });

  it('never matches on empty title AND empty location', () => {
    const blank1 = { id: 'l', start: '2026-09-11T08:00:00-04:00', summary: '', location: '', colorId: '10' };
    const blank2 = { id: 'm', start: '2026-09-12T08:00:00-04:00', summary: '', location: '', colorId: '10' };
    expect(findContinuation(blank1, [blank2])).toBeNull();
  });

  it('does not link separate customers at different addresses', () => {
    const other = ev({
      id: 'n',
      start: '2026-09-12T08:00:00-04:00',
      summary: 'Victor Tuleika',
      location: '272 sheep drive brewster',
    });
    expect(findContinuation(day2, [other])).toBeNull();
  });

  it('handles unparseable starts without throwing', () => {
    const bad = ev({ id: 'o', start: 'not-a-date' });
    expect(findContinuation(bad, [day2])).toBeNull();
    expect(findContinuation(day1, [bad, day2])?.id).toBe('b');
  });
});

describe('hasContinuation', () => {
  it('mirrors findContinuation', () => {
    const day1 = ev({ id: 'a', start: '2026-09-17T08:00:00-04:00', summary: 'Kevin Malderelli' });
    const day2 = ev({ id: 'b', start: '2026-09-21T10:00:00-04:00', summary: 'Kevin Malderelli [cont]' });
    expect(hasContinuation(day1, [day1, day2])).toBe(true);
    expect(hasContinuation(day2, [day1, day2])).toBe(false);
  });
});
