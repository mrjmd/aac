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
  does a real session lookup on every request. Env: `CC_GOOGLE_OAUTH_CLIENT_ID`,
  `CC_GOOGLE_OAUTH_CLIENT_SECRET`, `CC_ALLOWED_EMAILS`, Upstash vars.
- **Import API clients from `@aac/api-clients`** for Pipedrive reads and
  approval actions.
- **Import key schema from `@aac/shared-utils/redis`** to read the same keys
  that other apps write.

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
