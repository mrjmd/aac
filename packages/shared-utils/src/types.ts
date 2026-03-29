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
