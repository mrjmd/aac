/**
 * Gemini AI client — Image analysis and intent extraction.
 *
 * TODO: Extract from aac-slim/src/clients/gemini.ts (149 lines)
 * during Phase 0.
 */

export interface GeminiConfig {
  apiKey: string;
}

export class GeminiClient {
  constructor(private config: GeminiConfig) {}

  async extractEntities(_text: string) { return this.stub('extractEntities'); }
  async analyzeImages(_images: string[]) { return this.stub('analyzeImages'); }

  private stub(method: string): never {
    throw new Error(`GeminiClient.${method}() not yet extracted — run Phase 0`);
  }
}
