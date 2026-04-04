/**
 * Redis key schema builders and TTL constants.
 *
 * Defines the GLOBAL key schema for the shared Upstash Redis database.
 * Every app/tool that touches Redis imports key builders from here.
 *
 * This file is DECLARATIVE — it defines the schema, not the operations.
 * Each app provides its own operational Redis layer that imports these
 * key builders to construct keys.
 *
 * Extracted and consolidated from aac-slim/src/lib/redis.ts.
 */

/**
 * Centralized Redis key builders. All keys used across the monorepo
 * MUST be defined here to prevent collisions and enable discoverability.
 */
export const keys = {
  // ── Health & Observability ──────────────────────────────────────────

  /** Heartbeat keys — written by apps, read by Command Center */
  heartbeat: (app: string) => `health:${app}:ts` as const,

  /** Webhook processing count per source per day — 48h TTL */
  webhookCount: (source: string, date: string) => `webhooks:${source}:${date}:count` as const,

  /** Last webhook processed timestamp per source */
  webhookLast: (source: string) => `webhooks:${source}:last` as const,

  /** Health error log (list, capped at 100 entries) */
  healthErrors: 'health:errors' as const,

  /** Webhook audit stream — read by Command Center */
  webhookAuditStream: 'logs:webhooks' as const,

  // ── Deduplication ──────────────────────────────────────────────────

  /** Webhook deduplication — 24h TTL */
  dedupe: (source: string, eventId: string) => `dedupe:${source}:${eventId}` as const,

  // ── ID Mapping ─────────────────────────────────────────────────────

  /** Bidirectional ID mapping — 7d TTL */
  map: {
    pipedriveToQuo: (pipedriveId: string) => `map:pd-to-quo:${pipedriveId}` as const,
    quoToPipedrive: (quoId: string) => `map:quo-to-pd:${quoId}` as const,
    pipedriveToQb: (pipedriveId: string) => `map:pd-to-qb:${pipedriveId}` as const,
    qbToPipedrive: (qbId: string) => `map:qb-to-pd:${qbId}` as const,
    phoneToPipedrive: (phone: string) => `phone:pd:${phone}` as const,
  },

  // ── Loop Prevention ────────────────────────────────────────────────

  /** Track contacts created by middleware (for loop prevention) — 60s TTL */
  createdByUs: (system: string, id: string) => `created-by-us:${system}:${id}` as const,

  // ── QuickBooks OAuth ───────────────────────────────────────────────

  /** QB OAuth token storage */
  qbOAuthTokens: 'oauth:quickbooks:tokens' as const,

  // ── To-Do Items ────────────────────────────────────────────────────

  /** Individual to-do item (JSON blob) */
  todo: (todoId: string) => `todo:${todoId}` as const,

  /** Sorted set of all to-do IDs, scored by due date (epoch ms) */
  todoList: 'todo:list' as const,

  // ── Campaign State ─────────────────────────────────────────────────

  /** Campaign state — 90d TTL */
  campaign: (campaignId: string) => `campaign:${campaignId}` as const,
  campaignContacts: (campaignId: string) => `campaign:${campaignId}:contacts` as const,
  campaignsActive: 'campaigns:active' as const,

  /** Marketing campaign stats — written by Marketing, read by Command Center */
  campaignStats: (campaignId: string) => `stats:campaign:${campaignId}` as const,

  // ── Suppression Lists ──────────────────────────────────────────────

  /** Suppression lists (no TTL — permanent) */
  optouts: 'optouts:phones' as const,
  suppressionDnc: 'suppression:dnc' as const,
  suppressionLitigators: 'suppression:litigators' as const,
  suppressionLandlines: 'suppression:landlines' as const,

  // ── Attribution ────────────────────────────────────────────────────

  /** Attribution — 1y TTL */
  attribution: (invoiceId: string) => `attribution:${invoiceId}` as const,
  attributionProcessed: (invoiceId: string) => `attribution:processed:${invoiceId}` as const,
} as const;

/**
 * Standard TTL values in seconds.
 */
export const ttl = {
  dedupe: 86_400,            // 24 hours
  idMapping: 604_800,        // 7 days
  loopPrevention: 60,        // 60 seconds
  webhookCount: 172_800,     // 48 hours (keep yesterday + today)
  campaign: 7_776_000,       // 90 days
  attribution: 31_536_000,   // 1 year
} as const;
