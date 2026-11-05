import { describe, it, expect } from 'vitest';
import { addressesMatch, houseNumberAndWordMatch, sameStreet, streetKey, streetLine } from '../address';

describe('streetKey', () => {
  it('normalizes suffixes and units', () => {
    expect(streetKey('138 Elm Street, Unit Number 35, Kingston')).toBe('138|elm|35');
    expect(streetKey('138 Elm St. unit 35')).toBe('138|elm|35');
  });
  it('skips direction words', () => {
    expect(streetKey('40 North Main St')).toBe('40|main|');
  });
  it('requires a street suffix in free text when asked', () => {
    expect(streetKey('Quote 1580 from Attack A Crack', true)).toBeNull();
    expect(streetKey('Re: 133 Bayside Road', true)).toBe('133|bayside|');
  });
  it('returns null without a house number', () => {
    expect(streetKey('Lake Pleasant, MA')).toBeNull();
  });
});

describe('sameStreet', () => {
  it('ignores a unit missing on one side', () => {
    expect(sameStreet('138|elm|35', '138|elm|')).toBe(true);
    expect(sameStreet('138|elm|35', '138|elm|36')).toBe(false);
    expect(sameStreet(null, '138|elm|')).toBe(false);
  });
});

describe('addressesMatch', () => {
  it('matches the same house written two ways', () => {
    expect(addressesMatch('122 Allen Avenue, Falmouth, Massachusetts, 02540', '122 Allen Ave, Falmouth, MA, USA')).toBe(true);
  });
  it('rejects a different number or street', () => {
    expect(addressesMatch('124 Allen Ave', '122 Allen Ave')).toBe(false);
    expect(addressesMatch('122 Birch St', '122 Allen Ave')).toBe(false);
    expect(addressesMatch(null, '122 Allen Ave')).toBe(false);
  });
});

describe('streetLine', () => {
  it('keeps the street line before the first comma, normalized', () => {
    expect(streetLine('17 Montague Ave, Lake Pleasant, MA 01347, USA')).toBe('17 montague ave');
    expect(streetLine('15 West St.')).toBe('15 west st');
  });
  it('is empty without a leading house number (town-only locations)', () => {
    expect(streetLine('Quincy, MA')).toBe('');
    expect(streetLine(undefined)).toBe('');
  });
});

describe('houseNumberAndWordMatch', () => {
  it('matches house number + first street word, ignoring suffix and units', () => {
    expect(houseNumberAndWordMatch('122 Allen Avenue, Falmouth', '122 Allen Ave')).toBe(true);
    expect(houseNumberAndWordMatch('15 West St', '15 West Street')).toBe(true);
    expect(houseNumberAndWordMatch('30 Randlett St Unit 2', '30 Randlett St Unit 3')).toBe(true);
  });
  it('rejects different houses and missing input', () => {
    expect(houseNumberAndWordMatch('122 Allen Ave', '124 Allen Ave')).toBe(false);
    expect(houseNumberAndWordMatch(null, '122 Allen Ave')).toBe(false);
  });
});
