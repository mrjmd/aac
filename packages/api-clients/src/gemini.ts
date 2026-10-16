/**
 * Gemini AI client — Entity extraction, text generation, and image generation.
 *
 * Extracted from aac-slim/src/clients/gemini.ts (entity extraction).
 * Expanded in Phase 4.1B with content generation and image generation
 * (imagen-4.0-generate-001) for the marketing engine.
 *
 * The marketing app owns prompt engineering — this client handles API mechanics.
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('gemini');

// ── Interfaces ───────────────────────────────────────────────────────

export interface GeminiConfig {
  apiKey: string;
  /** Text model for generateContent(). Default: gemini-flash-latest */
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

// ── Scheduling intent classification ────────────────────────────────

export type SchedulingIntentLabel =
  | 'quote_approved'
  | 'assessment_requested'
  | 'callback_opened'
  | 'appointment_confirmed'
  | 'manual_schedule';

/**
 * For manual_schedule: whether Matt stated the slot as decided ("I'm
 * putting you down for Tuesday at 10") or merely proposed it ("Would
 * Tuesday at 10 work?"). Offered slots wait for the customer's yes —
 * which arrives later as an appointment_confirmed classification.
 */
export type ClassifiedSlotCommitment = 'booked' | 'offered';

/**
 * Mirrors `EventClass` in `@aac/scheduling`. Duplicated as a string union
 * here to keep the api-clients package independent of @aac/scheduling
 * (dependency direction: scheduling → api-clients, not the reverse).
 */
export type ClassifiedEventClass = 'job' | 'assessment' | 'callback';

export interface ClassifiedKnownSlot {
  startIso: string;
  endIso?: string;
}

export interface ClassifiedSchedulingIntent {
  /** Null when no scheduling intent was detected in the text. */
  intent: SchedulingIntentLabel | null;
  /** Numeric [0, 1]. high → 0.9, medium → 0.7, low → 0.5. */
  score: number;
  confidence: 'high' | 'medium' | 'low';
  /** Brief evidence (< 25 words). Empty string when intent is null. */
  rationale: string;
  /** Meaningful for manual_schedule and appointment_confirmed. Null otherwise. */
  knownSlot: ClassifiedKnownSlot | null;
  /** Meaningful for manual_schedule and appointment_confirmed. Null otherwise. */
  eventClass: ClassifiedEventClass | null;
  /**
   * Only meaningful for manual_schedule. Defaults to 'offered' when the
   * model omits it — the conservative reading (waits for customer yes).
   */
  slotCommitment: ClassifiedSlotCommitment | null;
  /** Short scope hint extracted from text. Empty when not present. */
  scopeSummary: string;
}

export interface ClassifySchedulingIntentOptions {
  /** 'customer' for inbound text/calls; 'matt' for outbound. */
  speakerRole: 'customer' | 'matt';
  /** Clock for natural-language date resolution. Defaults to `new Date()`. */
  now?: Date;
  /** IANA timezone for date interpretation. Defaults to 'America/New_York'. */
  timezone?: string;
  /**
   * Recent conversation, oldest-first, pre-formatted one line per message
   * (e.g. "MATT: …" / "CUSTOMER: …"). When present, the classifier resolves
   * what the text-to-classify refers to (e.g. "Yes, that works" confirming a
   * slot Matt offered two messages earlier). Without it, confirmations that
   * don't restate the time cannot be resolved to appointment_confirmed.
   */
  conversationContext?: string;
}

