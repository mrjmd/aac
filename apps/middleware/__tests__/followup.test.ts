import { describe, it, expect, vi } from 'vitest';
import {
  formatWhen,
  extractCity,
  classifyService,
  selectVariant,
  expandCompoundName,
  CANONICAL_SERVICES,
} from '../lib/followup.js';
import type { GeminiClient } from '@aac/api-clients/gemini';

describe('formatWhen', () => {
  // Reference "now": Wednesday 2026-05-13 12:00 ET
  const now = new Date('2026-05-13T16:00:00Z');

  it('returns "yesterday" for 1 day ago', () => {
    expect(formatWhen('2026-05-12', now)).toBe('yesterday');
  });

  it('returns "yesterday" for same day (0 days)', () => {
    expect(formatWhen('2026-05-13', now)).toBe('yesterday');
  });

  it('returns day name for 2-6 days ago', () => {
    expect(formatWhen('2026-05-11', now)).toBe('on Monday');
    expect(formatWhen('2026-05-10', now)).toBe('on Sunday');
    expect(formatWhen('2026-05-07', now)).toBe('on Thursday');
  });

  it('returns "last week" for 7-13 days ago', () => {
    expect(formatWhen('2026-05-06', now)).toBe('last week');
    expect(formatWhen('2026-04-30', now)).toBe('last week');
  });

  it('returns "a couple weeks ago" for 14-20 days ago', () => {
    expect(formatWhen('2026-04-29', now)).toBe('a couple weeks ago');
    expect(formatWhen('2026-04-23', now)).toBe('a couple weeks ago');
  });

  it('returns "a few weeks ago" for 21+ days ago', () => {
    expect(formatWhen('2026-04-22', now)).toBe('a few weeks ago');
    expect(formatWhen('2026-04-01', now)).toBe('a few weeks ago');
  });

  it('handles ISO datetime input', () => {
    expect(formatWhen('2026-05-12T14:30:00-04:00', now)).toBe('yesterday');
  });
});

describe('extractCity', () => {
  it('extracts city from comma-separated format with zip', () => {
    expect(extractCity('36 Frank Rd, Weymouth, MA 02191, USA')).toBe('Weymouth');
    expect(extractCity('102 School St, Taunton, MA 02780, USA')).toBe('Taunton');
  });

  it('extracts city from comma format without USA suffix', () => {
    expect(extractCity('5 Tiffney Rd, Foxborough, MA 02035')).toBe('Foxborough');
  });

  it('extracts city when state is written out', () => {
    expect(extractCity('367 New Meadow Road, Barrington, Rhode Island, 02806')).toBe('Barrington');
  });

  it('extracts city from comma-separated format without zip', () => {
    expect(extractCity('16 Kirkland Road, Cambridge MA')).toBe('Cambridge');
    expect(extractCity('21 Cliff Road, Hingham MA')).toBe('Hingham');
  });

  it('extracts city from non-comma format', () => {
    expect(extractCity('76A Brook Street Scituate MA')).toBe('Scituate');
  });

  it('returns null for missing or empty location', () => {
    expect(extractCity(undefined)).toBeNull();
    expect(extractCity(null)).toBeNull();
    expect(extractCity('')).toBeNull();
    expect(extractCity('   ')).toBeNull();
  });

  it('returns null when no state is found', () => {
    expect(extractCity('just some address')).toBeNull();
    expect(extractCity('123 Main Street')).toBeNull();
  });
});

describe('classifyService', () => {
  function mockGemini(response: string): GeminiClient {
    return {
      generateContent: vi.fn().mockResolvedValue(response),
    } as unknown as GeminiClient;
  }

  it('returns canonical service when Gemini responds with a known name', async () => {
    const gemini = mockGemini('crack injection');
    expect(await classifyService('Small garage crack', gemini)).toBe('crack injection');
  });

  it('strips quotes and trailing punctuation from Gemini response', async () => {
    const gemini = mockGemini('"bulkhead repair".');
    expect(await classifyService('Bulkhead leaking', gemini)).toBe('bulkhead repair');
  });

  it('returns null when Gemini responds with "none"', async () => {
    const gemini = mockGemini('none');
    expect(await classifyService('something weird', gemini)).toBeNull();
  });

  it('returns null when Gemini returns a non-canonical name', async () => {
    const gemini = mockGemini('basement waterproofing');
    expect(await classifyService('water in basement', gemini)).toBeNull();
  });

  it('returns null for empty or very short descriptions', async () => {
    const gemini = mockGemini('crack injection');
    expect(await classifyService(undefined, gemini)).toBeNull();
    expect(await classifyService(null, gemini)).toBeNull();
    expect(await classifyService('', gemini)).toBeNull();
    expect(await classifyService('hi', gemini)).toBeNull();
  });

  it('returns null when Gemini throws', async () => {
    const gemini = {
      generateContent: vi.fn().mockRejectedValue(new Error('API down')),
    } as unknown as GeminiClient;
    expect(await classifyService('Small garage crack', gemini)).toBeNull();
  });

  it('all canonical services should be matchable', async () => {
    for (const service of CANONICAL_SERVICES) {
      const gemini = mockGemini(service);
      expect(await classifyService('test description', gemini)).toBe(service);
    }
  });
});

