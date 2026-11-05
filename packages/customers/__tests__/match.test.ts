import { describe, it, expect } from 'vitest';
import {
  customerNameMatches,
  eventMatchesName,
  expandCompoundName,
  expandNicknames,
  firstNamesAlike,
  lastFirstTokens,
  nameCorroborated,
  nameTokens,
  nameTokensForMatch,
  summaryMatchesCustomer,
  tokensAlike,
} from '../src/index.js';

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

describe('eventMatchesName', () => {
  it('accepts a surname hit alone', () => {
    expect(eventMatchesName({ summary: 'Job - Ann Joffre' }, nameTokens('Ann Joffre'))).toBe(true);
  });
  it('rejects a first-name-only hit', () => {
    expect(eventMatchesName({ summary: 'Assessment - Ann Smith' }, nameTokens('Ann Joffre'))).toBe(false);
  });
});

describe('nameTokensForMatch', () => {
  it('lowercases, strips punctuation, drops 1-char tokens', () => {
    expect(nameTokensForMatch("D'Angelo  O. Pérez-Smith")).toEqual(['angelo', 'rez', 'smith']);
    expect(nameTokensForMatch('Jo A Li')).toEqual(['jo', 'li']);
  });
});

describe('summaryMatchesCustomer (strict)', () => {
  it('matches when every name token is in the summary', () => {
    expect(summaryMatchesCustomer('John Smith — crack injection rear wall', 'John Smith')).toBe(true);
    expect(summaryMatchesCustomer('STUB — Smith, John', 'john smith')).toBe(true);
  });
  it('rejects a shared surname with a different first name', () => {
    expect(summaryMatchesCustomer('Jane Smith — sump pump', 'John Smith')).toBe(false);
  });
  it('never matches a single-token name', () => {
    expect(summaryMatchesCustomer('John Smith — job', 'Smith')).toBe(false);
  });
  it('handles a missing summary', () => {
    expect(summaryMatchesCustomer(undefined, 'John Smith')).toBe(false);
    expect(summaryMatchesCustomer('', 'John Smith')).toBe(false);
  });
});

describe('customerNameMatches (same person)', () => {
  it('tolerates given-name spelling drift and the STUB prefix', () => {
    expect(customerNameMatches('Rachel McCarthy', 'Rachael McCarthy')).toBe(true);
    expect(customerNameMatches('STUB — Rachel McCarthy', 'Rachael McCarthy')).toBe(true);
  });
  it('rejects a different surname or a non-person title', () => {
    expect(customerNameMatches('Rachel Smith', 'Rachael McCarthy')).toBe(false);
    expect(customerNameMatches('Mike OOO', 'Rachael McCarthy')).toBe(false);
  });
  it('requires single-token names to be equal', () => {
    expect(customerNameMatches('McCarthy', 'McCarthy')).toBe(true);
    expect(customerNameMatches('McCarthy', 'McCarthey')).toBe(false);
  });
});

describe('nicknames', () => {
  it('firstNamesAlike works in both directions', () => {
    expect(firstNamesAlike('bob', 'robert')).toBe(true);
    expect(firstNamesAlike('robert', 'bob')).toBe(true);
    expect(firstNamesAlike('ted', 'edward')).toBe(true);
    expect(firstNamesAlike('ted', 'theodore')).toBe(true);
    expect(firstNamesAlike('bob', 'melanie')).toBe(false);
  });
  it('expandNicknames varies only the first token', () => {
    expect(expandNicknames('Bob Doherty')).toContain('Robert Doherty');
    expect(expandNicknames('Robert Doherty')).toContain('Bob Doherty');
    expect(expandNicknames('Jim St. Pierre')).toContain('James St. Pierre');
    expect(expandNicknames('Zelda Doherty')).toEqual([]);
    expect(expandNicknames('Doherty')).toEqual([]);
  });
});

describe('expandCompoundName', () => {
  it('attaches the shared last name to single-word parts', () => {
    expect(expandCompoundName('Lisa & John Hendrickson')).toEqual(['Lisa Hendrickson', 'John Hendrickson']);
    expect(expandCompoundName('Lisa Smith & John')).toEqual(['Lisa Smith', 'John Smith']);
    expect(expandCompoundName('Bob/Alice Smith')).toEqual(['Bob Smith', 'Alice Smith']);
    expect(expandCompoundName('Lisa and John Hendrickson')).toEqual(['Lisa Hendrickson', 'John Hendrickson']);
    expect(expandCompoundName('Lisa&John Hendrickson')).toEqual(['Lisa Hendrickson', 'John Hendrickson']);
  });
  it('returns [] without a separator or a shared last name', () => {
    expect(expandCompoundName('John Smith')).toEqual([]);
    expect(expandCompoundName('Dulce')).toEqual([]);
    expect(expandCompoundName('Bob & Alice')).toEqual([]);
    expect(expandCompoundName('')).toEqual([]);
    expect(expandCompoundName('Mary Anderson')).toEqual([]);
  });
});

describe('nameCorroborated', () => {
  it('accepts a drifted surname corroborated by first name or street number', () => {
    expect(nameCorroborated('Karen Erikson 12 Oak St', 'Karen Eriksen')).toBe(true);
    expect(nameCorroborated('Erikson 12 Oak St', 'Karen Eriksen', '12 Oak Street')).toBe(true);
  });
  it('accepts a nickname as the first name', () => {
    expect(nameCorroborated('Bob Doherty', 'Robert Doherty')).toBe(true);
  });
  it('never accepts the surname alone', () => {
    expect(nameCorroborated('Bob Doherty 9 Elm St', 'Melanie Doherty', '40 Pine St')).toBe(false);
  });
});

describe('lastFirstTokens', () => {
  it('splits surname from given names, dropping short words', () => {
    expect(lastFirstTokens('Shannon M. Fullerton')).toEqual({ last: ['fullerton'], first: ['shannon'] });
    expect(lastFirstTokens('Fullerton')).toEqual({ last: ['fullerton'], first: [] });
    expect(lastFirstTokens('')).toEqual({ last: [], first: [] });
  });
});
