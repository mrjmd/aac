import { GeminiClient } from "@aac/api-clients";

let client: GeminiClient | null = null;

export function getGeminiClient(): GeminiClient {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    client = new GeminiClient({ apiKey });
  }
  return client;
}
