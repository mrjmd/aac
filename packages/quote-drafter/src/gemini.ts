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
    maxOutputTokens: 8192,
    thinkingBudget: 4096,
    timeoutMs: 120_000,
    imageParts: opts.imageParts?.length ? opts.imageParts : undefined,
    retries: 2,
  });
}
