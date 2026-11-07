# @aac/scheduling — Scheduling Pipeline

You are working in the scheduling-algorithm package. This is the canonical
home for the SchedulingDirective pipeline: directive normalization,
slot-suggestion, calendar-event creation, Pipedrive deal updates, and
callback child-deal logic.

## What This Is

Apps own *triggers* (webhooks, crons, classifiers); this package owns the
*algorithm*. Triggers normalize into a `SchedulingDirective` and call into
the pipeline; the pipeline does the scheduling work and emits results
(event ID, PD deal updates, propose-dialogue messages).

## Entry points that call this package

- `apps/middleware/api/webhooks/quo` (via `lib/quo-webhook/scheduling.ts`) — `dispatchSchedulingIntent` on every customer text / transcript
- `apps/middleware/api/scheduling/send-proposal` — `buildProposalForDirective`
- `apps/middleware/lib/suggestion-note.ts` (QB webhook, reconcile cron, Quo dispatch) — `postSuggestionNoteForDirective`
- `apps/middleware/api/qb-webhook` — when a QB Estimate Update event arrives (TxnStatus → Accepted)
- `apps/middleware/api/cron/qb-reconcile` — daily backstop in case QB drops a webhook
- (future) `apps/website` — instant-quote-from-photos UI
- (future) `apps/partner-app` — realtor / inspector entry surface

## Dispatch layer (moved from apps/middleware)

- `dispatch.ts` — `dispatchSchedulingIntent`: classify a Quo text or
  transcript, normalize to directives, write the shadow queue, create
  STUB / HOLD events (create first, enrich after), post the suggestion note.
  Stubs and holds are for visits to a customer's property only: the
  site-visit guard (`findSiteVisitEvidence`) sends a manual_schedule for a
  contact with no PD address, no inbound text, no QB estimate and no QB
  invoice to pending-review (score capped at
  `NO_SITE_VISIT_EVIDENCE_SCORE_CAP`). Lookup failures fail open. Fixture:
  `__tests__/fixtures/paul-sullivan-2026-11-06.json` (radio ad rep's phone
  call that became an assessment stub).
- `proposal-builder.ts` — `buildProposalForDirective` plus the shared
  `fetchCustomer` / `fetchBusyEvents` / `buildTravelDeps` helpers.
- `suggestion-note.ts` — `postSuggestionNoteForDirective` (suggestSlot +
  HOLD + Quo contact note, at-most-once per QB estimate).
- `store.ts` — `SchedulingStore`: every Redis read/write these need is
  injected as `deps.store`. The middleware wires it in
  `apps/middleware/lib/scheduling-store.ts`. Never import a Redis client or
  hardcode a key here.
- `constants.ts` — `SCHEDULING_AUTO_PROPOSE_THRESHOLD`, also exported on the
  `@aac/scheduling/constants` subpath so the middleware's `lib/redis.ts`
  (imported by every function) can read it without loading the pipeline.
- Logger module names (`scheduling-dispatch`, `proposal-builder`,
  `suggestion-note`) and health-error sources predate the move; keep them,
  dashboards and the error-surface agent key on them.

## Rules

- **Pure logic.** No `process.env`. No webhook reception. No authentication.
  Triggers pass in typed directives + dependencies.
- **Deps injected.** Clients come from `@aac/api-clients`; the package
  doesn't construct them. Receive PD, QB, Quo, Calendar clients via a
  bundle similar to `@aac/agent-tools` `ToolDeps`.
- **Strict TypeScript.** No `any`. No `@ts-ignore`.
- **Idempotent.** A directive that's already been scheduled should be a
  no-op when reprocessed (dedup at the pipeline layer, not the trigger
  layer — so backstop crons can safely repeat).
- **Vitest with mocked deps.** Don't hit real APIs in tests.

## What does NOT belong here

- Webhook handlers (apps/middleware)
- Intent classification (apps/middleware — extends the existing Gemini classifier)
- Quoting / estimate creation (that's `@aac/quoting`)
- Conversation runtime / propose-dialogue UI (apps/agent)

## Dependencies

- `@aac/api-clients` — PD, QB, Quo, Google Calendar clients + types
- `@aac/shared-utils` — Phone normalization, logger, Redis key builders
