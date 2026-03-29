# Meta-Architecture: The Four-Pillar Monorepo

This document serves as the master specification and "Structural Prompt" for the AAC Business Automation System. It defines the boundaries, communication protocols, and safety guardrails for AI-assisted (Vibe Coding) development.

## 1. Directory Structure (The Monorepo)

We use **Turborepo with pnpm workspaces** for strict dependency isolation. The directory structure itself is a prompt: it dictates where logic belongs to prevent AI "smushing."

```
/
├── apps/
│   ├── middleware/        # Pillar 1: Operations Brain (Next.js 14 - aac-slim) [SACROSANCT]
│   ├── storefront/        # Pillar 2: Astro Site (Astro 5 - aac-astro)
│   ├── marketing/         # Pillar 3: Marketing Engine (Content Production App)
│   └── command-center/    # Pillar 4: Analytics/BI (Next.js 15 App Router)
├── packages/
│   ├── api-clients/       # Shared logic: @aac/api-clients
│   ├── shared-utils/      # Shared logic: @aac/shared-utils (types, phone, redis)
│   └── tsconfig/          # Shared TypeScript configurations
├── tools/                 # Operational/Cron scripts (pnpm workspace member)
├── turbo.json             # Pipeline orchestration
├── CLAUDE.md              # Root Governance & Identity
└── package.json           # Workspace root
```

## 2. The Package Contracts (The "Teeth")

### @aac/api-clients

This package exports **Stateful Clients**. They **MUST NOT** read `process.env` directly; they accept configuration via constructors. This allows them to be used in any context (Edge, Lambda, CLI).

- **Pipedrive:** Lead/Deal CRUD and activity logging.
- **Quo (OpenPhone):** SMS sending and internal note creation.
- **QuickBooks:** Estimate drafting and customer syncing.
- **SearchBug:** Phone scrubbing and DNC validation.
- **Gemini:** Image analysis and intent extraction.

**Google Clients** (separate files within api-clients, not one mega-client):

- **Google Calendar:** OAuth-based event management.
- **Google Ads:** Conversion uploads (Developer Token + MCC).
- **Google Analytics:** Data API (Service Account) for reporting.

### @aac/shared-utils

- **Phone:** The single source of truth for normalization (Vitest protected).
- **Redis:** Key schema builders (e.g., `keys.heartbeat(app)`) and deduplication logic.
- **Logger:** Standardized JSON logging for the Command Center to ingest.

## 3. Communication & Redis Topology

### Data Layer Notes

- **Middleware, Command Center, Tools:** All use the shared Upstash Redis for state, caching, and inter-system communication.
- **Storefront:** Stateless. Fetches data at build time or via Vercel Cron. No persistent data layer of its own.
- **Marketing Engine:** May use its own local data store (SQLite/Prisma) for content production workflows (ideas, posts, variants, approval state). Campaign results and stats are written to the shared Redis so the Command Center can display them. The Marketing Engine's data architecture is open for revisiting during Phase 4 if there's a good reason to align more closely with the Redis-based approach used elsewhere.

### The Redis Rule

- **Schema:** Defined globally in `@aac/shared-utils/redis`.
- **Connection:** Each App/Tool initializes its own connection to a **shared Upstash database**. This allows the Command Center to see Middleware heartbeats and Webhook audits without direct code coupling.

### Communication Matrix

| Source | Target | Lane | Data/Intent |
|--------|--------|------|-------------|
| Quo | Middleware | Webhook | Real-time lead intake |
| Middleware | Redis | Ephemeral | `health:middleware:ts` (Heartbeat every 5 min) |
| Middleware | Redis | Stream | `logs:webhooks` (Audit Trail for Dashboard) |
| Marketing | Redis | Ephemeral | Campaign stats (sent, failed, opt-outs) |
| Marketing | Buffer | API | Social content scheduling and publishing |
| Storefront | Google Calendar | API (Cron) | Fetch project photos for "Latest Work" section |
| Storefront | Middleware | Internal API | Form submission → Pipedrive lead creation |
| Command Center | Redis | Read | Heartbeat monitor, webhook audit, campaign pulse |
| Command Center | Pipedrive | API | Manual "Approve Quote" → Trigger Workflow |
| Command Center | Pipedrive | Read | Business meta-data (ASHI renewals, domain expirations) |
| Tools/Crons | Buffer | API | Publishing project photos to GMB/Social |

### Key Data Flows

**Health & Observability:** Middleware pings `health:middleware:ts` every 5 minutes. Command Center reads this key — if timestamp > 6 minutes old, it shows a "Middleware Down" alert. Middleware also logs every incoming Quo/Pipedrive webhook to a `logs:webhooks` Redis stream; Command Center surfaces the last 50 events to verify "life."

**Marketing Intelligence:** Marketing Engine writes batch campaign results (sent, failed, opt-outs) to Redis. Command Center pulls these stats to show a "Campaign Pulse" card.

**Business Meta-Data:** Important renewal dates (ASHI, insurance, domains) are stored as deal dates in a "Business Admin" board in Pipedrive. Command Center alerts 30 days before expiration.

**Content Sync:** A Vercel Cron job in `apps/storefront` uses `@aac/api-clients` Google Calendar client to fetch project photos from the last 7 days and updates the site's "Latest Work" section.

