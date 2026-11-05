/**
 * Google Data Manager API client: offline click conversions for Google Ads.
 *
 * Google Ads' own UploadClickConversions is closed to accounts that weren't
 * already uploading before 2026-06-15 (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE);
 * Data Manager's events:ingest is the replacement. OAuth only (scope
 * https://www.googleapis.com/auth/datamanager), no developer token, and the
 * API must be enabled on the OAuth client's Cloud project.
 *
 * Validation is fast-fail: one bad event rejects the whole request, nothing
 * is ingested, and the 400 names the event index. Processing problems after
 * acceptance (e.g. an expired gclid) only show in request diagnostics.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';

export interface DataManagerConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GoogleAdsDestination {
  /** Referenced by DataManagerEvent.destinationReferences. */
  reference: string;
  /** Ads account that owns the conversion action, digits only. */
  operatingAccountId: string;
  /** MCC the caller signs in through, digits only. */
  loginAccountId?: string;
  /** Conversion action ID (UPLOAD_CLICKS). */
  conversionActionId: string;
}

export interface DataManagerEvent {
  destinationReferences: string[];
  gclid: string;
  /** RFC 3339 with offset, e.g. '2026-11-05T14:03:00-05:00'. */
  eventTimestamp: string;
  /** Dedup key: Google keeps the first event per ID. */
  transactionId: string;
  conversionValue?: number;
  currency?: string;
  eventSource?: 'WEB' | 'APP' | 'IN_STORE' | 'PHONE' | 'MESSAGE' | 'OTHER';
}

export interface IngestResponse {
  requestId: string;
  fieldWarnings?: unknown[];
}

export class DataManagerClient {
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(private config: DataManagerConfig) {}

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.token;
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
    if (!res.ok) throw new Error(`Data Manager OAuth refresh failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.accessToken = { token: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return body.access_token;
  }

  /** Send up to 2,000 conversion events to Google Ads destinations. */
  async ingestEvents(
    destinations: GoogleAdsDestination[],
    events: DataManagerEvent[],
    opts: { validateOnly?: boolean } = {},
  ): Promise<IngestResponse> {
    if (events.length > 2000) throw new Error('Data Manager ingest takes at most 2,000 events per request');
    const body = {
      destinations: destinations.map((d) => ({
        reference: d.reference,
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: d.operatingAccountId },
        ...(d.loginAccountId ? { loginAccount: { accountType: 'GOOGLE_ADS', accountId: d.loginAccountId } } : {}),
        productDestinationId: d.conversionActionId,
      })),
      events: events.map((e) => ({
        destinationReferences: e.destinationReferences,
        adIdentifiers: { gclid: e.gclid },
        eventTimestamp: e.eventTimestamp,
        transactionId: e.transactionId,
        ...(e.conversionValue !== undefined ? { conversionValue: e.conversionValue, currency: e.currency ?? 'USD' } : {}),
        eventSource: e.eventSource ?? 'WEB',
      })),
      ...(opts.validateOnly ? { validateOnly: true } : {}),
    };
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Data Manager ingest error ${res.status}: ${text.slice(0, 2000)}`);
    return (text ? JSON.parse(text) : { requestId: '' }) as IngestResponse;
  }
}
