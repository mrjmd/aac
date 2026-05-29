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

- `apps/middleware/api/quo-webhook` — when intent extraction detects a scheduling intent in a customer message or Matt's outbound text
- `apps/middleware/api/qb-webhook` — when a QB Estimate Update event arrives (TxnStatus → Accepted)
- `apps/middleware/api/cron/qb-reconcile` — daily backstop in case QB drops a webhook
- (future) `apps/website` — instant-quote-from-photos UI
- (future) `apps/partner-app` — realtor / inspector entry surface

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
