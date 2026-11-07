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

  /** SET NX EX marker: a worker route already recorded a health error in the last few minutes (stops a per-minute failure flooding the 100-entry list). */
  healthErrorThrottle: (source: string) => `health:errors:throttle:${source}` as const,

  /**
   * HASH: condition name → count of silent skips on an Eastern day
   * (YYYY-MM-DD), e.g. 'invoice-create.no_qb_customer'. Written by
   * countCondition (@aac/shared-utils/health), TTL ttl.healthConditions.
   * Read by the command center System health page.
   */
  healthConditions: (day: string) => `health:conditions:${day}` as const,

  /**
   * HASH: '<condition>|<entity id>' → JSON {label, at} for the skips that
   * name what they skipped (e.g. the calendar event of a job not invoiced).
   * Only written when the caller passes an entity, so it stays as small as
   * the day's skips. Same day and TTL as healthConditions.
   */
  healthConditionEntities: (day: string) => `health:conditions:${day}:entities` as const,

  /**
   * ZSET: one member per occurrence of a rolling-window condition (score =
   * epoch ms), pruned to the last ttl.healthConditionRecent seconds on every
   * write. The watchdog counts the last hour (Gemini degraded).
   */
  healthConditionRecent: (name: string) => `health:conditions:recent:${name}` as const,

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

  /**
   * Single-flight lock for QB token refresh (SET NX PX, 30s TTL). Intuit
   * rotates the refresh token on every grant; concurrent refreshes across
   * apps can strand everyone with a dead token.
   */
  qbRefreshLock: 'oauth:quickbooks:refresh-lock' as const,

  /**
   * One-time CSRF state nonce for the QB OAuth connect → callback round
   * trip (middleware /api/auth/quickbooks). Set by /connect, deleted by
   * /callback; 10-minute TTL.
   */
  qbOAuthState: (state: string) => `oauth:quickbooks:state:${state}` as const,

  // ── To-Do Items ────────────────────────────────────────────────────

  /** Individual to-do item (JSON blob) */
  todo: (todoId: string) => `todo:${todoId}` as const,

  /** Sorted set of all to-do IDs, scored by due date (epoch ms) */
  todoList: 'todo:list' as const,

  // ── Quote Trigger (event-keyed drafting, photo-quote-training Phase 6) ─

  /**
   * Queue of message events that may warrant a quote analysis (LIST,
   * LPUSH by middleware webhook, drained by the trigger runner; capped
   * via LTRIM to 1000).
   */
  quoteTriggerQueue: 'quote-trigger:queue' as const,

  /**
   * Queue of estimate IDs whose quote email just went out (LIST, LPUSH by
   * the QB webhook on EmailSent+Pending, LPOP-drained by the message-drafts
   * runner's fast path for near-instant follow-up drafts; capped via LTRIM).
   */
  messageDraftQueue: 'message-drafts:queue' as const,

  /** Per-customer lock serializing racing triggers — 300s TTL */
  quoteTriggerLock: (phone: string) => `quote-trigger:lock:${phone}` as const,

  // ── Quote Drafter (shared state: worker + manual CLI, P2 migration) ─

  /**
   * Per-phone event buffer across ticks (HASH: phone → JSON TriggerEvent[]).
   * Events drain here from quoteTriggerQueue and sit until the debounce
   * window closes.
   */
  quoteTriggerPending: 'quote-trigger:pending' as const,

  /**
   * ZSET debounce clock: member = phone, score = epoch ms when the settle
   * window closes (newest event + 15 min; plain ZADD so new events push
   * the due time out). Drained by the worker's quote-tick cron.
   */
  quoteTriggerDue: 'quote-trigger:due' as const,

  /**
   * HASH: phone → JSON RoutedQuoteJob. The inbound router's quote decision
   * for a settled customer burst (phase 4, `inbound-router:live` includes
   * quote); the phone is also put due now, and the next quote tick drafts it
   * under its own lock instead of classifying the burst again.
   */
  quoteTriggerRouted: 'quote-trigger:routed' as const,

  /** HASH: phone → ISO of last T2 (Mike-debrief) draft — 24h dedupe. */
  quoteTriggerT2Done: 'quote-trigger:t2-done' as const,

  /** HASH: estimateId → ISO of last T4 (scope-change) action — 24h dedupe. */
  quoteTriggerT4Done: 'quote-trigger:t4-done' as const,

  /**
   * Open-quote index (HASH: phone → JSON OpenQuoteEntry). The T4 pre-check:
   * which phones/emails have a Pending estimate right now. Written by the
   * drafter at create/regenerate; maintained (adds, removals, ownership
   * refresh) by middleware's qb-reconcile cron. Advisory only — writers
   * re-verify ownership against live QBO before touching anything.
   */
  quoteDraftOpen: 'quote-draft:open' as const,

  /** ISO of the last full open-quote index rebuild from QBO (30-min gate). */
  quoteDraftOpenSyncedAt: 'quote-draft:open-synced-at' as const,

  /**
   * T4 (scope-change gate) staging flag: 'off' | 'shadow' | 'live',
   * DEFAULT SHADOW when unset. Independent of quoteDrafterMode so T4 can
   * shadow while T1-T3 drafting stays live (and vice versa). Global
   * shadow/off still wins — T4 never exceeds the drafter's own mode.
   */
  quoteDrafterT4Mode: 'quote-drafter:t4-mode' as const,

  /**
   * Scope-change flags on human-owned open quotes (LPUSH + LTRIM 200):
   * JSON {at, phone, customer, docNumber, estimateId, total, reason,
   * channel}. Rendered by the triage dashboard.
   */
  quoteScopeFlags: 'quote-drafter:scope-flags' as const,

  /** Gmail message ids already enqueued by the worker email tick (24h-pruned HASH: id → ISO). */
  quoteEmailSeen: 'quote-trigger:email-seen' as const,

  /** Serializes quote-tick runs (NX lock, TTL) — doc numbers must not race. */
  quoteDrafterRunLock: 'quote-drafter:run-lock' as const,

  /**
   * STRING JSON {reason: 'locked' | 'no-assets', since, at, ticks}: the
   * quote-tick skip streak. Written by the worker's quote-tick on a skipped
   * tick, deleted once a tick runs (no-assets: once the manifest is back).
   * The watchdog reads it (locked 15 ticks in a row, or no asset manifest).
   */
  quoteDrafterSkip: 'quote-drafter:skip' as const,

  /**
   * Kill-switch override: 'off' | 'shadow' | 'live'. Checked each run
   * before the QUOTE_DRAFTER_MODE env default — lets us flip modes
   * without a redeploy.
   */
  quoteDrafterMode: 'quote-drafter:mode' as const,

  /**
   * Asset manifest (HASH): ruleset/sectionV/exemplars → Vercel Blob URL,
   * plus updatedAt. Written by tools/src/quote-trigger/sync-assets.ts,
   * read+cached by the worker at cold start.
   */
  quoteDrafterAssets: 'quote-drafter:assets' as const,

  /** Audit trail of trigger-run outcomes (LPUSH + LTRIM 500). */
  quoteDrafterRunlog: 'quote-drafter:runlog' as const,

  // ── Message Drafts (shared state: worker + laptop backstop) ────────

  /**
   * Dedup/claim hash: estimateId → iso | skipped:* | pending:iso. An actor
   * HSETNX-claims before drafting so the worker fast lane, worker sweeps,
   * and laptop runner never double-post (launchd → server-workers P1).
   */
  messageDraftFollowupDone: 'message-drafts:followup-done' as const,

  /** Dedup/claim hash: phone → iso | skipped:* | pending:iso. */
  messageDraftIntakeDone: 'message-drafts:intake-done' as const,

  /**
   * Hash: phone → iso of the last referral / can't-help note posted mid-
   * conversation by the inbound router (one per phone per REFERRAL_REPEAT_H).
   */
  messageDraftReferralDone: 'message-drafts:referral-done' as const,

  /** Hash: phone → failed findContact attempts (Quo contact not synced yet). */
  messageDraftNoteAttempts: 'message-drafts:note-attempts' as const,

  /**
   * ZSET delay queue for first-touch intake drafts: member = phone, score =
   * epoch ms when the 10-min preemption window ends. ZADDed by the Quo
   * webhook on first inbound; drained by the worker's per-minute tick.
   */
  messageDraftIntakeDue: 'message-drafts:intake-due' as const,

  /** First activation timestamp — guards against drafting stale backlog. */
  messageDraftFirstRunAt: 'message-drafts:first-run-at' as const,

  /** Last full-sweep timestamp (laptop runner gates its 10-min sweep on it). */
  messageDraftLastSweep: 'message-drafts:last-sweep' as const,

  /** Audit trail of draft outcomes (LPUSH + LTRIM 500). */
  messageDraftRunlog: 'message-drafts:runlog' as const,

  /**
   * SyncToken of the bot's last write to a QBO estimate — the ownership
   * fingerprint. Current token ≠ stored token ⇒ human-owned forever.
   */
  quoteDraftSyncToken: (estimateId: string) => `quote-draft:sync:${estimateId}` as const,

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

  // ── Command Center ─────────────────────────────────────────────────

  /** Session for the command center (opaque cookie ID → { email, name }) — renewed on each request */
  ccSession: (sessionId: string) => `cc:session:${sessionId}` as const,

  /**
   * Saved data snapshot for one command center card (gzip+base64 JSON
   * {data, fetchedAt}), e.g. 'money:cash', 'calendar:index',
   * 'customer:1303:quo'. Pages read these instead of calling the source
   * live; each card refreshes on its own.
   */
  ccSnapshot: (name: string) => `cc:snap:${name}` as const,

  /** Short-lived OAuth state nonce → return-to path, for CSRF protection during Google sign-in */
  ccOAuthState: (state: string) => `cc:oauth-state:${state}` as const,

  /** Latest detector output for the item system: JSON {at, source, candidates[]}. */
  itemCandidates: 'cc:items:candidates' as const,

  /** HASH: item key → JSON ItemState (what Matt did: done/snooze/dismiss/pin/rank). */
  itemStates: 'cc:items:state' as const,

  /** HASH: rule id → JSON MuteRule ("this kind is noise"). */
  itemMutes: 'cc:items:mutes' as const,

  /** LIST (newest first, capped): Matt's drags and verbs with each item's rank features at that moment. Training data for the Today ranking. */
  itemRankLog: 'cc:items:rank-log' as const,

  /** ISO time a cron last ran. Written by trackCronRun (@aac/shared-utils/health); the watchdog reads the middleware jobs. */
  cronLastRun: (job: string) => `cron:${job}:last-run` as const,

  /** JSON {sent, skipped, errors} of a cron's run on a UTC day (YYYY-MM-DD). Written by trackCronRun, TTL ttl.cronResult. */
  cronResult: (job: string, date: string) => `cron:${job}:${date}:result` as const,

  /**
   * SET NX marker for a once-per-entity cron action (e.g. the reminder text
   * for one calendar event). Written by middleware's markCronAction, deleted
   * by releaseCronAction when the vendor definitively rejected the send.
   */
  cronAction: (action: string, entityId: string) => `cron:${action}:${entityId}` as const,

  /** HASH: watchdog condition id → JSON {since, alertedAt} for open conditions (dedup + recovery notices). */
  watchdogState: 'watchdog:state' as const,

  /**
   * HASH: mode-gated daily job → ISO time the watchdog first saw its mode
   * on (not off). A job switched on after today's slot isn't late until its
   * next one. Field deleted when the mode goes off.
   */
  watchdogModeOn: 'watchdog:mode-on' as const,

  // ── Google Ads offline conversions (@aac/ads-conversions) ────────────

  /** HASH: 10-digit phone → JSON AdClick {gclid, tapAt, matchedBy, ...}. First match wins; pruned after 90 days. */
  adsClicks: 'ads-conversions:clicks' as const,
  /** SET: orderIds already accepted by Google ("lead:6175551234", "quote:...", "won:..."). Never re-sent. */
  adsConversionsSent: 'ads-conversions:sent' as const,
  /** STRING: JSON summary of the last run (counts, mode, errors). Read by health checks. */
  adsConversionsLastSummary: 'ads-conversions:last-summary' as const,

  // ── Stale-quote follow-up (@aac/stale-quotes) ───────────────────────

  /** HASH: QBO estimate id → JSON EstimateState (variant, suspends, extraction cache, touches). Entries pruned once the quote leaves Pending. */
  staleQuotesState: 'stale-quotes:state' as const,
  /** STRING: JSON QueueFile from the last live run (drafts to send, waiting, flags, skipped). */
  staleQuotesQueue: 'stale-quotes:queue' as const,
  /** STRING: JSON {generatedAt, entries} of Pending quotes where the customer spoke last. Refreshed by every full scan, dry or live. */
  staleQuotesAwaiting: 'stale-quotes:awaiting' as const,
  /** LIST: JSON runlog rows (skipped / drafted), newest first. LTRIM 5000. */
  staleQuotesRunlog: 'stale-quotes:runlog' as const,
  /** 'off' | 'dry' | 'live'. Unset = off. Gates the worker's /api/stale-quotes cron. */
  staleQuotesMode: 'stale-quotes:mode' as const,
  /** STRING: JSON summary of the last completed worker run ({at, mode, counts}). The once-a-day guard and health check. */
  staleQuotesLastRun: 'stale-quotes:last-run' as const,
  /** NX lock (TTL 900s) so a slow scan and the next cron slot never overlap. */
  staleQuotesRunLock: 'stale-quotes:run-lock' as const,

  // ── Draft grader (@aac/grader) ───────────────────────────────────────

  /** HASH: draft id → JSON GradedDraft (what the bot drafted, what Matt did with it, the grade). No TTL; the runlogs it copies from are trimmed. */
  graderDrafts: 'grader:drafts' as const,
  /** HASH: draft id → JSON HandGrade ({grade, at}). Matt's own grades from the command center; override the grader's. Separate so a grader run can never overwrite one. */
  graderHand: 'grader:hand' as const,
  /** 'off' | 'dry' | 'live'. Unset = off. Gates the worker's /api/grader cron; dry grades without writing records. */
  graderMode: 'grader:mode' as const,
  /** STRING: JSON summary of the last completed worker run ({day, mode, counts}). The once-a-day guard. */
  graderLastRun: 'grader:last-run' as const,
  /** NX lock (TTL 900s) so two grader runs never overlap. */
  graderRunLock: 'grader:run-lock' as const,

  // ── Weekly scorecard (worker writes nightly, command center This week reads) ──
  /** JSON Scorecard (`@aac/metrics`): every row's weekly values, rebuilt nightly. */
  scorecard: 'scorecard:latest' as const,
  /** HASH phone (E.164) → LeadFact: first inbound contact and first reply, per phone. */
  scorecardLeads: 'scorecard:leads' as const,
  /** JSON { day, at, ...counts } of the last run. */
  scorecardLastRun: 'scorecard:last-run' as const,
  scorecardRunLock: 'scorecard:run-lock' as const,

  // ── Important dates (command center Admin owns it) ──
  /** JSON Obligation[] (`@aac/items` obligations.ts): renewals, licenses, filings, memberships, each with its next due date. */
  ccObligations: 'cc:obligations' as const,

  // ── Lead leaks (worker writes nightly, command center Sales reads) ──
  /** JSON LeadLeakSnapshot (`@aac/lead-leaks`): leads we dropped before a quote, last 90 days. */
  leadLeaks: 'lead-leaks:latest' as const,
  /** HASH phone (E.164) → JSON cached verdict, keyed by the thread's lastActivityAt (re-read when it moves). */
  leadLeakVerdicts: 'lead-leaks:verdicts' as const,
  /** HASH phone (E.164) → the thread's lastActivityAt when Matt marked it handled; it comes back once the thread moves. */
  leadLeakHandled: 'lead-leaks:handled' as const,
  /** JSON { day, at, ...counts } of the last run. */
  leadLeaksLastRun: 'lead-leaks:last-run' as const,
  leadLeaksRunLock: 'lead-leaks:run-lock' as const,

  /** HASH: person id → JSON Person (agenda topics, past conversations, tagged items, facts). No TTL. */
  ccPeople: 'cc:people' as const,

  /** HASH: referral id → JSON Referral (who we send out-of-scope work to). Seeded by tools/src/can-help/seed.ts, edited on the command center /referrals page. No TTL. */
  canHelpReferrals: 'can-help:referrals' as const,
  /** HASH: rule id → JSON StandingRule (owner policies, optionally time-bound). Seeded by tools/src/can-help/seed.ts, edited on /referrals; the one decline source for both drafters. No TTL. */
  canHelpRules: 'can-help:rules' as const,

  // ── Inbound Router (docs/plans/inbound-router.md) ──────────────────

  /**
   * ZSET settle clock: member = customer phone, score = epoch ms when the
   * burst counts as settled (last customer event + 2 min, capped at the
   * first event + 10 min). ZADDed by the Quo webhook, drained by the
   * worker's /api/inbound-tick.
   */
  inboundDue: 'inbound:due' as const,

  /** HASH: phone → epoch ms of the first customer event in the open burst (the 10-min cap). HDEL'd when the burst is read. */
  inboundFirst: 'inbound:first' as const,

  /** One saved read of a customer's conversation (JSON InboundRead). TTL ttl.inboundRead. */
  inboundRead: (phone: string) => `inbound:read:${phone}` as const,

  /** Per-phone NX lock so overlapping ticks never read the same burst twice. */
  inboundLock: (phone: string) => `inbound:lock:${phone}` as const,

  /** 'off' | 'shadow'. Unset = off (settled bursts cleared unread). */
  inboundRouterMode: 'inbound-router:mode' as const,
  /** Routes the router owns (phase 4), comma list of intake | quote | referral. Each replaces an old path. */
  inboundRouterLive: 'inbound-router:live' as const,

  /** Shadow decisions, newest first (LPUSH + LTRIM 500): what the router would do next to what the old paths had done. */
  inboundShadowLog: 'inbound:shadow' as const,

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
   * Booking → QBO acceptance sync outcome for a green calendar event
   * (`accepted:{estimateId}`, `covered:{estimateId}`, `none`, `ambiguous`).
   * Final outcomes expire after ttl.bookingSyncFinal (the sync only reads
   * events starting in the next 60 days); `none`/`ambiguous` expire after a
   * day so the event is looked at again (@aac/scheduling booking-sync).
   */
  bookingSyncEvent: (eventId: string) => `scheduling:booking-sync:${eventId}` as const,

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

  // ── Triage (@aac/triage, docs/plans/triage-to-worker.md) ────────────

  /** Cached Quo call transcript, JSON {phone, at, dialogue} (was transcripts/{callId}.json). No TTL: fetched once ever. */
  triageTranscript: (callId: string) => `triage:transcript:${callId}` as const,
  /** Cached Quo voicemail, JSON {phone, at, transcript} (was transcripts/vm-{callId}.json); transcript null = no voicemail (404). No TTL. */
  triageVoicemail: (callId: string) => `triage:voicemail:${callId}` as const,
  /** STRING: JSON array of owner-curated dismissal rules {match, sections?, reason, addedAt, until?} (was dismissals.json). */
  triageDismissals: 'triage:dismissals' as const,
  /** 'off' | 'dry' | 'live'. The worker's triage cron mode. */
  triageMode: 'triage:mode' as const,
  /** STRING: JSON summary + timing of the last worker triage run. */
  triageLastRun: 'triage:last-run' as const,
  /** NX lock so overlapping triage runs never run twice. */
  triageRunLock: 'triage:run-lock' as const,
  /**
   * STRING: JSON {verdict, at} — one cached L1 (sms) / L2 (email) Gemini
   * verdict. `hash` covers the thread's prompt (every message, call,
   * voicemail and transcript excerpt), the prompt template, model and
   * generation params, so new activity or a prompt change misses. TTL
   * ttl.triageVerdict.
   */
  triageVerdict: (channel: 'sms' | 'email', threadId: string, hash: string) =>
    `triage:verdict:${channel}:${threadId}:${hash}` as const,
} as const;