export interface GenerateContentOptions {
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Fetch timeout override. The 30s default suits webhook-path calls;
   * long analytical prompts on thinking models need more headroom.
   */
  timeoutMs?: number;
  /**
   * Cap reasoning tokens via thinkingConfig. Unset = model default
   * (unbounded — large analytical prompts can think past any timeout).
   * Note: some model generations 400 on thinkingConfig; callers setting
   * this should be prepared to retry without it.
   */
  thinkingBudget?: number;
  /**
   * Inline images sent alongside the text prompt (multimodal input),
   * e.g. customer MMS photos for quote drafting. Base64-encoded, no
   * data-URI prefix.
   */
  imageParts?: Array<{ mimeType: string; base64: string }>;
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
// The -latest alias re-points to the newest stable flash model. Google
// retires pinned model names out from under stable API keys (gemini-2.5-flash
// started 404ing in Aug 2026 with zero code changes on our side), so pinning
// a version here is a time bomb. The alias trades version stability for
// availability — right for extraction/classification, where prompt-level
// behavior drift is tolerable and a dead model is not. Google emails ~2 weeks
// before re-pointing the alias.
const DEFAULT_TEXT_MODEL = 'gemini-flash-latest';
// Fallback budget when a model rejects thinkingConfig (see requestText):
// thinking tokens then count against maxOutputTokens, and budgets under
// ~2k truncate JSON responses mid-string on thinking models.
const NO_THINKING_DISABLE_MAX_TOKENS = 8192;
const DEFAULT_IMAGE_MODEL = 'imagen-4.0-generate-001';
const IMAGE_TIMEOUT_MS = 45_000;
const TEXT_TIMEOUT_MS = 30_000;
const IMAGE_MIN_DELAY_MS = 8_000;

const EXTRACTION_PROMPT = `You are an entity extraction assistant. Extract contact information about THE SPEAKER ONLY from the following conversation text.

The text is from the speaker's own messages (inbound SMS or their lines from a call transcript). Your job is to identify who the SPEAKER is — not anyone they mention.

Return a JSON object with these fields (use null if not found):
- firstName: The speaker's first name
- lastName: The speaker's last name
- fullName: The speaker's complete name if given as one string
- email: The speaker's email address
- streetAddress: Street address of the property that is the subject of this inquiry (number and street name only)
- city: City of the property in question
- state: State of that property (2-letter abbreviation preferred)
- zipCode: ZIP/postal code of that property
- confidence: Your confidence in the extractions ("high", "medium", or "low")

Critical rules:
- For NAME and EMAIL: extract ONLY information that identifies the speaker themselves. If a name or email belongs to a third party the speaker mentions (a relative, spouse, contractor, realtor, friend, neighbor, builder's client), DO NOT extract it.
- For ADDRESS: extract the property that is the subject of THIS inquiry — the location where AAC would be doing the work. Usually the speaker's own home, but for pre-purchase inspections it's the property they're evaluating, for commercial inquiries it's the commercial property in question, and for "look at my mom's basement" requests it's the relative's property that is the subject of the work. Do NOT extract addresses mentioned in passing or unrelated to the work being inquired about (a realtor's office, a past residence, etc.).
- Do not infer or guess. If unsure, leave the field null and lower confidence.

Examples — DO extract:
- "My name is John Smith" → firstName: "John", lastName: "Smith"
- "I'm Sam" → firstName: "Sam"
- "You can reach me at jane@example.com" → email: "jane@example.com"
- "I live at 21 Cliff Road in Hingham" → streetAddress: "21 Cliff Road", city: "Hingham" (homeowner — speaker's own home is the subject)
- "I'm looking at a house at 22 Edwardel Rd in Needham — can you check it out?" → streetAddress: "22 Edwardel Rd", city: "Needham" (pre-purchase — the property they're evaluating is the subject)
- "The property address is 22 Edwardel Rd" → streetAddress: "22 Edwardel Rd"
- "Can you come look at my mom's basement at 5 Oak Lane, Wellesley?" → streetAddress: "5 Oak Lane", city: "Wellesley" (work would happen at mom's house — that property is the subject)
- "We have a commercial property at 100 Industrial Way that needs sealing" → streetAddress: "100 Industrial Way" (commercial site is the subject)

Examples — DO NOT extract:
- "My realtor Lisa Hartley said to call you" → do not extract Lisa Hartley (third-party name)
- "My builder Mike is handling the foundation" → do not extract Mike (third-party name)
- "Tell my wife Susan when you arrive" → do not extract Susan (third-party name)
- "The previous owner was a guy named Bob" → do not extract Bob (third-party name)
- "My realtor's office is at 100 Main St" → do not extract 100 Main St (unrelated to the work)
- "I used to live at 50 Old Way" → do not extract 50 Old Way (past residence, not subject of inquiry)

Confidence levels:
- "high": speaker clearly states their own information ("My name is...", "I'm...", "I live at...")
- "medium": information is present but speaker attribution is somewhat ambiguous
- "low": uncertain whether information belongs to the speaker

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
   * POST a small structured-output prompt to the text model and return the
   * raw response text. Shared by extractEntities and classifySchedulingIntent.
   *
   * Retry ladder (up to 2 retries, 1s/2s backoff):
   *   - 429/503 and network/timeout errors → retried (transient)
   *   - 400 while thinkingConfig is attached → retried once WITHOUT
   *     thinkingConfig at NO_THINKING_DISABLE_MAX_TOKENS. The -latest alias
   *     re-points across model generations, and some generations reject
   *     `thinkingBudget: 0` outright (gemini-3.6-flash 400s on it). Without
   *     this fallback an alias re-point could 400 every call.
   *   - anything else → ExtractionError with a reason
   */
  private async requestText(
    prompt: string,
    opts: { maxOutputTokens: number; logContext: string },
  ): Promise<string> {
    const model = this.config.textModel ?? DEFAULT_TEXT_MODEL;
    const maxRetries = 2;
    let lastError: Error | null = null;
    // Thinking tokens count against maxOutputTokens and would truncate the
    // JSON response mid-string — we don't need reasoning for small
    // extraction/classification tasks, so ask the model to skip it.
    let disableThinking = true;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
          log.info(`Retrying ${opts.logContext}`, { attempt, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
        }

        const generationConfig: Record<string, unknown> = disableThinking
          ? {
              temperature: 0.1,
              maxOutputTokens: opts.maxOutputTokens,
              thinkingConfig: { thinkingBudget: 0 },
            }
          : {
              temperature: 0.1,
              maxOutputTokens: NO_THINKING_DISABLE_MAX_TOKENS,
            };

        const response = await fetch(
          `${API_BASE}/${model}:generateContent?key=${this.config.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
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
            context: opts.logContext,
          });
          continue;
        }

        if (response.status === 400 && disableThinking) {
          const error = await response.text();
          lastError = new ExtractionError(
            `Gemini 400 with thinkingConfig: ${error.substring(0, 200)}`,
            'api_error'
          );
          disableThinking = false;
          log.warn('Gemini rejected thinkingConfig, retrying without it', {
            attempt,
            context: opts.logContext,
            model,
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
        const candidate = data.candidates?.[0];
        const rawText = candidate?.content?.parts?.[0]?.text;

        if (candidate?.finishReason === 'MAX_TOKENS' && disableThinking) {
          // Some -latest alias generations accept thinkingBudget: 0 but
          // silently ignore it (HTTP 200) — thinking then eats the token
          // budget and the JSON comes back truncated. Same remedy as the
          // 400 case: drop thinkingConfig and retry at the raised cap.
          lastError = new ExtractionError(
            'Gemini hit MAX_TOKENS despite thinkingBudget: 0 (truncated response)',
            'parse_error'
          );
          disableThinking = false;
          log.warn('Gemini ignored thinkingBudget: 0 and truncated, retrying without thinkingConfig', {
            attempt,
            context: opts.logContext,
            model,
          });
          continue;
        }

        if (!rawText) {
          throw new ExtractionError('No response text from Gemini', 'empty_response');
        }

        if (candidate?.finishReason === 'MAX_TOKENS') {
          throw new ExtractionError(
            `Gemini response truncated (MAX_TOKENS): ${rawText.substring(0, 100)}`,
            'parse_error'
          );
        }

        return rawText;
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
            context: opts.logContext,
          });
          continue;
        }
      }
    }

    log.error(`Gemini ${opts.logContext} failed after retries`, lastError!);
    throw lastError!;
  }

  /**
   * Extract entities from unstructured text using Gemini.
   * Retries on transient errors (429, 503) with exponential backoff.
   * Returns null gracefully on missing API key.
   *
   * Throws ExtractionError on failure so callers can surface the reason.
   */
  async extractEntities(text: string): Promise<ExtractedEntities | null> {
    if (!this.config.apiKey) {
      log.warn('Gemini API key not configured, skipping entity extraction');
      return null;
    }

    const rawText = await this.requestText(EXTRACTION_PROMPT + text, {
      maxOutputTokens: 500,
      logContext: 'entity extraction',
    });

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
    });

    return entities;
  }

  // ── Scheduling Intent Classification ────────────────────────────────

  /**
   * Classify the scheduling intent expressed in a Quo message or call
   * transcript. The prompt switches based on `speakerRole`:
   *
   *   - 'customer' → quote_approved | assessment_requested | callback_opened | null
   *   - 'matt'     → manual_schedule | null   (also extracts time/eventClass)
   *
   * Returns null only when the API key is unset. On a successful call with
   * no intent detected, returns `{ intent: null, ... }`. Retries 429/503
   * with exponential backoff like extractEntities; throws ExtractionError
   * on permanent failures.
   */
  async classifySchedulingIntent(
    text: string,
    opts: ClassifySchedulingIntentOptions,
  ): Promise<ClassifiedSchedulingIntent | null> {
    if (!this.config.apiKey) {
      log.warn('Gemini API key not configured, skipping intent classification');
      return null;
    }

    if (!text || !text.trim()) {
      return emptyIntent();
    }

    const prompt = buildIntentPrompt(text, opts);
    const rawText = await this.requestText(prompt, {
      maxOutputTokens: 400,
      logContext: 'intent classification',
    });

    const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = parseClassifierResponse(jsonText, opts.speakerRole);

    log.info('Classified scheduling intent', {
      intent: parsed.intent,
      confidence: parsed.confidence,
      hasKnownSlot: !!parsed.knownSlot,
    });

    return parsed;
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
      parts: [
        ...(options?.imageParts ?? []).map((img) => ({
          inlineData: { mimeType: img.mimeType, data: img.base64 },
        })),
        { text: prompt },
      ],
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
            // Generous default: on thinking models, reasoning tokens count
            // against this cap, and caps under ~2k truncate output mid-string.
            maxOutputTokens: options?.maxOutputTokens ?? 8192,
            ...(options?.thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
              : {}),
          },
        }),
        signal: AbortSignal.timeout(options?.timeoutMs ?? TEXT_TIMEOUT_MS),
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

  /**
   * Check whether a classification result carries a scheduling signal worth
   * acting on. Returns true only when `intent` is non-null.
   */
  static hasSchedulingIntent(
    classification: ClassifiedSchedulingIntent | null,
  ): boolean {
    return !!classification && classification.intent !== null;
  }
}

