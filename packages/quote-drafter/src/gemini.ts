import type { GeminiClient } from '@aac/api-clients/gemini';

/** Retry transient Gemini failures (429/5xx/timeout) like analyze.ts does. */
export async function generateWithRetry(
  gemini: GeminiClient,
  prompt: string,
  opts: {
    systemPrompt?: string;
    imageParts?: Array<{ mimeType: string; base64: string }>;
  },
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await gemini.generateContent(prompt, {
        systemPrompt: opts.systemPrompt,
        temperature: 0,
        maxOutputTokens: 8192,
        thinkingBudget: 4096,
        timeoutMs: 120_000,
        imageParts: opts.imageParts?.length ? opts.imageParts : undefined,
      });
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      if (attempt < 2 && /429|500|503|timeout|aborted/i.test(msg)) {
        await new Promise((r) => setTimeout(r, msg.includes('429') ? 65_000 : 5_000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('Gemini returned nothing after retries');
}
