import { describe, it, expect } from 'vitest';
import { safeReturnPath } from '../return-path.js';

const ORIGIN = 'https://hq.attackacrack.com';

describe('safeReturnPath', () => {
  it('keeps same-origin paths with their query, dropping the hash', () => {
    expect(safeReturnPath('/customers/12?tab=quotes#x', ORIGIN)).toBe('/customers/12?tab=quotes');
    expect(safeReturnPath('/', ORIGIN)).toBe('/');
    expect(safeReturnPath('/money')).toBe('/money');
  });

  it('falls back to / for empty input', () => {
    expect(safeReturnPath(null, ORIGIN)).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath('', ORIGIN)).toBe('/');
  });

  it.each([
    '//evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    'https://evil.com/x',
    'http://hq.attackacrack.com/x', // different scheme = different origin
    'javascript:alert(1)',
    'data:text/html,hi',
    '/x/..//evil.com',
    '/.//evil.com',
  ])('rejects %j', (next) => {
    expect(safeReturnPath(next, ORIGIN)).toBe('/');
    expect(safeReturnPath(next)).toBe('/');
  });

  it('accepts an absolute URL on the app origin, reduced to a path', () => {
    expect(safeReturnPath(`${ORIGIN}/todos?x=1`, ORIGIN)).toBe('/todos?x=1');
  });

  it('keeps encoded slashes as a same-origin path', () => {
    expect(safeReturnPath('/%2F%2Fevil.com', ORIGIN)).toBe('/%2F%2Fevil.com');
  });

  it('falls back to / on a bad origin', () => {
    expect(safeReturnPath('/x', 'not a url')).toBe('/');
  });
});
