# Worker — Out-of-Band Draft Execution

You are working in `apps/worker/`, the cloud execution layer for
time-sensitive automations that must not run inside webhook ack paths and
must not depend on Matt's laptop (launchd → server-workers migration,
docs/plans/launchd-to-server-workers.md).

## What This Is

Plain Vercel Serverless Functions (no framework) that run the
`@aac/message-drafts` and `@aac/quote-drafter` pipelines:

- `api/tick.ts` — per-minute cron: drains the webhook-fed fast queues
  (emailed-estimate LIST + intake-due ZSET).
- `api/sweep.ts` — 10-minute cron: full backstop sweep.
- `api/draft-followup.ts` — fast lane, POSTed by middleware's qb-webhook
  the moment a quote email goes out (`x-worker-secret`).
- `api/quote-tick.ts` — per-minute cron: quote-trigger debounce →
  classify (T1/T2/T3) → drafter (Pending QBO estimate + 🤖 Quo note).
  Gated by `QUOTE_DRAFTER_MODE` env / `quote-drafter:mode` Redis override
  (off | shadow | live). maxDuration 800 / memory 1024 — drafts are slow
  (Gemini with photos) and the exemplar library is large.
- `api/quote-draft.ts` — manual one-phone draft/dry-run (escape hatch +
  validation probe).
- `api/quote-email-tick.ts` — 15-min cron: T4 email channel. Matches
  recent inbound Gmail against the open-quote index and enqueues
  synthetic trigger events. Degrades to a logged skip without
  gmail.readonly on the Google token.
- `api/watchdog.ts` — 5-min cron: outside-in pipe checks (`@aac/watchdog`).
  Texts Matt from the agent line only when a pipe is down (Quo webhook,
  middleware and worker crons, the agent's error-surface, worker
  heartbeats, quote-drafter lock/assets, middleware health), every 6h
  while it lasts, and once on recovery. When the Quo send throws, the alert
  goes by Gmail instead (`lib/watchdog-deps.ts`, the worker's Google token,
  needs gmail.send, compose or modify) to `WATCHDOG_ALERT_EMAIL` or the
  token's own mailbox. Env: `MATT_PERSONAL_PHONE_NUMBER` (required),
  `QUO_AGENT_PHONE_NUMBER`, `MIDDLEWARE_HEALTH_URL`, `WATCHDOG_ALERT_EMAIL`.
- `api/ads-conversions.ts` — daily cron (11:00 UTC): Google Ads offline
  conversions (`@aac/ads-conversions`). Matches ad taps to new callers and
  uploads Real lead / Quote sent / Won job. Gated by `ADS_CONVERSIONS_MODE`
  (off | dry | live, default off); needs `GOOGLE_ADS_CLIENT_ID`,
  `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` (adwords +
  datamanager + analytics.readonly; mint with tools/src/ads-conversions/reauth.ts), `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`,
  `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GA4_PROPERTY_ID`. `?days=N` (≤90) backfills.
- `api/inbound-tick.ts` — per-minute cron: inbound router
  (`@aac/inbound-router`, docs/plans/inbound-router.md). Off by default: clears
  settled bursts (`inbound:due`, armed by the Quo webhook) unread. Redis
  `inbound-router:mode` = `shadow` reads each one once and logs the routes it
  would take to `inbound:shadow`. Routes in Redis `inbound-router:live` run
  their drafters; with `intake` live, `/api/tick` clears the old intake queue
  and `/api/sweep` re-arms the router instead of sweeping intake; with `quote`
  live, `/api/quote-tick` drops the customer's texts, photos and voicemails
  and drafts the router's routed jobs instead (Matt's texts, emails, call
  transcripts and debriefs still trigger as before).
- `api/stale-quotes.ts` — daily stale-quote follow-up (`@aac/stale-quotes`),
  cron every 20 min through the 12:00 UTC hour: the first slot scans every
  Pending quote and drafts due follow-ups as `📋 STALE-QUOTE FOLLOW-UP` Quo
  notes (never sends); later slots finish a scan its 600s budget cut short,
  then skip until tomorrow. Gated by Redis `stale-quotes:mode`
  (off | dry | live, unset = off); dry refreshes only the awaiting-reply
  list. Needs the Google env (calendar + Gmail are hard gates).
