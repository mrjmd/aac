import { describe, it, expect } from 'vitest';
import { eventMatchesName, nameTokens, streetKey, tokensAlike } from '../src/index.js';

describe('nameTokens', () => {
  it('drops stop words, short tokens and punctuation', () => {
    expect(nameTokens('STUB — Ed Spooner [cont] Job')).toEqual(['stub', 'spooner']);
  });
});

describe('tokensAlike', () => {
  it('tolerates one-letter drift on longer tokens', () => {
    expect(tokensAlike('malderelli', 'maldarelli')).toBe(true);
    expect(tokensAlike('joffre', 'jofre')).toBe(true);
  });
  it('requires exact match on short tokens', () => {
    expect(tokensAlike('kim', 'kin')).toBe(false);
  });
});

describe('streetKey', () => {
  it('normalizes suffixes and units', () => {
    expect(streetKey('138 Elm Street, Unit Number 35, Kingston')).toBe('138|elm|35');
    expect(streetKey('138 Elm St. unit 35')).toBe('138|elm|35');
  });
  it('requires a street suffix in free text when asked', () => {
    expect(streetKey('Quote 1580 from Attack A Crack', true)).toBeNull();
    expect(streetKey('Re: 133 Bayside Road', true)).toBe('133|bayside|');
  });
});

describe('eventMatchesName', () => {
  it('accepts a surname hit alone', () => {
    expect(eventMatchesName({ summary: 'Job - Ann Joffre' }, nameTokens('Ann Joffre'))).toBe(true);
  });
  it('rejects a first-name-only hit', () => {
    expect(eventMatchesName({ summary: 'Assessment - Ann Smith' }, nameTokens('Ann Joffre'))).toBe(false);
  });
});
