# @aac/api-clients — Shared API Clients

You are working in the shared API clients package. This is critical shared
infrastructure used by ALL four apps and the tools directory.

## Rules

- **No breaking changes to function signatures** without checking all consumers.
  Run `pnpm turbo build` from the repo root to verify.
- **Clients are stateful and constructor-configured.** They accept API keys,
  tokens, and credentials via their constructor. They MUST NOT read `process.env`
  directly. This makes them portable across Edge, Lambda, CLI, and test contexts.
- **`strict: true` is mandatory.** No `any` types. No `@ts-ignore`.
- **Every client must have tests.** Create a corresponding `.test.ts` file for
  every client. Mock external HTTP calls — don't hit real APIs in tests.
- **Run tests after every change:** `pnpm test`

## Client Inventory

| Client | Source File | Extracted From |
|--------|-----------|----------------|
| PipedriveClient | pipedrive.ts | aac-slim/src/clients/pipedrive.ts |
| QuoClient | quo.ts | aac-slim/src/clients/quo.ts |
| QuickBooksClient | quickbooks.ts | aac-slim/src/clients/quickbooks.ts |
| SearchBugClient | searchbug.ts | aac-slim/src/clients/searchbug.ts |
| GeminiClient | gemini.ts | aac-slim/src/clients/gemini.ts |
| GoogleCalendarClient | google-calendar.ts | aac-astro/scripts/lib/ |
| GoogleAdsClient | google-ads.ts | aac-astro/scripts/google-ads-*.js |
| GoogleAnalyticsClient | google-analytics.ts | aac-astro/scripts/ga4-report.js |
| GoogleSearchConsoleClient | google-search-console.ts | aac-astro/scripts/gsc-report.js |

## Dependencies

- `@aac/shared-utils` — For phone normalization, logging, and shared types.
