import type { GeminiClient } from '@aac/api-clients/gemini';

/** The drafter's generation settings: deterministic, roomy thinking budget, 2 retries on transient failures. */
export function generateWithRetry(
  gemini: GeminiClient,
  prompt: string,
  opts: {
    systemPrompt?: string;
    imageParts?: Array<{ mimeType: string; base64: string }>;
  },
): Promise<string> {
  return gemini.generateContent(prompt, {
    systemPrompt: opts.systemPrompt,
    temperature: 0,
    // The thinking budget is soft: one ·6362 run thought for 7,860 tokens and
    // ran out of an 8192 cap mid-JSON (11/05). Only used tokens are billed.
    maxOutputTokens: 16384,
    thinkingBudget: 4096,
    timeoutMs: 120_000,
    imageParts: opts.imageParts?.length ? opts.imageParts : undefined,
    retries: 2,
  });
}
