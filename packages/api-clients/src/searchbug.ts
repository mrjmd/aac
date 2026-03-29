/**
 * SearchBug client — Phone scrubbing and DNC validation.
 *
 * TODO: Extract from aac-slim/src/clients/searchbug.ts (339 lines)
 * during Phase 0.
 */

export interface SearchBugConfig {
  coCode: string;
  apiKey: string;
}

export class SearchBugClient {
  constructor(private config: SearchBugConfig) {}

  async validatePhones(_phones: string[]) { return this.stub('validatePhones'); }
  async batchScrub(_phones: string[]) { return this.stub('batchScrub'); }

  private stub(method: string): never {
    throw new Error(`SearchBugClient.${method}() not yet extracted — run Phase 0`);
  }
}
