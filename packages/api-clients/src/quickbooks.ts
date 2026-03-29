/**
 * QuickBooks Online client — Estimate drafting and customer sync.
 *
 * TODO: Extract from aac-slim/src/clients/quickbooks.ts (397 lines)
 * during Phase 0. OAuth token management is the complex part.
 */

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  realmId: string;
  redirectUri: string;
  /** Function to retrieve stored tokens */
  getTokens: () => Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>;
  /** Function to persist refreshed tokens */
  saveTokens: (tokens: { accessToken: string; refreshToken: string; expiresAt: number }) => Promise<void>;
}

export class QuickBooksClient {
  constructor(private config: QuickBooksConfig) {}

  async searchCustomer(_query: string) { return this.stub('searchCustomer'); }
  async createCustomer(_data: Record<string, unknown>) { return this.stub('createCustomer'); }
  async queryInvoices(_dateRange: { start: string; end: string }) { return this.stub('queryInvoices'); }

  private stub(method: string): never {
    throw new Error(`QuickBooksClient.${method}() not yet extracted — run Phase 0`);
  }
}
