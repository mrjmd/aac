/**
 * Google Search Console client — Query performance data.
 *
 * Minimal extraction from aac-astro/scripts/gsc-report.js.
 * Only `queryPerformance()` implemented for now.
 *
 * Supports service account or OAuth2 auth (same as GoogleAnalyticsClient).
 * Uses the `googleapis` package.
 */

import { google, type searchconsole_v1 } from 'googleapis';

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('google-search-console');

// ── Interfaces ───────────────────────────────────────────────────────

export interface GoogleSearchConsoleConfig {
  siteUrl: string; // e.g., 'https://www.attackacrack.com'
  /** Service account JSON credentials */
  credentials?: Record<string, unknown>;
  /** OAuth2 credentials (alternative to service account) */
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export interface GSCQueryRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  dimensions: Array<'query' | 'page' | 'country' | 'device' | 'date'>;
  rowLimit?: number; // max 25000, default 1000
  dimensionFilterGroups?: Array<{
    filters: Array<{
      dimension: string;
      operator?: 'equals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
      expression: string;
    }>;
  }>;
}

export interface GSCQueryRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;      // decimal (0.05 = 5%)
  position: number;  // average position
}

export interface GSCQueryResponse {
  rows: GSCQueryRow[];
}

// ── Client ───────────────────────────────────────────────────────────

export class GoogleSearchConsoleClient {
  private _client: searchconsole_v1.Searchconsole | null = null;

  constructor(private config: GoogleSearchConsoleConfig) {}

  private async getClient(): Promise<searchconsole_v1.Searchconsole> {
    if (!this._client) {
      let auth;

      if (this.config.oauth) {
        const oauth2 = new google.auth.OAuth2(
          this.config.oauth.clientId,
          this.config.oauth.clientSecret,
        );
        oauth2.setCredentials({ refresh_token: this.config.oauth.refreshToken });
        auth = oauth2;
      } else if (this.config.credentials) {
        auth = new google.auth.GoogleAuth({
          credentials: this.config.credentials,
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        });
      } else {
        throw new Error('GoogleSearchConsoleClient requires either credentials or oauth config');
      }

      this._client = google.searchconsole({ version: 'v1', auth });
    }
    return this._client;
  }

  /**
   * Query Search Console performance data.
   *
   * Returns rows with keys (one per dimension), clicks, impressions, ctr, position.
   */
  async queryPerformance(request: GSCQueryRequest): Promise<GSCQueryResponse> {
    const client = await this.getClient();

    log.debug('Querying GSC performance', {
      siteUrl: this.config.siteUrl,
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: request.dimensions,
    });

    const response = await client.searchanalytics.query({
      siteUrl: this.config.siteUrl,
      requestBody: {
        startDate: request.startDate,
        endDate: request.endDate,
        dimensions: request.dimensions,
        rowLimit: request.rowLimit || 1000,
        dimensionFilterGroups: request.dimensionFilterGroups,
      },
    });

    const rows: GSCQueryRow[] = (response.data.rows || []).map((r) => ({
      keys: r.keys || [],
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: r.position || 0,
    }));

    log.debug('GSC query complete', { rowCount: rows.length });
    return { rows };
  }
}