// ── Intent classification helpers ───────────────────────────────────

function emptyIntent(): ClassifiedSchedulingIntent {
  return {
    intent: null,
    score: 0,
    confidence: 'low',
    rationale: '',
    knownSlot: null,
    eventClass: null,
    slotCommitment: null,
    scopeSummary: '',
  };
}

function confidenceToScore(confidence: unknown): {
  confidence: 'high' | 'medium' | 'low';
  score: number;
} {
  if (confidence === 'high') return { confidence: 'high', score: 0.9 };
  if (confidence === 'medium') return { confidence: 'medium', score: 0.7 };
  return { confidence: 'low', score: 0.5 };
}

const CUSTOMER_INTENTS = new Set<SchedulingIntentLabel>([
  'quote_approved',
  'assessment_requested',
  'callback_opened',
  'appointment_confirmed',
]);

/** Intents that may carry a concrete time slot + event class. */
const SLOT_BEARING_INTENTS = new Set<SchedulingIntentLabel>([
  'manual_schedule',
  'appointment_confirmed',
]);

const VALID_EVENT_CLASSES = new Set<ClassifiedEventClass>([
  'job',
  'assessment',
  'callback',
]);

function parseClassifierResponse(
  jsonText: string,
  speakerRole: 'customer' | 'matt',
): ClassifiedSchedulingIntent {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new ExtractionError(
      `Intent JSON parse failed: ${jsonText.substring(0, 100)}`,
      'parse_error',
    );
  }

  const rawIntent = typeof raw.intent === 'string' ? raw.intent : null;
  let intent: SchedulingIntentLabel | null = null;
  if (rawIntent && rawIntent !== 'null') {
    if (speakerRole === 'customer' && CUSTOMER_INTENTS.has(rawIntent as SchedulingIntentLabel)) {
      intent = rawIntent as SchedulingIntentLabel;
    } else if (speakerRole === 'matt' && rawIntent === 'manual_schedule') {
      intent = 'manual_schedule';
    }
  }

  const { confidence, score } = confidenceToScore(raw.confidence);
  const rationale = typeof raw.rationale === 'string' ? raw.rationale : '';

  const slotBearing = intent !== null && SLOT_BEARING_INTENTS.has(intent);

  let knownSlot: ClassifiedKnownSlot | null = null;
  if (slotBearing && raw.knownSlot && typeof raw.knownSlot === 'object') {
    const ks = raw.knownSlot as Record<string, unknown>;
    if (typeof ks.startIso === 'string' && ks.startIso.length > 0) {
      knownSlot = { startIso: ks.startIso };
      if (typeof ks.endIso === 'string' && ks.endIso.length > 0) {
        knownSlot.endIso = ks.endIso;
      }
    }
  }

  let eventClass: ClassifiedEventClass | null = null;
  if (slotBearing && typeof raw.eventClass === 'string') {
    if (VALID_EVENT_CLASSES.has(raw.eventClass as ClassifiedEventClass)) {
      eventClass = raw.eventClass as ClassifiedEventClass;
    }
  }

  let slotCommitment: ClassifiedSlotCommitment | null = null;
  if (intent === 'manual_schedule') {
    // Default 'offered' — the conservative reading. A missed 'booked'
    // costs Matt a manual calendar entry; a false 'booked' creates a
    // stub event for an appointment that was never agreed.
    slotCommitment = raw.slotCommitment === 'booked' ? 'booked' : 'offered';
  }

  const scopeSummary = typeof raw.scopeSummary === 'string' ? raw.scopeSummary : '';

  return {
    intent,
    score: intent === null ? 0 : score,
    confidence,
    rationale,
    knownSlot,
    eventClass,
    slotCommitment,
    scopeSummary,
  };
}

