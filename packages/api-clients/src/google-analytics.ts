/**
 * Google Analytics Data API client — Service Account reporting.
 *
 * TODO: Extract from aac-astro/scripts/ga4-report.js and related scripts
 * during Phase 3 (storefront migration).
 */

export interface GoogleAnalyticsConfig {
  propertyId: string;
  credentials: Record<string, unknown>; // Service account JSON
}

export class GoogleAnalyticsClient {
  constructor(private config: GoogleAnalyticsConfig) {}

  async runReport(_request: Record<string, unknown>) { return this.stub('runReport'); }

  private stub(method: string): never {
    throw new Error(`GoogleAnalyticsClient.${method}() not yet extracted`);
  }
}