/**
 * Standard TTL values in seconds.
 */
export const ttl = {
  dedupe: 86_400,            // 24 hours
  idMapping: 604_800,        // 7 days
  loopPrevention: 60,        // 60 seconds
  contactCreateLock: 30,     // 30 seconds
  qbRefreshLock: 30,         // 30 seconds — refresh round-trip is ~1s; TTL only guards crashes
  qbOAuthState: 600,         // 10 minutes (connect → Intuit consent → callback)
  webhookCount: 172_800,     // 48 hours (keep yesterday + today)
  cronResult: 2_592_000,     // 30 days
  campaign: 7_776_000,       // 90 days
  attribution: 31_536_000,   // 1 year
  fieldSession: 31_536_000,  // 1 year (renewed on activity — effectively forever)
  fieldOAuthState: 600,      // 10 minutes (just long enough to complete the redirect)
  ccSnapshot: 2_592_000,     // 30 days; refreshed long before that when viewed
  ccSession: 2_592_000,      // 30 days (renewed on activity)
  ccOAuthState: 600,         // 10 minutes
  fieldEventCustomer: 86_400, // 24h — PD address edits propagate within a day
  fieldTravelLeg: 2_592_000, // 30d — driving patterns at the same hour-of-week don't change fast
  agentProposal: 86_400,     // 24h — Matt either responds same day or we move on
  schedulingProposalDecision: 2_592_000, // 30d — kept for command-center retro view
  inboundRead: 2_592_000,   // 30d — a later burst reuses photo reads from the earlier one
  triageVerdict: 604_800,   // 7d — bounds how long a verdict outlives calendar/estimate changes
  healthConditions: 1_209_600, // 14d of daily silent-skip counts (System health page, 7-day view)
  healthConditionRecent: 7_200, // 2h of rolling-window occurrences (watchdog reads the last hour)
  bookingSyncFinal: 31_536_000, // 1y; booking sync only reads events starting in the next 60 days
} as const;
