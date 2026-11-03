/**
 * Shared TypeScript interfaces used across all apps.
 *
 * These are the canonical types that prevent drift between pillars.
 * If an app needs a Lead, it imports it from here.
 *
 * TODO: Consolidate from aac-slim types during Phase 0 extraction.
 */

/** A lead/contact as represented across systems. */
export interface Lead {
  phone: string;           // E.164 format
  firstName?: string;
  lastName?: string;
  email?: string;
  source?: LeadSource;
  pipedriveId?: string;
  quoId?: string;
  qbCustomerId?: string;
}

export type LeadSource =
  | 'website'
  | 'google_ads'
  | 'referral'
  | 'sms_campaign'
  | 'phone_inbound'
  | 'unknown';

/** A Pipedrive deal/estimate. */
export interface Estimate {
  pipedriveId: string;
  title: string;
  value?: number;
  currency?: string;
  status: 'open' | 'won' | 'lost' | 'deleted';
  contactId?: string;
}

/** Webhook event metadata for audit logging. */
export interface WebhookEvent {
  source: 'pipedrive' | 'quo' | 'google_ads' | 'quickbooks';
  eventType: string;
  timestamp: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
}

/** Campaign result stats written to Redis by Marketing, read by Command Center. */
export interface CampaignStats {
  campaignId: string;
  sent: number;
  delivered: number;
  failed: number;
  responses: number;
  optOuts: number;
  updatedAt: string;
}

/** Health heartbeat written by each app. */
export interface Heartbeat {
  app: string;
  timestamp: string;
  status: 'healthy' | 'degraded' | 'down';
  details?: Record<string, unknown>;
}

/** QuickBooks OAuth tokens stored in Redis. */
export interface QBOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  realmId: string;
}

/**
 * One open (Pending) estimate in the T4 scope-change index
 * (`keys.quoteDraftOpen` HASH: phone → JSON OpenQuoteEntry). Written by
 * the quote drafter at create/regenerate and maintained by middleware's
 * qb-reconcile cron. Advisory: consumers re-verify ownership against
 * live QBO before any write.
 */
export interface OpenQuoteEntry {
  estimateId: string;
  docNumber: string;
  customerId: string;
  customer: string;
  /** Customer email on the QBO record/estimate — the email-channel match key. */
  email: string | null;
  total: number;
  /** Compact "item ×qty" summary for the gate prompt. */
  linesSummary: string;
  /** Last known ownership (stored SyncToken == live SyncToken). */
  botOwned: boolean;
  updatedAt: string;
}
