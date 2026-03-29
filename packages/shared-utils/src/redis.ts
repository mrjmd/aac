/**
 * Redis key schema builders and deduplication logic.
 *
 * Defines the GLOBAL key schema for the shared Upstash Redis database.
 * Every app/tool that touches Redis imports key builders from here.
 *
 * TODO: Extract and consolidate from aac-slim/src/lib/redis.ts during Phase 0.
 */

/**
 * Centralized Redis key builders. All keys used across the monorepo
 * MUST be defined here to prevent collisions and enable discoverability.
 */
export const keys = {
  /** Heartbeat keys — written by apps, read by Command Center */
  heartbeat: (app: string) => `health:${app}:ts` as const,

  /** Webhook deduplication — 24h TTL */
  dedupe: (source: string, eventId: string) => `dedupe:${source}:${eventId}` as const,

  /** Bidirectional ID mapping — 7d TTL */
  map: {
    pipedriveToQuo: (pipedriveId: string) => `map:pd-to-quo:${pipedriveId}` as const,
    quoToPipedrive: (quoId: string) => `map:quo-to-pd:${quoId}` as const,
    pipedriveToQb: (pipedriveId: string) => `map:pd-to-qb:${pipedriveId}` as const,
    qbToPipedrive: (qbId: string) => `map:qb-to-pd:${qbId}` as const,
    phoneToPipedrive: (phone: string) => `phone:pd:${phone}` as const,
  },

  /** Loop prevention — 60s TTL */
  createdByUs: (system: string, id: string) => `created-by-us:${system}:${id}` as const,

  /** Campaign state — 90d TTL */
  campaign: (campaignId: string) => `campaign:${campaignId}` as const,
  campaignContacts: (campaignId: string) => `campaign:${campaignId}:contacts` as const,

  /** Suppression lists (no TTL — permanent) */
  optouts: 'optouts:phones' as const,
  suppressionDnc: 'suppression:dnc' as const,
  suppressionLitigators: 'suppression:litigators' as const,
  suppressionLandlines: 'suppression:landlines' as const,

  /** Attribution — 1y TTL */
  attribution: (invoiceId: string) => `attribution:${invoiceId}` as const,

  /** Webhook audit stream — read by Command Center */
  webhookAuditStream: 'logs:webhooks' as const,

  /** Marketing campaign stats — written by Marketing, read by Command Center */
  campaignStats: (campaignId: string) => `stats:campaign:${campaignId}` as const,
} as const;

/**
 * Standard TTL values in seconds.
 */
export const ttl = {
  dedupe: 86_400,          // 24 hours
  idMapping: 604_800,      // 7 days
  loopPrevention: 60,      // 60 seconds
  campaign: 7_776_000,     // 90 days
  attribution: 31_536_000, // 1 year
} as const;
