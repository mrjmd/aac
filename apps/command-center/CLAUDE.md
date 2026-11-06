# Command Center — Analytics & Observability Dashboard

You are working in `apps/command-center/`, the business owner's home base.

## What This Is

A read-only dashboard that aggregates the state of all other pillars.
Shows system health, webhook audit trails, campaign stats, and provides
"Approve" buttons for automated drafts.

## Rules

- **Read-only by default.** This app does NOT write to external systems except
  for explicit "Approve" actions (e.g., approving a quote triggers a QBO workflow).
- **Owns item state (v2 plan).** Beyond aggregating Redis and the source
  systems, the command center now owns its own items, sessions, and (planned)
  the obligations registry and documents. See `docs/plans/command-center/`.
- **Auth:** Google sign-in via `GoogleSignInClient`, email allowlist
  `CC_ALLOWED_EMAILS`, Redis-backed sessions (`lib/session.ts`). The middleware
  does a real session lookup on every request, and every `app/api/**` route
  re-checks it with `requireApiSession` (`lib/api-auth.ts`) so a middleware
  bypass can't reach the data; `__tests__/api-auth.test.ts` fails on any new
  route that skips it. Env: `CC_GOOGLE_OAUTH_CLIENT_ID`,
  `CC_GOOGLE_OAUTH_CLIENT_SECRET`, `CC_ALLOWED_EMAILS`, Upstash vars.
- **Import API clients from `@aac/api-clients`** for Pipedrive reads and
  approval actions.
- **Import key schema from `@aac/shared-utils/redis`** to read the same keys
  that other apps write.

## System health (`/health`)

Server-rendered from Redis only (`lib/system-health.ts`): `watchdog:state`
open conditions, heartbeats and `cron:*:last-run` per app (`SIGNALS`),
today's `cron:*:result`, today's and 7-day `health:conditions:*` silent-skip
counts, jobs not invoiced (`invoice-create.*` entities), the head of
`health:errors`, and the middleware card (webhook counts, errors; it no
longer calls the middleware's `/api/health`). CI on main is a saved card
(`cards.ci`, `system:ci`, GitHub via `GitHubClient`, refreshed by the warm
cron or the card's ↻, never on page load); env `GITHUB_TOKEN` (Actions
read-only on mrjmd/aac), without it the card says so.

Nothing here texts or emails. Jobs not invoiced and a red CI float to Today
(`loadCandidates` → `loadSystemCandidates`) only when ongoing, per the
constants in `lib/system-rules.ts`: 3+ distinct jobs skipped in 7 days;
main red 2+ settled runs in a row or for 24h.

## Automations (`/health/automations`)

System's second tab (Health | Automations, approved mockup
UpDmcyToXtJ5wK6Hm2bTUS). Server-rendered from Redis only
(`lib/automations.ts`): the grader's records `grader:drafts` (written daily
by the worker, `@aac/grader`) and Matt's hand grades `grader:hand`, which
override the grader's; `summarize` in `@aac/grader` does the bar math
(Wilson lower bound, raw, hurt in the last 50, per kind of case). One card
per automation, a drill-in per `?a=<id>`: weekly chart, the bar, the kinds
table (display text for each kind lives in `AUTOMATIONS`), and recent
drafts with a word diff (`lib/word-diff.ts`) and the hand-grade buttons
(`POST /api/automations/grade` {id, grade | null}, the only write). The
auto-send toggles stay disabled until graduation is built.

## Scorecard (`/week`)

This week's 13-week scorecard (mockup's This week) reads `scorecard:latest`,
which the worker's nightly `/api/scorecard` builds with `runScorecard` in
`@aac/metrics` (row definitions, goals and date bases live there, one per
row, shown under "How each row is counted"). The page never fetches the
sources. Cells are for reading trends and never become items.

## Day-One Features (Phase 1)

1. **Middleware Heartbeat Monitor** — Green/red status based on Redis timestamp.
2. **Webhook Audit Trail** — Last 50 incoming webhooks from the Redis stream.
3. **Campaign Pulse** — Summary stats from Marketing Engine's Redis writes.
4. **Business Renewals** — Upcoming ASHI, insurance, domain expirations from Pipedrive.

## What Does NOT Belong Here

- Webhook handling (→ `apps/middleware/`)
- Content management (→ `apps/website/` or `apps/marketing/`)
- Campaign sending (→ `apps/marketing/`)
- Operational scripts (→ `tools/`)

## Framework

Next.js 15 App Router, deployed on Vercel.

## Related

- See `../../packages/api-clients/` for shared API clients.
- See `../../packages/shared-utils/src/redis.ts` for the Redis key schema.
- See `../../docs/meta-architecture.md` for the full system architecture.
