# Tools — Operational Scripts

You are working in the `tools/` directory of the AAC monorepo.

## What This Is

Thin wrapper scripts for operational tasks: GA4 reporting, Google Ads management,
GSC analysis, Buffer batch posting, image optimization. Each script configures
an API client from `@aac/api-clients` and calls its methods.

## Rules

- **Scripts must be thin.** If you're writing more than 20 lines of business logic,
  that logic belongs in `@aac/api-clients` or `@aac/shared-utils`, not here.
- **Import API clients from `@aac/api-clients`.** Never write direct `fetch()` calls
  to external APIs (Pipedrive, Quo, Google, etc.) in this directory.
- **Import utilities from `@aac/shared-utils`.** Phone normalization, Redis keys,
  logger — all come from the shared package.
- **Each script is standalone.** No script should import from another script.
  Shared logic goes in packages.

## What Does NOT Belong Here

- Web servers or API endpoints (those go in `apps/`)
- Build-time validation scripts (those stay in `apps/website`)
- Campaign business logic (that goes in `apps/marketing`)
- UI code of any kind

## Related

- See `../packages/api-clients/` for the shared API clients these scripts use.
- See `../docs/meta-architecture.md` for the full system architecture.
- See `../apps/` for the four application pillars.
