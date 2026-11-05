/**
 * Google Ads REST client: GAQL search and generic mutate. Offline
 * conversions go through DataManagerClient (data-manager.ts): Ads'
 * UploadClickConversions is allowlist-only since 2026-06-15.
 *
 * Ported from aac-astro/scripts/lib/google-ads-client.js. The googleapis
 * package has no google.ads surface, so this talks to the REST API with an
 * OAuth access token minted from a refresh token (scope
 * https://www.googleapis.com/auth/adwords) plus the developer token.
 */

const DEFAULT_API_VERSION = 'v23';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Interfaces ───────────────────────────────────────────────────────

export interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Target account, digits only (e.g. '4683607368'). */
  customerId: string;
  /** MCC that owns the target account, digits only. */
  loginCustomerId?: string;
  /** REST API version, e.g. 'v23'. */
  apiVersion?: string;
}

export interface ConversionActionRow {
  resourceName: string;
  id: string;
  name: string;
  type: string;
  status: string;
  primaryForGoal?: boolean;
}

// ── Client ───────────────────────────────────────────────────────────

export class GoogleAdsClient {
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(private config: GoogleAdsConfig) {}

  private get baseUrl(): string {
    return `https://googleads.googleapis.com/${this.config.apiVersion ?? DEFAULT_API_VERSION}`;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) {
      return this.accessToken.token;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google Ads OAuth refresh failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    // Refresh a minute early so a long run never sends an expired token.
    const ttlMs = ((body.expires_in ?? 3600) - 60) * 1000;
    this.accessToken = { token: body.access_token, expiresAt: Date.now() + ttlMs };
    return body.access_token;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      'developer-token': this.config.developerToken,
      'Content-Type': 'application/json',
    };
    if (this.config.loginCustomerId) headers['login-customer-id'] = this.config.loginCustomerId;

    const res = await fetch(`${this.baseUrl}/customers/${this.config.customerId}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403 && text.includes('DEVELOPER_TOKEN_NOT_APPROVED')) {
        throw new Error('Google Ads developer token is in test mode (DEVELOPER_TOKEN_NOT_APPROVED)');
      }
      throw new Error(`Google Ads API error ${res.status} on ${path}: ${text.slice(0, 1000)}`);
    }
    return (await res.json()) as T;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Run a GAQL query (searchStream) and return the flattened result rows.
   * Rows keep the API's camelCase nesting, e.g. row.conversionAction.name.
   */
  async search<T = Record<string, unknown>>(query: string): Promise<T[]> {
    const batches = await this.post<Array<{ results?: T[] }>>('/googleAds:searchStream', { query });
    const rows: T[] = [];
    for (const batch of Array.isArray(batches) ? batches : []) {
      if (batch.results) rows.push(...batch.results);
    }
    return rows;
  }

  /**
   * Create/update/remove any resource, e.g. mutate('conversionActions',
   * [{ create: {...} }]). Returns the raw MutateXResponse.
   */
  async mutate<T = { results?: Array<{ resourceName?: string }> }>(
    resourceType: string,
    operations: Record<string, unknown>[],
    opts: { validateOnly?: boolean } = {},
  ): Promise<T> {
    return this.post<T>(`/${resourceType}:mutate`, {
      operations,
      ...(opts.validateOnly ? { validateOnly: true } : {}),
    });
  }

  /** All non-removed conversion actions in the account. */
  async listConversionActions(): Promise<ConversionActionRow[]> {
    const rows = await this.search<{
      conversionAction: {
        resourceName: string;
        id: string;
        name: string;
        type: string;
        status: string;
        primaryForGoal?: boolean;
      };
    }>(
      'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, ' +
        'conversion_action.type, conversion_action.status, conversion_action.primary_for_goal ' +
        "FROM conversion_action WHERE conversion_action.status != 'REMOVED'",
    );
    return rows.map((r) => ({ ...r.conversionAction }));
  }
}
