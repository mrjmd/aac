import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient } from '../gemini.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeClient(apiKey = 'test-gemini-key') {
  return new GeminiClient({ apiKey });
}

function mockGeminiResponse(entities: Record<string, unknown>) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(entities) }],
        },
        finishReason: 'STOP',
      }],
    }),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GeminiClient', () => {
  describe('extractEntities', () => {
    it('extracts entities from text', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockGeminiResponse({
        firstName: 'John',
        lastName: 'Doe',
        fullName: 'John Doe',
        email: 'john@example.com',
        streetAddress: '123 Main St',
        city: 'Boston',
        state: 'MA',
        zipCode: '02101',
        confidence: 'high',
      }));

      const result = await client.extractEntities('My name is John Doe, I live at 123 Main St, Boston MA 02101');
      expect(result).not.toBeNull();
      expect(result!.firstName).toBe('John');
      expect(result!.city).toBe('Boston');
      expect(result!.confidence).toBe('high');
    });

    it('handles markdown-wrapped JSON', async () => {
      const client = makeClient();
      const entities = { firstName: 'Jane', lastName: null, fullName: null, email: null, streetAddress: null, city: null, state: null, zipCode: null, confidence: 'medium' };
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{ text: '```json\n' + JSON.stringify(entities) + '\n```' }],
            },
            finishReason: 'STOP',
          }],
        }),
      }));

      const result = await client.extractEntities('My name is Jane');
      expect(result).not.toBeNull();
      expect(result!.firstName).toBe('Jane');
    });

    it('returns null when API key is empty', async () => {
      const client = makeClient('');
      const result = await client.extractEntities('some text');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null on API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }));

      const result = await client.extractEntities('some text');
      expect(result).toBeNull();
    });

    it('returns null on malformed response', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [] }),
      }));

      const result = await client.extractEntities('some text');
      expect(result).toBeNull();
    });

    it('defaults confidence to low if missing', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockGeminiResponse({
        firstName: 'Bob', lastName: null, fullName: null, email: null,
        streetAddress: null, city: null, state: null, zipCode: null,
        // confidence intentionally missing
      }));

      const result = await client.extractEntities('my name is Bob');
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe('low');
    });
  });

  describe('hasUsefulEntities', () => {
    it('returns true for entities with name', () => {
      expect(GeminiClient.hasUsefulEntities({
        firstName: 'John', lastName: null, fullName: null,
        email: null, streetAddress: null, city: null, state: null, zipCode: null,
        confidence: 'high',
      })).toBe(true);
    });

    it('returns true for entities with email', () => {
      expect(GeminiClient.hasUsefulEntities({
        firstName: null, lastName: null, fullName: null,
        email: 'test@example.com', streetAddress: null, city: null, state: null, zipCode: null,
        confidence: 'medium',
      })).toBe(true);
    });

    it('returns false for empty entities', () => {
      expect(GeminiClient.hasUsefulEntities({
        firstName: null, lastName: null, fullName: null,
        email: null, streetAddress: null, city: null, state: null, zipCode: null,
        confidence: 'low',
      })).toBe(false);
    });

    it('returns false for null', () => {
      expect(GeminiClient.hasUsefulEntities(null)).toBe(false);
    });
  });
});
