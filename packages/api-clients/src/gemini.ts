/**
 * Gemini AI client — Entity extraction, text generation, and image generation.
 *
 * Extracted from aac-slim/src/clients/gemini.ts (entity extraction).
 * Expanded in Phase 4.1B with content generation (gemini-2.0-flash) and
 * image generation (imagen-4.0-generate-001) for the marketing engine.
 *
 * The marketing app owns prompt engineering — this client handles API mechanics.
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('gemini');

// ── Interfaces ───────────────────────────────────────────────────────

export interface GeminiConfig {
  apiKey: string;
  /** Text model for generateContent(). Default: gemini-2.0-flash */
  textModel?: string;
  /** Image model for generateImage(). Default: imagen-4.0-generate-001 */
  imageModel?: string;
}

export interface ExtractedEntities {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface GenerateContentOptions {
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export type ImageAspectRatio = '1:1' | '3:4' | '4:3' | '16:9' | '9:16';

export interface GenerateImageOptions {
  aspectRatio?: ImageAspectRatio;
  sampleCount?: number;
  /** Output MIME type. Default: image/png */
  mimeType?: 'image/png' | 'image/jpeg';
}

export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}

interface ImagenResponse {
  predictions?: Array<{
    bytesBase64Encoded: string;
    mimeType: string;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TEXT_MODEL = 'gemini-2.0-flash';
const DEFAULT_IMAGE_MODEL = 'imagen-4.0-generate-001';
const IMAGE_TIMEOUT_MS = 45_000;
const TEXT_TIMEOUT_MS = 30_000;
const IMAGE_MIN_DELAY_MS = 8_000;

const EXTRACTION_PROMPT = `You are an entity extraction assistant. Extract contact information from the following conversation text.

Return a JSON object with these fields (use null if not found):
- firstName: The person's first name
- lastName: The person's last name
- fullName: The complete name if given as one string
- email: Email address
- streetAddress: Street address (number and street name only)
- city: City name
- state: State (2-letter abbreviation preferred)
- zipCode: ZIP/postal code
- confidence: Your confidence in the extractions ("high", "medium", or "low")

Rules:
- Only extract information the person explicitly states about themselves
- Do not infer or guess information
- If someone says "my name is John" extract firstName: "John"
- If someone gives a full address, parse it into components
- Set confidence to "high" if entities are clearly stated, "medium" if somewhat ambiguous, "low" if uncertain

Respond with ONLY the JSON object, no markdown or explanation.

Text to analyze:
`;

export type ExtractionErrorReason =
  | 'rate_limit'
  | 'server_error'
  | 'api_error'
  | 'empty_response'
  | 'parse_error'
  | 'timeout'
  | 'network_error';

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly reason: ExtractionErrorReason
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

// ── Client ───────────────────────────────────────────────────────────

export class GeminiClient {
  constructor(private config: GeminiConfig) {}

  /**
   * Extract entities from unstructured text using Gemini.
   * Retries on transient errors (429, 503) with exponential backoff.
   * Returns null gracefully on permanent errors or missing API key.
   *
   * Throws ExtractionError on failure so callers can surface the reason.
   */
  async extractEntities(text: string): Promise<ExtractedEntities | null> {
    if (!this.config.apiKey) {
      log.warn('Gemini API key not configured, skipping entity extraction');
      return null;
    }

    const model = this.config.textModel ?? DEFAULT_TEXT_MODEL;
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
          log.info('Retrying entity extraction', { attempt, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
        }

        const response = await fetch(
          `${API_BASE}/${model}:generateContent?key=${this.config.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: EXTRACTION_PROMPT + text }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
            }),
            signal: AbortSignal.timeout(15_000),
          }
        );

        if (response.status === 429 || response.status === 503) {
          const error = await response.text();
          lastError = new ExtractionError(
            `Gemini ${response.status}: ${error.substring(0, 200)}`,
            response.status === 429 ? 'rate_limit' : 'server_error'
          );
          log.warn('Gemini transient error, will retry', {
            status: response.status,
            attempt,
          });
          continue;
        }

        if (!response.ok) {
          const error = await response.text();
          throw new ExtractionError(
            `Gemini API error ${response.status}: ${error.substring(0, 200)}`,
            'api_error'
          );
        }

        const data = (await response.json()) as GeminiResponse;
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
          throw new ExtractionError('No response text from Gemini', 'empty_response');
        }

        // Parse JSON response (handle potential markdown code blocks)
        const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
        let entities: ExtractedEntities;
        try {
          entities = JSON.parse(jsonText) as ExtractedEntities;
        } catch {
          throw new ExtractionError(
            `JSON parse failed: ${jsonText.substring(0, 100)}`,
            'parse_error'
          );
        }

        // Validate required fields exist
        if (typeof entities.confidence !== 'string') {
          entities.confidence = 'low';
        }

        log.info('Extracted entities', {
          hasName: !!(entities.firstName || entities.lastName || entities.fullName),
          hasEmail: !!entities.email,
          hasAddress: !!entities.streetAddress,
          confidence: entities.confidence,
          attempts: attempt + 1,
        });

        return entities;
      } catch (error) {
        if (error instanceof ExtractionError) {
          lastError = error;
          // Only retry transient errors
          if (error.reason !== 'rate_limit' && error.reason !== 'server_error') {
            break;
          }
        } else {
          // Network error, timeout, etc. — retryable
          lastError = new ExtractionError(
            (error as Error).message,
            (error as Error).name === 'TimeoutError' ? 'timeout' : 'network_error'
          );
          log.warn('Gemini network/timeout error, will retry', {
            error: (error as Error).message,
            attempt,
          });
          continue;
        }
      }
    }

    // All retries exhausted or permanent error
    log.error('Entity extraction failed after retries', lastError!);
    throw lastError!;
  }

  // ── Content Generation ──────────────────────────────────────────────

  /**
   * Generate text content using Gemini.
   * Returns the raw text response. The caller is responsible for parsing.
   */
  async generateContent(
    prompt: string,
    options?: GenerateContentOptions
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Gemini API key not configured');
    }

    const model = this.config.textModel ?? DEFAULT_TEXT_MODEL;
    const contents: Array<Record<string, unknown>> = [];

    if (options?.systemPrompt) {
      contents.push({
        role: 'user',
        parts: [{ text: options.systemPrompt }],
      });
      contents.push({
        role: 'model',
        parts: [{ text: 'Understood. I will follow these instructions.' }],
      });
    }

    contents.push({
      role: 'user',
      parts: [{ text: prompt }],
    });

    const response = await fetch(
      `${API_BASE}/${model}:generateContent?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: options?.temperature ?? 0.7,
            maxOutputTokens: options?.maxOutputTokens ?? 2048,
          },
        }),
        signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error('No text in Gemini response');
    }

    log.debug('Generated content', {
      model,
      promptLength: prompt.length,
      responseLength: text.length,
    });

    return text;
  }

