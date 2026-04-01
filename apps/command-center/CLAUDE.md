# Command Center — Analytics & Observability Dashboard

You are working in `apps/command-center/`, the business owner's home base.

## What This Is

A read-only dashboard that aggregates the state of all other pillars.
Shows system health, webhook audit trails, campaign stats, and provides
"Approve" buttons for automated drafts.

## Rules

- **Read-only by default.** This app does NOT write to external systems except
  for explicit "Approve" actions (e.g., approving a quote triggers a QBO workflow).
- **No data of its own.** The Command Center aggregates state from Redis
  (heartbeats, webhook audit, campaign stats) and Pipedrive (deals, renewals).
  It does not maintain its own database.
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