describe('expandCompoundName', () => {
  it('expands "First1 & First2 Last" with last name on the second part', () => {
    expect(expandCompoundName('Lisa & John Hendrickson')).toEqual([
      'Lisa Hendrickson',
      'John Hendrickson',
    ]);
  });

  it('expands "First1 First2 Last" pattern when last name is on the first part', () => {
    // "Lisa Smith & John" — Smith is on Lisa's side
    expect(expandCompoundName('Lisa Smith & John')).toEqual([
      'Lisa Smith',
      'John Smith',
    ]);
  });

  it('handles slash as separator', () => {
    expect(expandCompoundName('Bob/Alice Smith')).toEqual([
      'Bob Smith',
      'Alice Smith',
    ]);
  });

  it('handles "and" as separator', () => {
    expect(expandCompoundName('Lisa and John Hendrickson')).toEqual([
      'Lisa Hendrickson',
      'John Hendrickson',
    ]);
  });

  it('handles ampersand without surrounding spaces', () => {
    expect(expandCompoundName('Lisa&John Hendrickson')).toEqual([
      'Lisa Hendrickson',
      'John Hendrickson',
    ]);
  });

  it('returns empty array for single name (no separator)', () => {
    expect(expandCompoundName('John Smith')).toEqual([]);
    expect(expandCompoundName('Dulce')).toEqual([]);
  });

  it('returns empty array when no shared last name can be derived', () => {
    // Two single-word parts — can't construct candidate names
    expect(expandCompoundName('Bob & Alice')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(expandCompoundName('')).toEqual([]);
  });

  it('does not match "and" inside a word like "Anderson"', () => {
    expect(expandCompoundName('Mary Anderson')).toEqual([]);
  });
});

describe('selectVariant', () => {
  it('always falls back to mike when city and service are null', () => {
    const result1 = selectVariant('event-a', null, null);
    const result2 = selectVariant('event-b', null, null);
    expect(result1.variant).toBe('mike');
    expect(result2.variant).toBe('mike');
    expect(result1.prompt).toContain('Mike');
  });

  it('city prompt includes the city name', () => {
    // Find an event ID that hashes to city slot (1)
    let cityEventId = '';
    for (let i = 0; i < 100; i++) {
      const id = `evt-${i}`;
      const r = selectVariant(id, 'Weymouth', null);
      if (r.variant === 'city') {
        cityEventId = id;
        break;
      }
    }
    expect(cityEventId).not.toBe('');
    const result = selectVariant(cityEventId, 'Weymouth', null);
    expect(result.variant).toBe('city');
    expect(result.prompt).toContain('Weymouth');
  });

  it('service prompt includes the service name', () => {
    // Find an event ID that hashes to service slot (2)
    let serviceEventId = '';
    for (let i = 0; i < 100; i++) {
      const id = `evt-svc-${i}`;
      const r = selectVariant(id, 'Weymouth', 'crack injection');
      if (r.variant === 'service') {
        serviceEventId = id;
        break;
      }
    }
    expect(serviceEventId).not.toBe('');
    const result = selectVariant(serviceEventId, 'Weymouth', 'crack injection');
    expect(result.variant).toBe('service');
    expect(result.prompt).toContain('crack injection');
  });

  it('same event always picks the same variant slot (stable hash)', () => {
    const a = selectVariant('event-stable', 'City', 'crack injection');
    const b = selectVariant('event-stable', 'City', 'crack injection');
    expect(a.variant).toBe(b.variant);
    expect(a.prompt).toBe(b.prompt);
  });

  it('falls through from city to mike when city is null', () => {
    let cityTargetId = '';
    for (let i = 0; i < 100; i++) {
      const id = `try-${i}`;
      if (selectVariant(id, 'X', null).variant === 'city') {
        cityTargetId = id;
        break;
      }
    }
    expect(cityTargetId).not.toBe('');
    const result = selectVariant(cityTargetId, null, null);
    expect(['mike', 'service']).toContain(result.variant);
  });

  it('distributes variants roughly evenly across event IDs', () => {
    const counts = { mike: 0, city: 0, service: 0 };
    for (let i = 0; i < 300; i++) {
      const r = selectVariant(`evt-${i}`, 'City', 'crack injection');
      counts[r.variant]++;
    }
    // Each variant should hit roughly 1/3 of 300 = 100, allow generous slack
    expect(counts.mike).toBeGreaterThan(50);
    expect(counts.city).toBeGreaterThan(50);
    expect(counts.service).toBeGreaterThan(50);
  });
});
