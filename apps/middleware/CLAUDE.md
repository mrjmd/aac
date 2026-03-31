# Middleware — The Operations Brain [SACROSANCT]

You are working in `apps/middleware/`, the sacrosanct operations brain of the AAC system.

## What This Is

Real-time webhook-driven middleware connecting Pipedrive (CRM), Quo/OpenPhone
(telephony), QuickBooks (accounting), and Google Ads (lead capture). It reacts
to events instantly: syncing contacts, logging activities, extracting entities,
drafting quotes, creating calendar placeholders.

## Rules — Read These Carefully

- **SACROSANCT.** This is the most critical production system. Every change must
  be minimal, deliberate, and unit tested.
- **No UI code.** This is an API-only system. No React components, no pages,
  no frontend assets.
- **No bulk processing.** Campaign sending, batch operations, and marketing
  logic belong in `apps/marketing/`, not here.
- **Import API clients from `@aac/api-clients`.** Never implement direct API
  calls to Pipedrive, Quo, QBO, etc. in this directory.
- **Import utilities from `@aac/shared-utils`.** Phone normalization, Redis keys,
  logger — all come from the shared package.
- **Every webhook handler must be idempotent.** Use Redis deduplication from
  `@aac/shared-utils` for every incoming event.
- **Fail safe.** Always return 200 to webhook senders to prevent retries that
  could cause duplicate processing. Log errors, don't throw them.

## What Does NOT Belong Here

- SMS campaign management (→ `apps/marketing/`)
- Social media posting (→ `apps/marketing/` or `tools/`)
- Analytics dashboards (→ `apps/command-center/`)
- SEO content (→ `apps/storefront/`)
- Operational scripts (→ `tools/`)

## Framework

Plain Vercel Serverless Functions — no framework. Each webhook handler is a
standalone TypeScript file in `api/` deployed as an independent Lambda.
No Next.js, no React, no framework overhead.

## Related

- Source middleware: `../../aac-slim/` (standalone repo, production)
- See `../../packages/api-clients/` for shared API clients.
- See `../../docs/meta-architecture.md` for the full system architecture.
