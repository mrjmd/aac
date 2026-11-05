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
  middleware crons, worker heartbeats, middleware health), every 6h while
  it lasts, and once on recovery. Env: `MATT_PERSONAL_PHONE_NUMBER`
  (required), `QUO_AGENT_PHONE_NUMBER`, `MIDDLEWARE_HEALTH_URL`.
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
  would take to `inbound:shadow`. Posts nothing.
- `api/health.ts` — liveness.

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