function buildIntentPrompt(
  text: string,
  opts: ClassifySchedulingIntentOptions,
): string {
  const now = opts.now ?? new Date();
  const tz = opts.timezone ?? 'America/New_York';
  const todayLocal = formatDateLocal(now, tz);
  const head =
    opts.speakerRole === 'customer' ? CUSTOMER_INTENT_PROMPT : MATT_INTENT_PROMPT;
  const context = opts.conversationContext?.trim();
  const contextBlock = context
    ? `Recent conversation (oldest first). Use it ONLY to resolve what the text to classify refers to — classify the final text, not the conversation:\n${context}\n\n`
    : '';
  return head
    .replaceAll('{{TIMEZONE}}', tz)
    .replaceAll('{{TODAY_DATE_LOCAL}}', todayLocal)
    .replace('{{CONTEXT_BLOCK}}', contextBlock)
    .concat('\n', text);
}

function formatDateLocal(d: Date, timezone: string): string {
  // Returns YYYY-MM-DD in the given timezone.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

const CUSTOMER_INTENT_PROMPT = `You are a scheduling-intent classifier for a foundation repair business. The text below is from a CUSTOMER (inbound message or call transcript). Classify the customer's scheduling intent.

Return exactly one of:

1. quote_approved — The customer is accepting a quote/estimate they previously received, or explicitly asking to move forward. Examples:
   - "Let's do it, let's get it on the books"
   - "Looks good, when can you start?"
   - "Approved — we want to schedule"
   - "Yes, let's move forward with the proposal"
   - "Yeah, we can do that" (on a call, agreeing when the business proposes getting the work scheduled)
   - "Throw me some dates and we'll go from there"

2. assessment_requested — The customer is asking for a NEW assessment, site visit, inspection, or estimate. No prior AAC quote for this work. Examples:
   - "Can you come out and look at my basement?"
   - "I'd like to get an estimate on a crack I have"
   - "Can we schedule someone to come take a look?"

3. callback_opened — The customer is reporting a problem with work AAC PREVIOUSLY COMPLETED (warranty/rework). Examples:
   - "The crack you fixed is leaking again"
   - "We're getting water in the same spot you sealed last spring"
   - "The injection from last year isn't holding"

4. appointment_confirmed — The customer is agreeing to a SPECIFIC date/time that was offered to them (visible in the conversation context, or restated in their message). Examples:
   - "Yes, Tuesday at 10 works for us"
   - "That will work, thank you" (when the business offered a concrete slot just before)
   - "Perfect, see you Friday morning"

5. null — No scheduling intent. The message is conversational, a pricing question without a schedule request, an information request, or an acknowledgement. Examples:
   - "Thanks!"
   - "How much would it cost?"
   - "Can you send me the proposal?"
   - "What does that line item mean?"

Return ONLY a JSON object:
- intent: "quote_approved" | "assessment_requested" | "callback_opened" | "appointment_confirmed" | null
- confidence: "high" | "medium" | "low"
- rationale: short evidence, fewer than 25 words
- knownSlot: for appointment_confirmed, the confirmed slot as { "startIso": "YYYY-MM-DDTHH:mm:ssZ", "endIso"?: "..." } resolved from the offer being accepted (ISO-8601 UTC, anchored against today {{TODAY_DATE_LOCAL}} in {{TIMEZONE}}); null for every other intent or when no concrete date+time can be resolved
- eventClass: for appointment_confirmed, "assessment" | "job" | "callback" inferred from what kind of visit was offered (free assessment / site look = "assessment"; performing repair work = "job"; revisit of prior AAC work = "callback"); null for other intents or when unclear
- scopeSummary: short scope hint if mentioned (e.g. "wet basement"), or ""

Rules:
- Acknowledgements ("ok", "got it", "sounds good") alone are NOT quote_approved unless the customer is clearly accepting the work.
- Asking the business to SEND date options ("throw me some dates", "send me some times", "let me know your next availability") after agreeing to proceed IS quote_approved — the customer is initiating scheduling even though they will confirm the specific date later. A trailing "I'll get back to you" about WHICH date does not cancel the acceptance.
- CRITICAL: an agreement ("Yes, that will work") given right after a specific date/time was offered is appointment_confirmed, NOT quote_approved — the customer is accepting the time slot, not necessarily the quote.
- appointment_confirmed requires a concrete date (and ideally time) resolvable from the conversation context or the message itself. A bare "yes" with no offered slot in sight is NOT appointment_confirmed.
- A pure pricing/info question with no schedule request is null.
- Distinguish assessment_requested (new) from callback_opened (rework of prior AAC work).
- When torn between two intents, lower confidence rather than guess.

Today is {{TODAY_DATE_LOCAL}} ({{TIMEZONE}}).

{{CONTEXT_BLOCK}}Text to classify:`;

const MATT_INTENT_PROMPT = `You are a scheduling-intent classifier. The speaker is Matt, the business owner of a foundation repair company. The text below is his OUTBOUND text (or his lines in a call). Classify whether Matt is naming an explicit schedule.

Return exactly one of:

1. manual_schedule — Matt is naming an explicit date/time to schedule the customer. Examples:
   - "Let's get you on the books for Tuesday at 10"
   - "I can be there Friday around 2"
   - "Wednesday morning works"
   - "How about next Monday at 9?"

2. null — No explicit scheduling time named. Includes vague availability discussion, calendar-checks ("let me check my calendar"), and general conversation.

For manual_schedule, also extract:
- knownSlot.startIso: ISO-8601 UTC. Anchor natural-language dates against today ({{TODAY_DATE_LOCAL}}) and timezone {{TIMEZONE}}.
- eventClass: "job" (default — work being performed), "assessment" (site visit / inspection), or "callback" (revisit of prior AAC work).
- slotCommitment: "booked" when Matt states the appointment as decided — he is committing to it, not asking. Examples: "I'm putting you down for Tuesday at 10", "You're on the calendar for Friday", "Mike will be there Monday at 9". "offered" when Matt is proposing a time and waiting for the customer's answer. Examples: "Would Tuesday at 10 work?", "I could do Friday around 2", "How about next Monday at 9?".
- scopeSummary: short hint if Matt mentions what work it's for, or "".

Return ONLY a JSON object:
- intent: "manual_schedule" | null
- confidence: "high" | "medium" | "low"
- rationale: short evidence, fewer than 25 words
- knownSlot: { "startIso": "YYYY-MM-DDTHH:mm:ssZ", "endIso"?: "YYYY-MM-DDTHH:mm:ssZ" } or null
- eventClass: "job" | "assessment" | "callback" or null
- slotCommitment: "booked" | "offered" | null
- scopeSummary: short string or ""

Rules:
- Only manual_schedule when Matt explicitly names a date/time.
- "Let me check my calendar" or "I'll get back to you" → null.
- Ambiguous day-name ("Tuesday") → assume the NEXT Tuesday from today {{TODAY_DATE_LOCAL}}.
- Date-only (no time) → set startIso at 08:00 local.
- Time-only (no date) → omit knownSlot; date is required.
- When unsure between "booked" and "offered", choose "offered". A question mark or "does that work" phrasing is ALWAYS "offered".

Today is {{TODAY_DATE_LOCAL}} ({{TIMEZONE}}).

{{CONTEXT_BLOCK}}Text to classify:`;
