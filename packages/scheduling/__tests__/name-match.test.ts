import { describe, it, expect } from 'vitest';
import { nameTokensForMatch, summaryMatchesCustomer } from '../src/name-match.js';

describe('nameTokensForMatch', () => {
  it('lowercases, strips punctuation, drops single-char tokens', () => {
    expect(nameTokensForMatch("D'Angelo  O. Pérez-Smith")).toEqual(['angelo', 'rez', 'smith']);
    expect(nameTokensForMatch('Jo A Li')).toEqual(['jo', 'li']);
  });
});

describe('summaryMatchesCustomer', () => {
  it('matches when every name token appears in the summary', () => {
    expect(summaryMatchesCustomer('John Smith — crack injection rear wall', 'John Smith')).toBe(true);
    expect(summaryMatchesCustomer('STUB — Smith, John', 'john smith')).toBe(true);
  });

  it('rejects partial-name matches', () => {
    expect(summaryMatchesCustomer('Jane Smith — sump pump', 'John Smith')).toBe(false);
  });

  it('rejects single-token names entirely', () => {
    expect(summaryMatchesCustomer('John Smith — job', 'Smith')).toBe(false);
  });

  it('rejects empty/undefined summaries', () => {
    expect(summaryMatchesCustomer(undefined, 'John Smith')).toBe(false);
    expect(summaryMatchesCustomer('', 'John Smith')).toBe(false);
  });
});