  // ── Image Generation ──────────────────────────────────────────────

  private lastImageRequestTime = 0;

  /**
   * Generate images using Gemini Imagen.
   * Returns an array of base64-encoded images.
   *
   * Rate limited to 1 request per 8 seconds (Imagen is slow and has tight quotas).
   */
  async generateImage(
    prompt: string,
    options?: GenerateImageOptions
  ): Promise<GeneratedImage[]> {
    if (!this.config.apiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Enforce minimum delay between image requests
    const now = Date.now();
    const elapsed = now - this.lastImageRequestTime;
    if (elapsed < IMAGE_MIN_DELAY_MS && this.lastImageRequestTime > 0) {
      await new Promise((r) => setTimeout(r, IMAGE_MIN_DELAY_MS - elapsed));
    }

    const model = this.config.imageModel ?? DEFAULT_IMAGE_MODEL;
    const sampleCount = options?.sampleCount ?? 1;

    this.lastImageRequestTime = Date.now();

    const response = await fetch(
      `${API_BASE}/${model}:predict?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount,
            aspectRatio: options?.aspectRatio ?? '1:1',
            personGeneration: 'ALLOW_ADULT',
            outputOptions: {
              mimeType: options?.mimeType ?? 'image/png',
            },
          },
        }),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Imagen API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as ImagenResponse;

    if (!data.predictions?.length) {
      throw new Error('No images in Imagen response');
    }

    const images = data.predictions.map((p) => ({
      base64: p.bytesBase64Encoded,
      mimeType: p.mimeType || 'image/png',
    }));

    log.debug('Generated images', {
      model,
      count: images.length,
      aspectRatio: options?.aspectRatio ?? '1:1',
      promptLength: prompt.length,
    });

    return images;
  }

  // ── Utilities ─────────────────────────────────────────────────────

  /**
   * Check if extracted entities have any useful data.
   */
  static hasUsefulEntities(entities: ExtractedEntities | null): boolean {
    if (!entities) return false;

    return !!(
      entities.firstName ||
      entities.lastName ||
      entities.fullName ||
      entities.email ||
      entities.streetAddress
    );
  }
}