## 4. Governance & Guardrails

### Guardrail 1: Local CLAUDE.md Files

Every directory has its own `CLAUDE.md` to scope-lock the AI:

- **`apps/middleware`:** "You are in the sacrosanct operations brain. Minimal changes only. Every change must be unit tested. No UI code allowed."
- **`packages/api-clients`:** "No breaking changes to function signatures. If you change a client, you must run builds for all four apps to check for regressions."

### Guardrail 2: Enforcement (ESLint & CI)

- **Import Restrictions:** ESLint blocks `fetch()` or `axios` calls to Pipedrive/Quo domains from within `apps/`. You MUST use the shared client.
- **Type Safety:** `strict: true` is mandatory. A change in a package that breaks an app consumer will block the Vercel deployment.

## 5. Script Categorization (The "Tools" Rule)

- **Build-time?** (e.g., sitemap generation) → Stay inside `apps/storefront`.
- **On-Demand/Cron?** (e.g., GA4 reports, Ads management, Buffer posting) → Move to `tools/`.
- **Logic inside Tools:** Tools should be "thin." All actual API interaction logic must be extracted to `@aac/api-clients` so the Middleware or Command Center could theoretically trigger the same logic later.
- **Workspace membership:** `tools/` has its own `package.json` and is listed in the pnpm workspace config (`pnpm-workspace.yaml`), allowing it to import from `@aac/api-clients` and `@aac/shared-utils` like any other workspace member.

## 6. Migration Strategy: Safety-First Phases

### Phase 0: Extract Shared Packages (No production risk)

1. **Scaffold the monorepo** in this directory (`aac`). Set up pnpm workspaces, Turborepo, tsconfig base.
2. **Extract `@aac/shared-utils`** from aac-slim: `phone.ts` (consolidate the 4 duplicate versions into one canonical implementation), Redis key schema, logger, shared TypeScript interfaces.
3. **Extract `@aac/api-clients`** from aac-slim: Pipedrive, Quo, QuickBooks, SearchBug, Gemini clients. Make them framework-agnostic (no Next.js imports) and constructor-configured (no `process.env`).
4. **Write Vitest suites** for both packages that mirror and expand on existing tests in aac-slim.
5. **Verify locally:** Import the extracted packages from a test script and confirm they work against sandbox API environments.

At this point, the existing aac-slim and aac-astro repos are **completely untouched**. No production risk.

### Phase 1: Build the Command Center (First consumer)

1. **Create `apps/command-center`** as a new Next.js 15 App Router application.
2. Build it as the first real consumer of `@aac/api-clients` and `@aac/shared-utils`.
3. Start with: Middleware heartbeat monitor, webhook audit trail, campaign stats display.
4. Deploy as a new Vercel project (`aac-command-center`). It reads from the shared Upstash Redis — no writes to production systems except "Approve" actions.

This validates that the shared packages actually work in a real app without touching production.

### Phase 2: Shadow Middleware (Parallel universe)

1. **Copy aac-slim** into `apps/middleware`. Refactor it to import from `@aac/api-clients` and `@aac/shared-utils` instead of its local copies.
2. **Create a new Vercel project:** `aac-monorepo-middleware`. Deploy from the monorepo.
3. **Point it at sandbox environments** (Sandbox Pipedrive, test Quo number) and verify webhook handling end-to-end.
4. **Dual-home:** Keep the original aac-slim Vercel project running in production. The monorepo version runs in parallel against sandbox.
5. **The Switch:** Once verified, swap the webhook URLs in OpenPhone/Pipedrive to point to the new monorepo middleware URL.
6. **Bake period:** Run both for 7 days. Monitor the Command Center dashboard for any heartbeat gaps or webhook failures.
7. **Decommission:** Archive the standalone aac-slim repo as read-only only after 7 days of stable monorepo operation.

### Phase 3: Migrate Storefront (Most complex, last to move)

1. **Copy aac-astro** into `apps/storefront`.
2. Re-plumb the CI/CD pipeline: adapt the GitHub Actions `quality.yml`, pre-commit hooks, and Lighthouse gates to work within the Turborepo structure.
3. **Categorize and move the 43+ scripts:** Build-time scripts stay in `apps/storefront`, operational/cron scripts move to `tools/`.
4. Refactor any direct API calls in the storefront to use `@aac/api-clients`.
5. **Create a new Vercel project** for the storefront within the monorepo. Test against staging domain.
6. **DNS cutover** from the old Vercel project to the new one.
7. Archive the standalone aac-astro repo after 7 days of stability.

### Phase 4: Build Marketing Engine (Greenfield from spec)

1. **Create `apps/marketing`** as a new application, built from the existing gate documents and specs in aac-marketing-engine.
2. Build it fresh within the monorepo, consuming `@aac/api-clients` and `@aac/shared-utils` from day one.
3. The Marketing Engine may use its own local data store (SQLite/Prisma) for content production workflows, while writing campaign results to the shared Redis for Command Center visibility.

### Cross-Phase: Tools Migration

As scripts are categorized during Phase 3, operational scripts move to `tools/` and are refactored to be thin wrappers over `@aac/api-clients`. This can happen incrementally — each script migrated independently as time allows.
