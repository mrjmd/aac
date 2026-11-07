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
row, shown under "How each row is counted"). Volume rows (contacts, quotes,
\$ quoted, jobs, payments in) are judged per week against `targets`: the average-week goal
times `SEASONAL_INDEX` for that month (funnel study §6, re-fit each January,
payments in half a month late); rates and speeds stay flat. The page never fetches the
sources. Cells are for reading trends and never become items.

This week also pins items to the day they come due (`week/due-items.tsx`,
from the items view): `dueOn` (the start of the event an item is about:
stubs D10, holds D13, incomplete events D11) or `dueAt` (a promised time).
Day columns show them as flags that open the drawer; "Get ahead of" lists
the ones from today through Saturday that aren't on Today, with → Today.

## This month (`/month`)

The approved mockup's This month, with the charter's goals seasonal: the
\$50k floor and \$80k target are Mar-May 2027 averages, so each month's
goal is its share of the year (the scorecard's invoiced `SEASONAL_INDEX`),
and the chart's goal lines roll 3 months like the revenue line, landing on
\$50k and \$80k in May 2027. Tiles: pace for Mar-May (last 3 closed months,
season removed), rolling 3-month revenue against its seasonal floor, last
12 months, the month so far,
the revenue chart (Jun 2025 to May 2027, bars + last year + the rolling
line, the Mar-May 2027 decision window) and the tech #2 gates (vaults from
the Relay registers in the cash card, the winter 1.5x multiplier on closed
months, weeks booked ahead from the scorecard's `booked` row). Math lives in
`@aac/metrics` `month.ts` (`buildMonthlyRevenue`, `buildTech2Gates`);
revenue is QBO invoice totals by invoice date, from the saved card
`month:invoices` (warm cron, never fetched on load). Take-home, margin and
owner hours wait on the books and Matt's decisions.

## Important dates (`/admin#dates`)

The obligations registry's first screen: insurance, licenses, filings,
taxes, memberships and renewals, one JSON list in `cc:obligations`
(`Obligation` in `@aac/items` obligations.ts; seeded 11/07 from Gmail and
QBO by a one-off script). Within `leadDays` of its date an entry becomes a
`DATE` item (`fromObligation`, key `ob:{id}:{due}`, `dueOn` = the date), so
it pins to its day on This week and turns red on Today when due. Done rolls
a repeating date forward (`markObligationDone`) and closes a one-off;
`POST /api/obligations` {op: done | set} is the only write. Dates with no
due date are listed under "Needs a date" and never become items.

## Rules (`/rules`)

The mockup's Rules page. Three switches for what the ranking may put on
Today by itself (`PROMOTION_RULES` in `@aac/items`, saved by
`POST /api/items/promotion`, read in `loadItemsView`): deadlines within
36h, an Important date 7 days out, anything else scoring 300+. Then every
mute rule with Unmute (`DELETE /api/items/mutes`), the dismissed list
(`DismissedList`, shared with Today's fold), and "what your dismissals are
teaching": the same reason used twice or more on one kind of item in 30
days (`dismissalPatterns`).

## This looks wrong (every card)

`components/looks-wrong.tsx`, mounted once in the layout: hover or tap any
`.card` or `.tile` in main and a "Looks wrong?" button sits on its top
border; it saves the card's heading, its text as shown, the page and
Matt's note to `cc:card-flags` (`lib/card-flags.ts`,
`POST /api/card-flags` {op: add | fix}). Nothing notifies anyone. System
lists them ("You flagged", open first). **Claude: run
`tools/src/command-center/card-flags.ts` at the start of every session and
fix open flags first**, then `card-flags.ts fix <id> "<what changed>"`.

## Lead leaks (`/sales`)

Sales shows the lead-leak queue: leads we dropped before a quote in the last
90 days, by stage (asked and never answered, sent photos or details and no
quote, assessed and never quoted), each with a \$ value. It reads
`lead-leaks:latest`, which the worker's nightly `/api/lead-leaks` builds
with `runLeadLeaks` in `@aac/lead-leaks`; value rules live there
(`leakValue`). Handled (`POST /api/lead-leaks` {phone, lastActivityAt | null})
writes `lead-leaks:handled` and hides the row until the thread moves. The
page never fetches the sources.

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
