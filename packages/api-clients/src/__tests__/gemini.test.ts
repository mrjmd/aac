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

  describe('generateContent', () => {
    function mockContentResponse(text: string) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{
            content: { parts: [{ text }] },
            finishReason: 'STOP',
          }],
        }),
      });
    }

    it('generates text content with default settings', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockContentResponse('Generated caption about foundation repair'));

      const result = await client.generateContent('Write a caption about foundation repair');
      expect(result).toBe('Generated caption about foundation repair');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('gemini-2.0-flash');
      expect(url).toContain('generateContent');
    });

    it('includes system prompt as conversation context', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockContentResponse('Branded caption'));

      await client.generateContent('Write a caption', {
        systemPrompt: 'You are a social media expert for a foundation repair company.',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.contents).toHaveLength(3); // system + ack + user
      expect(body.contents[0].parts[0].text).toContain('social media expert');
      expect(body.contents[2].parts[0].text).toBe('Write a caption');
    });

    it('respects temperature and maxOutputTokens', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockContentResponse('Creative output'));

      await client.generateContent('Be creative', {
        temperature: 0.9,
        maxOutputTokens: 500,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.temperature).toBe(0.9);
      expect(body.generationConfig.maxOutputTokens).toBe(500);
    });

    it('uses custom text model from config', async () => {
      const client = new GeminiClient({ apiKey: 'test-key', textModel: 'gemini-2.5-flash' });
      mockFetch.mockReturnValueOnce(mockContentResponse('Output'));

      await client.generateContent('Test');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('gemini-2.5-flash');
    });

    it('throws on empty API key', async () => {
      const client = makeClient('');
      await expect(client.generateContent('Test')).rejects.toThrow('API key not configured');
    });

    it('throws on API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limit exceeded'),
      }));

      await expect(client.generateContent('Test')).rejects.toThrow('Gemini API error (429)');
    });

    it('throws on empty response', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [] }),
      }));

      await expect(client.generateContent('Test')).rejects.toThrow('No text in Gemini response');
    });
  });

  describe('generateImage', () => {
    function mockImagenResponse(count = 1) {
      const predictions = Array.from({ length: count }, (_, i) => ({
        bytesBase64Encoded: `base64-image-data-${i}`,
        mimeType: 'image/png',
      }));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ predictions }),
      });
    }

    it('generates a single image with defaults', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockImagenResponse(1));

      const result = await client.generateImage('A foundation crack being repaired');
      expect(result).toHaveLength(1);
      expect(result[0].base64).toBe('base64-image-data-0');
      expect(result[0].mimeType).toBe('image/png');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('imagen-4.0-generate-001');
      expect(url).toContain('predict');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parameters.aspectRatio).toBe('1:1');
      expect(body.parameters.sampleCount).toBe(1);
    });

    it('supports custom aspect ratio', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockImagenResponse(1));

      await client.generateImage('Test', { aspectRatio: '3:4' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parameters.aspectRatio).toBe('3:4');
    });

    it('supports multiple samples', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockImagenResponse(3));

      const result = await client.generateImage('Test', { sampleCount: 3 });
      expect(result).toHaveLength(3);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parameters.sampleCount).toBe(3);
    });

    it('supports JPEG output', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockImagenResponse(1));

      await client.generateImage('Test', { mimeType: 'image/jpeg' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parameters.outputOptions.mimeType).toBe('image/jpeg');
    });

    it('uses custom image model from config', async () => {
      const client = new GeminiClient({ apiKey: 'test-key', imageModel: 'imagen-5.0' });
      mockFetch.mockReturnValueOnce(mockImagenResponse(1));

      await client.generateImage('Test');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('imagen-5.0');
    });

    it('throws on empty API key', async () => {
      const client = makeClient('');
      await expect(client.generateImage('Test')).rejects.toThrow('API key not configured');
    });

    it('throws on API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      }));

      await expect(client.generateImage('Test')).rejects.toThrow('Imagen API error (500)');
    });

    it('throws on empty predictions', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ predictions: [] }),
      }));

      await expect(client.generateImage('Test')).rejects.toThrow('No images in Imagen response');
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
