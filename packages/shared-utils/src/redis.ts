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

  /** Distributed lock for contact creation (prevents duplicate creates) — 30s TTL */
  contactCreateLock: (system: string, phone: string) => `lock:create:${system}:${phone}` as const,

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

  // ── Field App (Job Completion) ─────────────────────────────────────

  /** Completion record for a calendar event — written by apps/field when tech marks complete */
  fieldCompletion: (calendarEventId: string) => `field:completion:${calendarEventId}` as const,

  /** Cached Drive file metadata (owner, thumbnail) for calendar attachments */
  driveFileInfo: (fileId: string) => `drive:file-info:${fileId}` as const,

  /** Session for the field app (opaque cookie ID → { email, name }) — renewed on each request */
  fieldSession: (sessionId: string) => `field:session:${sessionId}` as const,

  /** Per-user Google OAuth refresh tokens, keyed by lowercased email. Refresh tokens don't expire. */
  fieldUserGoogleTokens: (email: string) => `field:google-tokens:${email.toLowerCase()}` as const,

  /** Short-lived OAuth state nonce → return-to path, for CSRF protection during the OAuth round-trip */
  fieldOAuthState: (state: string) => `field:oauth-state:${state}` as const,

  /** Resolved customer info for a calendar event (PD person ID + structured city/state). 1d TTL. */
  fieldEventCustomer: (calendarEventId: string) => `field:event-customer:${calendarEventId}` as const,

  /** Cached drive-time estimate for one (origin, destination, departure bucket) triple. 30d TTL. */
  fieldTravelLeg: (key: string) => `field:travel-leg:${key}` as const,

  /** Per-user app config (home address, preferences). No TTL — user-owned, persists. */
  fieldUserConfig: (email: string) => `field:user-config:${email.toLowerCase()}` as const,

  // ── Scheduling (SchedulingDirective Pipeline) ──────────────────────

  /** Individual SchedulingDirective JSON blob, written by middleware webhook/cron handlers in Crawl shadow mode. */
  schedulingPending: (directiveId: string) => `scheduling:pending:${directiveId}` as const,

  /** LIST of pending directive IDs, newest first (LPUSH + LTRIM). Read by command-center. */
  schedulingPendingList: 'scheduling:pending:list' as const,

  /**
   * LIST of directive IDs whose classifier confidence fell below the
   * auto-propose threshold (default 0.7). Surfaced as a separate
   * "Needs review" section in the command-center so Matt can decide
   * manually instead of an SMS auto-fire. LPUSH + LTRIM at 500.
   */
  schedulingPendingReviewList: 'scheduling:pending-review:list' as const,

  /**
   * Reverse index: QB Estimate ID → directive ID. Set by `writePendingDirective`
   * when the directive carries a `qbEstimateId`. Used by the QB reconciliation
   * cron to avoid creating a duplicate directive when the webhook already did.
   * No TTL — stays as long as the directive itself does.
   */
  schedulingDirectiveByEstimate: (qbEstimateId: string) =>
    `scheduling:directive-by-qb-estimate:${qbEstimateId}` as const,

  /**
   * Counter for Quo scheduling-intent classifier calls, partitioned by event
   * type and day. Used to validate our (currently hand-waved) assumption
   * about call-transcript volume before deciding whether to drop the
   * matt-side classifier on transcripts. 30d TTL.
   */
  schedulingClassifierCount: (eventType: string, day: string) =>
    `scheduling:classifier-count:${eventType}:${day}` as const,

  /** Counter for directives written from the Quo path, by event type + day. 30d TTL. */
  schedulingDirectivesFromQuo: (eventType: string, day: string) =>
    `scheduling:directives-from-quo:${eventType}:${day}` as const,

  /**
   * Active scheduling proposal sent to the agent line. Written by the agent's
   * proposals endpoint when middleware pushes a proposal. JSON blob with
   * directive id + slot + reasoning + draft event description + SMS id +
   * owner phone. 24h TTL. Reverse-keyed by `agentActiveProposalForOwner`.
   */
  agentProposal: (proposalId: string) => `agent:proposal:${proposalId}` as const,

  /**
   * Reverse index for the owner's currently-active scheduling proposal.
   * Single value (proposalId) per owner phone so the inbound reply router
   * can find the proposal Matt's reply targets. 24h TTL.
   */
  agentActiveProposalForOwner: (ownerPhoneE164: string) =>
    `agent:active-proposal:${ownerPhoneE164}` as const,

  /**
   * Decision made by Matt on a scheduling proposal. Written by the middleware
   * proposal-decision endpoint when the agent calls back. JSON blob with
   * decision (approved/rejected/edit) + replyText + decidedAt. Read by the
   * command-center scheduling view to surface decisions next to each
   * directive. 30d TTL.
   */
  schedulingProposalDecision: (proposalId: string) =>
    `scheduling:proposal-decision:${proposalId}` as const,

  /**
   * Reverse index: directive ID → most recent proposal ID. Used by the
   * command-center to look up a directive's decision without a scan.
   * 30d TTL.
   */
  schedulingProposalByDirective: (directiveId: string) =>
    `scheduling:proposal-by-directive:${directiveId}` as const,

  // ── Agent (Conversational Operations Runtime) ──────────────────────

  /** Per-cron-job cursor (e.g. last surfaced error ID in error-surface tick). No TTL. */
  agentCronCursor: (job: string) => `agent:cron:${job}:cursor` as const,

  /** Standing rules per agent user, keyed by E.164 phone. JSON blob, no TTL. */
  agentRules: (phoneE164: string) => `agent:rules:${phoneE164}` as const,

  /** Audit log for every Q&A handled by the agent. Capped LIST (LPUSH + LTRIM
   *  at write time), newest first; Command Center reads via LRANGE. Name retained
   *  as `agentAuditStream` despite list semantics for backwards compat with the
   *  agent scaffold. */
  agentAuditStream: 'agent:audit:stream' as const,
} as const;

/**
 * Standard TTL values in seconds.
 */
export const ttl = {
  dedupe: 86_400,            // 24 hours
  idMapping: 604_800,        // 7 days
  loopPrevention: 60,        // 60 seconds
  contactCreateLock: 30,     // 30 seconds
  webhookCount: 172_800,     // 48 hours (keep yesterday + today)
  campaign: 7_776_000,       // 90 days
  attribution: 31_536_000,   // 1 year
  fieldSession: 31_536_000,  // 1 year (renewed on activity — effectively forever)
  fieldOAuthState: 600,      // 10 minutes (just long enough to complete the redirect)
  fieldEventCustomer: 86_400, // 24h — PD address edits propagate within a day
  fieldTravelLeg: 2_592_000, // 30d — driving patterns at the same hour-of-week don't change fast
  agentProposal: 86_400,     // 24h — Matt either responds same day or we move on
  schedulingProposalDecision: 2_592_000, // 30d — kept for command-center retro view
} as const;
