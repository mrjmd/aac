# Marketing Engine — Content Production & Campaign Management

You are working in `apps/marketing/`, the content production and campaign
management application.

## What This Is

A full content production application for a solo business owner. Two major
functions:

1. **AI Content Production:** Generate branded social content with Gemini,
   manage platform-specific variants, approval workflows, and Buffer scheduling.
2. **SMS Campaigns:** Bulk SMS via Quo/OpenPhone with PropertyRadar CSV import,
   SearchBug phone scrubbing, DNC compliance, A/B testing, and throttled sending.

## Rules

- **Import API clients from `@aac/api-clients`.** Gemini, Buffer, SearchBug,
  Quo — all API interaction goes through shared clients.
- **Import utilities from `@aac/shared-utils`.** Phone normalization, Redis keys,
  logger, shared types.
- **Campaign results go to Redis.** Write stats (sent, failed, opt-outs) to the
  shared Redis using keys from `@aac/shared-utils/redis` so the Command Center
  can display them.
- **This app may use its own data store** (SQLite/Prisma) for content production
  workflows (ideas, posts, variants, approval state). This is separate from the
  shared Redis used for inter-system communication.

## What Does NOT Belong Here

- Webhook handling for CRM sync (→ `apps/middleware/`)
- Public website content (→ `apps/storefront/`)
- Analytics dashboards (→ `apps/command-center/`)
- One-off reporting scripts (→ `tools/`)

## Reference

- Gate docs and specs: `../../aac-marketing-engine/specs/` (archived repo)
- See `../../packages/api-clients/` for shared API clients.
- See `../../docs/meta-architecture.md` for the full system architecture.