- `api/triage.ts`: daily triage (`@aac/triage`, docs/plans/triage-to-worker.md),
  cron 13:05 UTC, after the stale-quote slots so it reads that morning's
  queue. collect → analyze → triageCandidates with no bot-draft labels (plan
  decision 1); `live` publishes to `keys.itemCandidates` as source
  `triage-worker`, `dry` records counts only (`triage:last-run`). Gated by
  Redis `triage:mode` (off | dry | live, unset = off); once per Eastern day
  per mode, `?force=1` (middleware secret) runs again. analyze can't resume,
  so one slot and a 720s deadline: past it the run is dropped unpublished and
  recorded as a health error. NX lock `triage:run-lock` with an owner-checked
  release. A run that finishes blind (LLM errors, email sweep or Gemini
  canary failed) is recorded too. Needs the Redis, QBO, Quo, Gemini and
  Google env (`skipped: 'no-<group>-env'` otherwise); maxDuration 800 /
  memory 1024.
- `api/health.ts`: for an outside uptime pinger: 200 `{status: 'ok'}`
  only while Redis answers and `health:watchdog:ts` is under 15 min old,
  else 503 `{status: 'down'}`. Unauthenticated, no details. The one alert
  path that shares no fate with Vercel crons, Upstash or Quo.

## Health bookkeeping

`lib/health.ts` (over `@aac/shared-utils/health`, never throws):

- **Failures** go to `health:errors` as source `worker:<route>` (shown on the
  command center health page, texted by the agent's error-surface cron):
  every route's top-level 500, deps that fail to build (`guarded()` wraps
  routes with work before their try), and package failures swallowed into a
  result (inbound-tick `failed` bursts, quote-tick/quote-draft `failed`
  drafts and a missing asset manifest, ads-conversions `summary.failed`,
  a triage run that finished blind).
  One entry per source per 10 min (`keys.healthErrorThrottle`) so a
  per-minute failure can't flood the 100-entry list; the log gets them all.
- **Stamps mean work happened** (the watchdog reads every one):
  sweep, inbound-tick, quote-email-tick, stale-quotes and triage stamp
  `cron:<route>:last-run` (+ daily result) only after a run that did its
  work (not on a skip, a 500, or an inbound tick whose every read failed);
  ads-conversions stamps in its package (not on a skip or a wholly rejected
  upload). tick writes `health:worker:ts`; quote-tick writes
  `health:quote-drafter:ts` only when the tick ran (not off, locked or
  no-assets), and keeps its skip streak in `quote-drafter:skip`
  (`lib/quote-skip.ts`) for the watchdog's "locked 15 ticks" and
  "no asset manifest" conditions.

## Rules

- **All business logic lives in `packages/`** (`@aac/message-drafts`).
  Endpoints here are thin: auth → deps → one package call → JSON.
- **Never import from `apps/middleware`.** Shared logic moves to packages
  first.
- **Every endpoint re-validates.** Callers can double-fire (middleware
  push + tick + sweep + laptop backstop); Redis claims in the package make
  that safe. Don't add logic that assumes exactly-once delivery.
- **Auth fails closed.** `CRON_SECRET` (Vercel cron) and
  `WORKER_SHARED_SECRET` (middleware) must be set; endpoints 401 without
  them.
- **This app never texts customers.** The deliverable is a 🤖 draft note
  on the Quo contact. The one text it sends is the watchdog's, to Matt.

## Deploy

Git only: push to `main` deploys prod, a branch push gives a preview URL.
Never `vercel deploy` (see the root CLAUDE.md Deploy Convention).

Vercel project settings: `rootDirectory = apps/worker`,
`sourceFilesOutsideRootDirectory = true`, deployment protection OFF
(middleware calls these endpoints server-to-server).
