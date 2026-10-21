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
  on the Quo contact.

## Deploy

```bash
pnpm --filter @aac/worker run deploy          # prod
pnpm --filter @aac/worker run deploy:preview  # preview
```

Vercel project settings: `rootDirectory = apps/worker`,
`sourceFilesOutsideRootDirectory = true`, deployment protection OFF
(middleware calls these endpoints server-to-server).
