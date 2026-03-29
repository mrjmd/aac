/**
 * Google Ads client — Conversion uploads and campaign management.
 * Requires Developer Token + MCC access.
 *
 * TODO: Extract from aac-astro/scripts/google-ads-*.js
 * during Phase 3 (storefront migration).
 */

export interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string; // MCC
}

export class GoogleAdsClient {
  constructor(private config: GoogleAdsConfig) {}

  async uploadConversion(_data: Record<string, unknown>) { return this.stub('uploadConversion'); }
  async getKeywordPerformance(_query: string) { return this.stub('getKeywordPerformance'); }
  async manageBids(_adjustments: Record<string, unknown>[]) { return this.stub('manageBids'); }

  private stub(method: string): never {
    throw new Error(`GoogleAdsClient.${method}() not yet extracted`);
  }
}
