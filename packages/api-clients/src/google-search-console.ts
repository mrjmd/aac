/**
 * Google Search Console client — Query performance and CTR data.
 *
 * TODO: Extract from aac-astro/scripts/gsc-report.js
 * during Phase 3 (website migration).
 */

export interface GoogleSearchConsoleConfig {
  siteUrl: string;
  credentials: Record<string, unknown>; // OAuth or service account
}

export class GoogleSearchConsoleClient {
  constructor(private config: GoogleSearchConsoleConfig) {}

  async queryPerformance(_request: Record<string, unknown>) { return this.stub('queryPerformance'); }

  private stub(method: string): never {
    throw new Error(`GoogleSearchConsoleClient.${method}() not yet extracted`);
  }
}
