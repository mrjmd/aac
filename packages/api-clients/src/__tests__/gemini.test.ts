import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient, ExtractionError } from '../gemini.js';

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

    it('throws ExtractionError on permanent API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }));

      try {
        await client.extractEntities('some text');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ExtractionError);
        expect((error as ExtractionError).reason).toBe('api_error');
      }
    });

    it('throws ExtractionError on empty response', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [] }),
      }));

      await expect(client.extractEntities('some text'))
        .rejects.toThrow(ExtractionError);
    });

    it('retries on 429 rate limit then succeeds', async () => {
      const client = makeClient();
      // First call: 429
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      }));
      // Second call: success
      mockFetch.mockReturnValueOnce(mockGeminiResponse({
        firstName: 'Walter',
        lastName: 'Nedka',
        fullName: null,
        email: null,
        streetAddress: null,
        city: null,
        state: null,
        zipCode: null,
        confidence: 'high',
      }));

      const result = await client.extractEntities('My name is Walter Nedka');
      expect(result).not.toBeNull();
      expect(result!.firstName).toBe('Walter');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10000);

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
      expect(url).toContain('gemini-2.5-flash');
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

  describe('classifySchedulingIntent', () => {
    function mockClassifierResponse(payload: Record<string, unknown>) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{
            content: { parts: [{ text: JSON.stringify(payload) }] },
            finishReason: 'STOP',
          }],
        }),
      });
    }

    const fixedNow = new Date('2026-05-29T15:00:00Z'); // Friday in NY

    it('returns quote_approved for an accepting customer message', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'quote_approved',
        confidence: 'high',
        rationale: 'customer explicitly accepted the quote',
        knownSlot: null,
        eventClass: null,
        scopeSummary: '',
      }));

      const result = await client.classifySchedulingIntent(
        'Looks good — let\'s get it on the books',
        { speakerRole: 'customer', now: fixedNow },
      );

      expect(result).not.toBeNull();
      expect(result!.intent).toBe('quote_approved');
      expect(result!.confidence).toBe('high');
      expect(result!.score).toBe(0.9);
      expect(result!.knownSlot).toBeNull();
      expect(result!.eventClass).toBeNull();
    });

    it('returns assessment_requested for new-inquiry message', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'assessment_requested',
        confidence: 'medium',
        rationale: 'asking for a site visit',
        knownSlot: null,
        eventClass: null,
        scopeSummary: 'wet basement',
      }));

      const result = await client.classifySchedulingIntent(
        'Can you come out and look at my basement?',
        { speakerRole: 'customer', now: fixedNow },
      );

      expect(result!.intent).toBe('assessment_requested');
      expect(result!.score).toBe(0.7);
      expect(result!.scopeSummary).toBe('wet basement');
    });

    it('returns callback_opened for rework message', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'callback_opened',
        confidence: 'high',
        rationale: 'prior fix not holding',
        knownSlot: null,
        eventClass: null,
        scopeSummary: 'leak returning',
      }));

      const result = await client.classifySchedulingIntent(
        'The crack you fixed last year is leaking again',
        { speakerRole: 'customer', now: fixedNow },
      );

      expect(result!.intent).toBe('callback_opened');
    });

    it('returns intent=null for a non-scheduling customer message', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: null,
        confidence: 'high',
        rationale: 'pricing question, no schedule request',
        knownSlot: null,
        eventClass: null,
        scopeSummary: '',
      }));

      const result = await client.classifySchedulingIntent(
        'How much would it cost?',
        { speakerRole: 'customer', now: fixedNow },
      );

      expect(result).not.toBeNull();
      expect(result!.intent).toBeNull();
      expect(result!.score).toBe(0);
    });

    it('drops manual_schedule from a customer (role guard)', async () => {
      const client = makeClient();
      // model misbehaves and returns manual_schedule for a customer
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'manual_schedule',
        confidence: 'high',
        rationale: 'customer named a time',
        knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
        scopeSummary: '',
      }));

      const result = await client.classifySchedulingIntent(
        'Can we do it Tuesday at 10?',
        { speakerRole: 'customer', now: fixedNow },
      );

      // Out-of-range intent is dropped to null for the customer path.
      expect(result!.intent).toBeNull();
      expect(result!.knownSlot).toBeNull();
      expect(result!.eventClass).toBeNull();
    });

    it('returns manual_schedule with knownSlot for Matt outbound', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'manual_schedule',
        confidence: 'high',
        rationale: 'Matt named Tuesday at 10',
        knownSlot: { startIso: '2026-06-02T14:00:00Z' },
        eventClass: 'job',
        scopeSummary: 'crack injection',
      }));

      const result = await client.classifySchedulingIntent(
        'Let\'s get you on the books Tuesday at 10',
        { speakerRole: 'matt', now: fixedNow },
      );

      expect(result!.intent).toBe('manual_schedule');
      expect(result!.knownSlot).toEqual({ startIso: '2026-06-02T14:00:00Z' });
      expect(result!.eventClass).toBe('job');
      expect(result!.scopeSummary).toBe('crack injection');
    });

    it('drops customer-only intents when speaker is Matt (role guard)', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'quote_approved',
        confidence: 'high',
        rationale: 'misclassified',
        knownSlot: null,
        eventClass: null,
        scopeSummary: '',
      }));

      const result = await client.classifySchedulingIntent(
        'Thanks for approving!',
        { speakerRole: 'matt', now: fixedNow },
      );

      expect(result!.intent).toBeNull();
    });

    it('discards a malformed knownSlot but keeps the intent', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'manual_schedule',
        confidence: 'medium',
        rationale: 'no time named',
        knownSlot: { startIso: '' }, // empty
        eventClass: 'invalid-class',
        scopeSummary: '',
      }));

      const result = await client.classifySchedulingIntent(
        'Let\'s schedule something',
        { speakerRole: 'matt', now: fixedNow },
      );

      expect(result!.intent).toBe('manual_schedule');
      expect(result!.knownSlot).toBeNull();
      expect(result!.eventClass).toBeNull();
    });

    it('handles markdown-wrapped JSON', async () => {
      const client = makeClient();
      const payload = {
        intent: 'quote_approved',
        confidence: 'medium',
        rationale: 'accepted via SMS',
        knownSlot: null,
        eventClass: null,
        scopeSummary: '',
      };
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{
            content: { parts: [{ text: '```json\n' + JSON.stringify(payload) + '\n```' }] },
            finishReason: 'STOP',
          }],
        }),
      }));

      const result = await client.classifySchedulingIntent(
        'yes please go ahead',
        { speakerRole: 'customer', now: fixedNow },
      );

      expect(result!.intent).toBe('quote_approved');
    });

    it('returns null when API key is empty', async () => {
      const client = makeClient('');
      const result = await client.classifySchedulingIntent('hi', {
        speakerRole: 'customer',
        now: fixedNow,
      });
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns an empty classification for empty text without calling Gemini', async () => {
      const client = makeClient();
      const result = await client.classifySchedulingIntent('   ', {
        speakerRole: 'customer',
        now: fixedNow,
      });
      expect(result!.intent).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws ExtractionError on permanent API error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      }));

      await expect(
        client.classifySchedulingIntent('text', { speakerRole: 'customer', now: fixedNow }),
      ).rejects.toThrow(ExtractionError);
    });

    it('throws ExtractionError on parse failure', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'not json' }] }, finishReason: 'STOP' }],
        }),
      }));

      await expect(
        client.classifySchedulingIntent('text', { speakerRole: 'customer', now: fixedNow }),
      ).rejects.toMatchObject({ reason: 'parse_error' });
    });

    it('retries on 429 then succeeds', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limited'),
      }));
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: 'quote_approved',
        confidence: 'high',
        rationale: 'ok',
        knownSlot: null,
        eventClass: null,
        scopeSummary: '',
      }));

      const result = await client.classifySchedulingIntent(
        'Let\'s do it',
        { speakerRole: 'customer', now: fixedNow },
      );

      expect(result!.intent).toBe('quote_approved');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10000);

    it('passes today\'s date and timezone into the prompt', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: null, confidence: 'low', rationale: '', knownSlot: null, eventClass: null, scopeSummary: '',
      }));

      await client.classifySchedulingIntent('Schedule me Tuesday', {
        speakerRole: 'matt',
        now: new Date('2026-05-29T15:00:00Z'),
        timezone: 'America/Denver',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const promptText = body.contents[0].parts[0].text as string;
      // 2026-05-29 in America/Denver at 15:00 UTC = 09:00 local → 2026-05-29
      expect(promptText).toContain('2026-05-29');
      expect(promptText).toContain('America/Denver');
      expect(promptText).toContain('Schedule me Tuesday');
    });

    it('selects the Matt prompt when speakerRole is "matt"', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: null, confidence: 'low', rationale: '', knownSlot: null, eventClass: null, scopeSummary: '',
      }));

      await client.classifySchedulingIntent('hi', {
        speakerRole: 'matt',
        now: fixedNow,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const promptText = body.contents[0].parts[0].text as string;
      expect(promptText).toContain('The speaker is Matt');
    });

    it('selects the customer prompt when speakerRole is "customer"', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockClassifierResponse({
        intent: null, confidence: 'low', rationale: '', knownSlot: null, eventClass: null, scopeSummary: '',
      }));

      await client.classifySchedulingIntent('hi', {
        speakerRole: 'customer',
        now: fixedNow,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const promptText = body.contents[0].parts[0].text as string;
      expect(promptText).toContain('text below is from a CUSTOMER');
    });
  });

  describe('hasSchedulingIntent', () => {
    it('returns true when intent is set', () => {
      expect(
        GeminiClient.hasSchedulingIntent({
          intent: 'quote_approved',
          score: 0.9,
          confidence: 'high',
          rationale: 'x',
          knownSlot: null,
          eventClass: null,
          scopeSummary: '',
        }),
      ).toBe(true);
    });

    it('returns false when intent is null', () => {
      expect(
        GeminiClient.hasSchedulingIntent({
          intent: null,
          score: 0,
          confidence: 'low',
          rationale: '',
          knownSlot: null,
          eventClass: null,
          scopeSummary: '',
        }),
      ).toBe(false);
    });

    it('returns false for null', () => {
      expect(GeminiClient.hasSchedulingIntent(null)).toBe(false);
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
