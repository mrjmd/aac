# Website — The Public-Facing Website

You are working in `apps/website/`, the public-facing website for Attack A Crack.

## What This Is

An Astro 5 static site with 320+ content pieces (blog posts, location pages,
service pages, project case studies). Lead capture, SEO, local authority building.
Deployed on Vercel with CI/CD quality gates.

## Rules

- **SEO validation is non-negotiable.** Every page must have proper title tags
  (30-60 chars), meta descriptions (120-160 chars), heading hierarchy, and
  structured data (JSON-LD).
- **Import API clients from `@aac/api-clients`** for any external API calls
  (GCal cron, lead submission to Pipedrive).
- **Build-time validation scripts stay here.** SEO checks, a11y audits, link
  validation, image checks — these are part of the build pipeline.
- **Operational scripts do NOT belong here.** GA4 reports, Google Ads management,
  Buffer posting — those go in `tools/`.
- **Phone number rules:**
  - Non-state-specific pages: BOTH numbers (CT: 860-573-8760, MA: 617-668-1677)
  - State-specific pages: Only that state's number
  - All numbers must be clickable (`tel:` or `sms:` links)

## What Does NOT Belong Here

- Operational/cron scripts (→ `tools/`)
- Webhook handlers (→ `apps/middleware/`)
- Campaign management (→ `apps/marketing/`)
- Analytics dashboards (→ `apps/command-center/`)

## Framework

Astro 5 with Tailwind CSS v4, deployed on Vercel.

## Related

- Source website: `../../aac-astro/` (standalone repo, production)
- See `../../packages/api-clients/` for shared API clients.
- See `../../docs/meta-architecture.md` for the full system architecture.
