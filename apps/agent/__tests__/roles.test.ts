import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAgentUserRoles, lookupRole } from '../lib/roles.js';

beforeEach(() => {
  // Silence the warn() calls from the role parser in expected-failure tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('parseAgentUserRoles', () => {
  it('returns empty map for undefined env', () => {
    expect(parseAgentUserRoles(undefined)).toEqual({});
  });

  it('returns empty map for empty string', () => {
    expect(parseAgentUserRoles('')).toEqual({});
  });

  it('parses a valid JSON role map', () => {
    const input = JSON.stringify({
      '+15551234567': 'owner',
      '+15557654321': 'technician',
    });
    expect(parseAgentUserRoles(input)).toEqual({
      '+15551234567': 'owner',
      '+15557654321': 'technician',
    });
  });

  it('skips entries with unknown role values, keeps the rest', () => {
    const input = JSON.stringify({
      '+15551234567': 'owner',
      '+15557654321': 'admin', // not a real role
    });
    expect(parseAgentUserRoles(input)).toEqual({
      '+15551234567': 'owner',
    });
  });

  it('returns empty map for invalid JSON', () => {
    expect(parseAgentUserRoles('not json')).toEqual({});
  });

  it('returns empty map when JSON is an array, not an object', () => {
    expect(parseAgentUserRoles(JSON.stringify(['owner']))).toEqual({});
  });

  it('accepts all four canonical roles', () => {
    const input = JSON.stringify({
      '+1': 'owner',
      '+2': 'technician',
      '+3': 'salesperson',
      '+4': 'triage',
    });
    expect(parseAgentUserRoles(input)).toEqual({
      '+1': 'owner',
      '+2': 'technician',
      '+3': 'salesperson',
      '+4': 'triage',
    });
  });
});

describe('lookupRole', () => {
  it('returns the role for a mapped phone', () => {
    const map = { '+15551234567': 'owner' as const };
    expect(lookupRole('+15551234567', map)).toBe('owner');
  });

  it('returns null for an unmapped phone', () => {
    expect(lookupRole('+15550000000', {})).toBeNull();
  });
});
