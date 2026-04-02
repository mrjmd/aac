/**
 * Google Analytics Data API client.
 *
 * Minimal extraction from aac-astro/scripts/ga4-report.js.
 * Only `runReport()` + `parseRows()` implemented for now.
 * Full client expansion deferred to Phase 3 (website migration).
 *
 * Supports two auth modes:
 * - Service account: pass `credentials` (service account JSON)
 * - OAuth2: pass `oauth` with clientId, clientSecret, refreshToken
 *
 * Uses the `googleapis` package for auth and API access.
 */

import { google, type analyticsdata_v1beta } from 'googleapis';

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('google-analytics');

// ── Interfaces ───────────────────────────────────────────────────────

export interface GoogleAnalyticsConfig {
  propertyId: string;
  /** Service account JSON credentials */
  credentials?: Record<string, unknown>;
  /** OAuth2 credentials (alternative to service account) */
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

// Request types — mirrors googleapis requestBody shape

export interface GA4DateRange {
  startDate: string; // 'YYYY-MM-DD' or relative like '30daysAgo'
  endDate: string;   // 'YYYY-MM-DD' or 'today'
}

export interface GA4Dimension {
  name: string; // e.g., 'pagePath', 'customEvent:phone_region'
}

export interface GA4Metric {
  name: string; // e.g., 'eventCount', 'sessions'
}

export interface GA4DimensionFilter {
  filter?: {
    fieldName: string;
    stringFilter?: { value: string; matchType?: string };
    inListFilter?: { values: string[] };
  };
  orGroup?: {
    expressions: GA4DimensionFilter[];
  };
  andGroup?: {
    expressions: GA4DimensionFilter[];
  };
  notExpression?: GA4DimensionFilter;
}

export interface GA4OrderBy {
  metric?: { metricName: string };
  dimension?: { dimensionName: string };
  desc?: boolean;
}

export interface GA4ReportRequest {
  dateRanges: GA4DateRange[];
  dimensions?: GA4Dimension[];
  metrics?: GA4Metric[];
  dimensionFilter?: GA4DimensionFilter;
  orderBys?: GA4OrderBy[];
  limit?: number;
}

// Response types

export interface GA4ReportRow {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

export interface GA4ReportResponse {
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string }>;
  rows: GA4ReportRow[];
  rowCount: number;
}

// ── Client ───────────────────────────────────────────────────────────

export class GoogleAnalyticsClient {
  private _client: analyticsdata_v1beta.Analyticsdata | null = null;

  constructor(private config: GoogleAnalyticsConfig) {}

  // ── Private helpers ────────────────────────────────────────────────

  private async getClient(): Promise<analyticsdata_v1beta.Analyticsdata> {
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
          scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
        });
      } else {
        throw new Error('GoogleAnalyticsClient requires either credentials or oauth config');
      }

      this._client = google.analyticsdata({ version: 'v1beta', auth });
    }
    return this._client;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Run a GA4 Data API report.
   *
   * Wraps `analyticsdata.properties.runReport()` with typed request/response.
   */
  async runReport(request: GA4ReportRequest): Promise<GA4ReportResponse> {
    const client = await this.getClient();
    const property = `properties/${this.config.propertyId}`;

    log.debug('Running GA4 report', {
      property,
      dateRanges: request.dateRanges,
      dimensions: request.dimensions?.map((d) => d.name),
      metrics: request.metrics?.map((m) => m.name),
    });

    const response = await client.properties.runReport({
      property,
      requestBody: request as analyticsdata_v1beta.Schema$RunReportRequest,
    });

    const data = response.data;

    const result: GA4ReportResponse = {
      dimensionHeaders: (data.dimensionHeaders || []).map((h) => ({
        name: h.name || '',
      })),
      metricHeaders: (data.metricHeaders || []).map((h) => ({
        name: h.name || '',
      })),
      rows: (data.rows || []).map((row) => ({
        dimensionValues: (row.dimensionValues || []).map((v) => ({
          value: v.value || '',
        })),
        metricValues: (row.metricValues || []).map((v) => ({
          value: v.value || '',
        })),
      })),
      rowCount: data.rowCount || 0,
    };

    log.debug('GA4 report complete', { rowCount: result.rowCount });
    return result;
  }

  /**
   * Parse a report response into flat objects.
   *
   * Converts parallel dimension/metric value arrays into
   * `{ pagePath: '/contact', eventCount: 42 }` style records.
   * Numeric strings are auto-converted to numbers.
   */
  parseRows(response: GA4ReportResponse): Record<string, string | number>[] {
    const dimNames = response.dimensionHeaders.map((h) => h.name);
    const metNames = response.metricHeaders.map((h) => h.name);

    return response.rows.map((row) => {
      const obj: Record<string, string | number> = {};

      row.dimensionValues.forEach((v, i) => {
        obj[dimNames[i]] = v.value;
      });

      row.metricValues.forEach((v, i) => {
        const val = v.value;
        obj[metNames[i]] = val.includes('.') ? parseFloat(val) : parseInt(val, 10);
      });

      return obj;
    });
  }
}
