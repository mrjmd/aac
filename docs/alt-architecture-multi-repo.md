# Alternative Architecture: Four Independent Codebases with Shared Packages

This document presents the same four-pillar AAC Business Automation System as the monorepo spec, but implemented as **independent repositories** connected by published shared packages and well-defined communication protocols.

## 1. Repository Structure

```
GitHub Repositories:
├── aac-shared/            # Published npm packages (@aac/api-clients, @aac/shared-utils)
├── aac-slim/              # Pillar 1: Operations Brain (Next.js 14) [SACROSANCT]
├── aac-astro/             # Pillar 2: Digital Storefront (Astro 5)
├── aac-marketing-engine/  # Pillar 3: Marketing Engine (Content Production App)
├── aac-command-center/    # Pillar 4: Analytics/BI Dashboard (Next.js 15)
└── aac-tools/             # Operational/Cron scripts (Thin wrappers)
```

Each repo is fully independent: its own `package.json`, its own CI/CD, its own Vercel project, its own git history. They share logic by importing from `@aac/api-clients` and `@aac/shared-utils`, published from the `aac-shared` repo.

## 2. The Shared Packages Repo (`aac-shared`)

This is the linchpin. It's a small, focused repo that publishes two npm packages (plus a shared tsconfig). It has **no application logic** — only reusable clients and utilities.

```
aac-shared/
├── packages/
│   ├── api-clients/         # @aac/api-clients
│   │   ├── src/
│   │   │   ├── pipedrive.ts     # Lead/Deal CRUD, activity logging
│   │   │   ├── quo.ts           # SMS sending, internal notes
│   │   │   ├── quickbooks.ts    # Estimate drafting, customer sync, OAuth token mgmt
│   │   │   ├── searchbug.ts     # Phone scrubbing, DNC validation
│   │   │   ├── gemini.ts        # Image analysis, intent extraction
│   │   │   ├── google-calendar.ts  # OAuth-based event management
│   │   │   ├── google-ads.ts       # Conversion uploads (Developer Token + MCC)
│   │   │   ├── google-analytics.ts  # Data API (Service Account) reporting
│   │   │   ├── google-search-console.ts  # Query performance, CTR data
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── shared-utils/        # @aac/shared-utils
│   │   ├── src/
│   │   │   ├── phone.ts         # THE canonical phone normalization
│   │   │   ├── redis.ts         # Key schema builders, dedup logic
│   │   │   ├── logger.ts        # Structured JSON logging
│   │   │   ├── queue.ts         # QStash helpers (delay calc, batch, signature verify)
│   │   │   ├── types.ts         # Shared interfaces (Lead, Estimate, Contact, etc.)
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── tsconfig/            # @aac/tsconfig
│       ├── base.json
│       └── package.json
├── package.json             # pnpm workspace root (for developing the packages together)
├── pnpm-workspace.yaml
├── vitest.config.ts
├── CLAUDE.md                # "You are in the shared core. No breaking changes. Full test coverage."
└── turbo.json               # Build/test pipeline for the packages only
```

### Publishing Strategy

**Option A: npm (private registry or GitHub Packages)**
- Each package published as `@aac/api-clients` and `@aac/shared-utils`.
- Consumer repos install them like any npm dependency.
- Version bumps trigger CI in all consumer repos (via GitHub Actions workflow dispatch or Renovate/Dependabot).

**Option B: Git dependencies**
- Consumer repos reference the shared repo directly in `package.json`:
  ```json
  "@aac/api-clients": "github:mrjmd/aac-shared#main"
  ```
- Simpler setup, no registry needed. But: no semver, no lockfile pinning, harder to reason about which version each app is running.

**Option C: Git submodules**
- Each consumer repo includes `aac-shared` as a submodule and references it via workspace-like paths.
- Tightest control over versions (pinned to a commit), but submodules are notoriously painful to manage.

**Recommended: Option A with GitHub Packages.** It gives you proper semver, lockfile pinning, and automated update PRs. The overhead is a one-time setup of a GitHub Actions publish workflow.

### The Contract (Same as Monorepo)

All clients are **Stateful** — they accept configuration via constructors, never read `process.env` directly. This is what makes them portable across all consumer contexts.

- **Pipedrive:** Lead/Deal CRUD and activity logging.
- **Quo (OpenPhone):** SMS sending and internal note creation.
- **QuickBooks:** Estimate drafting and customer syncing.
- **SearchBug:** Phone scrubbing and DNC validation.
- **Gemini:** Image analysis and intent extraction.
- **Google Calendar:** OAuth-based event management.
- **Google Ads:** Conversion uploads (Developer Token + MCC).
- **Google Analytics:** Data API (Service Account) for reporting.
- **Google Search Console:** Query performance and CTR data.

Shared utils:

- **Phone:** Single source of truth for normalization (Vitest protected).
- **Redis:** Key schema builders (e.g., `keys.heartbeat(app)`) and deduplication logic.
- **Logger:** Standardized JSON logging for the Command Center to ingest.
- **Queue:** QStash delay calculation, batch queueing, signature verification.
- **Types:** Shared TypeScript interfaces (Lead, Estimate, Contact, Campaign, etc.).

## 3. Pillar Responsibilities

### Pillar 1: Operations Brain (`aac-slim`) [SACROSANCT]

- **Status:** Active production.
- **Framework:** Next.js 14.
- **Trigger:** Webhooks and real-time events.
- **Duty:** Instant reactions — CRM sync, quote drafting, GCal placeholders, attribution, entity extraction.
- **Rule:** No UI beyond minimal admin. No bulk processing. No marketing logic. Every change must be unit tested.
- **Consumes:** `@aac/api-clients`, `@aac/shared-utils`.
- **Deployment:** Its own Vercel project. Its own CI/CD. Changes here go through the most scrutiny.

### Pillar 2: Digital Storefront (`aac-astro`)

- **Status:** Active production (launched March 21, 2026).
- **Framework:** Astro 5 with Tailwind CSS v4.
- **Trigger:** User browser visits and Vercel Cron jobs.
- **Duty:** Lead capture, SEO, content publishing (320+ pieces), "Latest Work" photo sync.
- **Rule:** Stateless. Build-time scripts (SEO validation, a11y checks, Lighthouse gates) stay here. Operational scripts migrate to `aac-tools`.
- **Consumes:** `@aac/api-clients` (for GCal cron, lead submission), `@aac/shared-utils`.
- **Deployment:** Its own Vercel project with existing CI/CD pipeline (GitHub Actions quality gates, pre-commit hooks).

### Pillar 3: Marketing Engine (`aac-marketing-engine`)

- **Status:** Spec and vision docs exist; prior codebase was a short-lived experiment. Will be rebuilt fresh.
- **Framework:** Next.js (App Router), Prisma, SQLite (local-first for content workflows).
- **Trigger:** Business owner login for content production; cron for publishing.
- **Duty:** AI content generation, platform-specific variants, approval workflows, Buffer scheduling, SMS campaigns, DNC scrubbing.
- **Rule:** This is a full content production application, not a scripts folder. Heavy, ambitious, creative. Campaign results written to shared Redis for Command Center visibility.
- **Consumes:** `@aac/api-clients` (Buffer, Gemini, SearchBug), `@aac/shared-utils`.
- **Deployment:** Its own Vercel project.

### Pillar 4: Command Center (`aac-command-center`)

- **Status:** Greenfield. First new build.
- **Framework:** Next.js 15 App Router.
- **Trigger:** Business owner login.
- **Duty:** Observability dashboard. Read-only for most systems. "Approve" buttons for automated drafts.
- **Rule:** No data of its own. Aggregates state from Redis, Pipedrive, and the other pillars.
- **Consumes:** `@aac/api-clients` (Pipedrive for approvals, renewals), `@aac/shared-utils` (Redis key schema for reading heartbeats/audits).
- **Deployment:** Its own Vercel project.

### Operational Scripts (`aac-tools`)

- **Status:** To be consolidated from the 43+ scripts currently in aac-astro.
- **Framework:** Plain Node.js/TypeScript. No web framework.
- **Trigger:** Manual invocation or external cron (Vercel Cron, GitHub Actions schedule).
- **Duty:** GA4 reporting, GSC analysis, Google Ads keyword/bid management, image optimization, Buffer batch posting to GBP.
- **Rule:** Scripts must be "thin" — all API interaction logic lives in `@aac/api-clients`. A script is a 5-20 line wrapper that configures a client and calls its methods.
- **Consumes:** `@aac/api-clients`, `@aac/shared-utils`.
- **Deployment:** Not deployed as a web service. Scripts run locally, via CI, or via cron triggers.

## 4. Communication & Redis Topology

### Data Layer

- **Middleware, Command Center, Tools:** All connect to the **same shared Upstash Redis database**. Each initializes its own connection using its own env vars.
- **Storefront:** Stateless. Fetches data at build time or via Vercel Cron. No persistent data layer.
- **Marketing Engine:** Uses its own local data store (SQLite/Prisma) for content production workflows (ideas, posts, variants, approval state). Writes campaign results and stats to the shared Redis so the Command Center can display them. Data architecture open for revisiting if there's a good reason to align with Redis elsewhere.

### The Redis Rule

- **Schema:** Defined in `@aac/shared-utils/redis`. This is the single source of truth for key naming. Every app that touches Redis imports its key builders from here.
- **Connection:** Per-app. Each app creates its own Upstash client. No shared connection objects, no runtime coupling.

### Communication Matrix

| Source | Target | Lane | Data/Intent |
|--------|--------|------|-------------|
| Quo | Middleware | Webhook | Real-time lead intake |
| Middleware | Redis | Ephemeral | `health:middleware:ts` (Heartbeat every 5 min) |
| Middleware | Redis | Stream | `logs:webhooks` (Audit Trail for Dashboard) |
| Middleware | QStash | Background | Campaign message queuing with throttled delays |
| Marketing | Redis | Ephemeral | Campaign stats (sent, failed, opt-outs) |
| Marketing | Buffer | API | Social content scheduling and publishing |
| Storefront | Google Calendar | API (Cron) | Fetch project photos for "Latest Work" section |
| Storefront | Pipedrive | API | Lead form submission (via `/api/leads.ts`) |
| Command Center | Redis | Read | Heartbeat monitor, webhook audit, campaign pulse |
| Command Center | Pipedrive | API | Manual "Approve Quote" → Trigger Workflow |
| Command Center | Pipedrive | Read | Business meta-data (ASHI renewals, domain expirations) |
| Tools | Google Analytics | API | GA4 reporting, content ROI |
| Tools | Google Ads | API | Keyword/bid management, conversion tracking |
| Tools | Google Search Console | API | Query performance, CTR trends |
| Tools | Buffer | API | Batch posting project photos to GMB/Social |

### Key Data Flows

**Health & Observability:** Middleware pings `health:middleware:ts` every 5 minutes. Command Center reads this key — if timestamp > 6 minutes old, it shows a "Middleware Down" alert. Middleware also logs every incoming Quo/Pipedrive webhook to a `logs:webhooks` Redis stream; Command Center surfaces the last 50 events to verify "life."

**Marketing Intelligence:** Marketing Engine writes batch campaign results (sent, failed, opt-outs) to Redis. Command Center pulls these stats to show a "Campaign Pulse" card.

**Business Meta-Data:** Important renewal dates (ASHI, insurance, domains) are stored as deal dates in a "Business Admin" board in Pipedrive. Command Center alerts 30 days before expiration.

**Content Sync:** A Vercel Cron job in the website uses `@aac/api-clients` Google Calendar client to fetch project photos from the last 7 days and updates the site's "Latest Work" section.

**Lead Flow (Storefront → Pipedrive):** The website's `/api/leads.ts` endpoint uses `@aac/api-clients` Pipedrive client directly. Leads are created in Pipedrive, which fires a webhook to Middleware for further processing (Quo sync, entity extraction). The website does NOT call the middleware — it calls Pipedrive, and the middleware reacts to the Pipedrive event.

## 5. Governance & Guardrails

### Guardrail 1: CLAUDE.md Per Repo

Each repository has its own `CLAUDE.md` at the root that scope-locks the AI:

- **`aac-shared`:** "You are in the shared core. No breaking changes to function signatures without checking all consumers. Full Vitest coverage required. `strict: true` everywhere."
- **`aac-slim`:** "You are in the sacrosanct operations brain. Minimal changes only. Every change must be unit tested. No UI code. Import API clients from `@aac/api-clients` — never implement direct API calls."
- **`aac-astro`:** "You are in the public website. SEO validation is non-negotiable. Do not add operational scripts here — they belong in aac-tools. Import API clients from `@aac/api-clients`."
- **`aac-command-center`:** "You are in the read-only dashboard. No writes to external systems except explicit 'Approve' actions. Import from `@aac/api-clients` and `@aac/shared-utils`."
- **`aac-marketing-engine`:** "You are in the content production app. Campaign results must be written to shared Redis. Import API clients from `@aac/api-clients`."
- **`aac-tools`:** "Scripts must be thin wrappers. All API logic lives in `@aac/api-clients`. If you're writing more than 20 lines, you're doing it wrong."

### Guardrail 2: Type Safety

- `strict: true` in all repos via the shared `@aac/tsconfig` base config.
- A breaking change in `@aac/api-clients` will cause TypeScript compilation failures in every consumer on their next `pnpm install` / dependency update.

### Guardrail 3: Dependency Version Enforcement

- Renovate or Dependabot configured on all consumer repos to auto-create PRs when `@aac/api-clients` or `@aac/shared-utils` publishes a new version.
- CI in each consumer repo runs `pnpm build && pnpm test` on dependency update PRs. If it fails, you know the shared package broke something before it hits production.

### Guardrail 4: ESLint Import Restrictions

Each consumer repo's ESLint config blocks direct `fetch()` or `axios` calls to known API domains (Pipedrive, Quo, QBO). Forces use of the shared client.

## 6. What This Architecture Gains Over the Monorepo

### Complete Blast Radius Isolation

A bad deploy of the Marketing Engine cannot possibly affect the Middleware. They share no build pipeline, no deployment, no CI. In a monorepo, a misconfigured `turbo.json` or a bad root `package.json` change can cascade.

### Independent Velocity

Each repo can move at its own pace. The website can stay on Astro 5 while the command center uses Next.js 15. There's no "upgrade the whole monorepo" pressure. Version pinning is explicit in each repo's `package.json`.

### Simpler Vercel Configuration

Each repo is a standard single-app Vercel project. No root `vercel.json` routing, no monorepo detection configuration, no "which app changed?" build filtering. Vercel's default behavior just works.

### Familiar Git Workflow

Each repo has its own git history, its own branch strategy, its own PR flow. No need to learn Turborepo's affected filtering or deal with massive diffs that touch multiple apps.

### Natural AI Context Boundaries

When you open `aac-slim` in an AI session, there is literally no Marketing Engine code in the context. The separation isn't enforced by CLAUDE.md rules that could be ignored — it's enforced by the filesystem. The AI can't smush code into the wrong place because the wrong place doesn't exist in the repo.

## 7. What This Architecture Loses vs. the Monorepo

### Version Drift

If `@aac/api-clients` publishes v2.0.0, each consumer repo updates on its own schedule. The middleware might be on v2.0.0 while the website is still on v1.3.2. This means the same Pipedrive client might behave differently across apps until everyone upgrades. Renovate/Dependabot mitigates this but doesn't eliminate it.

### Shared Package Development Friction

Changing an API client requires: (1) edit in `aac-shared`, (2) publish new version, (3) update in consumer repo, (4) test. In a monorepo, this is one PR. Here, it's a multi-repo dance. For rapid iteration on a new client, this friction is real.

To mitigate: during active development of a new client, you can use `pnpm link` to symlink the local `aac-shared` packages into the consumer repo. This gives monorepo-like DX during development, then you publish when stable.

### "Did I Update Everything?" Anxiety

After a shared package change, you need to verify all consumers are updated. Dependabot PRs help, but it's still possible to forget to merge one. In a monorepo, Turborepo's pipeline guarantees all apps build against the same version.

### Duplicate CI Configuration

Each repo needs its own GitHub Actions, its own ESLint config, its own Vitest setup. The shared tsconfig helps, but there's still boilerplate duplication across 6 repos.

### No Single `turbo run test` Across Everything

You can't run all tests everywhere with one command. Each repo is tested independently. For a solo developer, this means more context-switching when verifying cross-system changes.

## 8. Migration Strategy

### Phase 0: Build the Shared Packages Repo

1. **Create `aac-shared`** with pnpm workspaces for the two packages + tsconfig.
2. **Extract `@aac/shared-utils`** from aac-slim: consolidate the 4 duplicate phone normalization functions into one canonical implementation. Extract Redis key schema, logger, QStash helpers, shared types.
3. **Extract `@aac/api-clients`** from aac-slim: Pipedrive, Quo, QuickBooks, SearchBug, Gemini. Refactor to accept config via constructors. Add Google Calendar, Ads, Analytics, Search Console clients.
4. **Write Vitest suites** that mirror and expand on existing aac-slim tests.
5. **Publish to GitHub Packages** as `@aac/api-clients` and `@aac/shared-utils`.

At this point, aac-slim and aac-astro are **completely untouched**.

### Phase 1: Build the Command Center

1. **Create `aac-command-center`** as a new repo with Next.js 15 App Router.
2. Install `@aac/api-clients` and `@aac/shared-utils` from GitHub Packages.
3. Build: Middleware heartbeat monitor, webhook audit trail, campaign stats display.
4. Deploy as its own Vercel project.

This validates the shared packages work in a real consumer.

### Phase 2: Migrate Middleware to Shared Packages

1. **In the existing `aac-slim` repo**, replace local clients with `@aac/api-clients` imports.
2. Replace local phone/redis/logger with `@aac/shared-utils` imports.
3. Delete the now-redundant local copies.
4. Run existing tests. Fix any breakage.
5. Deploy. The Vercel project, webhook URLs, everything else stays the same. Zero infrastructure change.

This is **less risky than the monorepo approach** because you're updating the existing repo in-place, not copying it to a new location and re-pointing webhooks.

### Phase 3: Migrate Storefront to Shared Packages

1. **In the existing `aac-astro` repo**, replace any direct API calls with `@aac/api-clients` imports.
2. Categorize the 43+ scripts: build-time scripts stay, operational scripts move to `aac-tools`.
3. The existing CI/CD pipeline, pre-commit hooks, and Lighthouse gates are **completely unaffected** — nothing about the repo structure changes.

### Phase 4: Create the Tools Repo

1. **Create `aac-tools`** with the operational scripts extracted from aac-astro.
2. Refactor each script to be a thin wrapper over `@aac/api-clients`.
3. Set up cron triggers (Vercel Cron, GitHub Actions schedule, or local crontab).

### Phase 5: Build the Marketing Engine

1. **Rebuild `aac-marketing-engine`** fresh, consuming shared packages from day one.
2. Use existing gate documents and specs as the blueprint.
3. Own data layer (SQLite/Prisma) for content workflows; write campaign stats to shared Redis.

### Ongoing: Dependency Updates

- Renovate/Dependabot creates PRs in all consumer repos when shared packages publish new versions.
- Each repo's CI validates the update. Merge when green.

## 9. Script Categorization (Same Rule, Different Location)

- **Build-time?** (e.g., sitemap generation, SEO validation, a11y checks) → Stay inside `aac-astro`.
- **On-Demand/Cron?** (e.g., GA4 reports, Ads management, Buffer batch posting) → Move to `aac-tools`.
- **Logic inside scripts:** Must be thin. All API interaction logic lives in `@aac/api-clients`. A script configures a client and calls its methods.

## 10. Decision Framework: When to Choose This Over the Monorepo

Choose multi-repo if:

- **Blast radius isolation** is your top priority (a bad change in one system can never affect another).
- **You want zero migration risk** on the middleware and website (they update in-place, no re-pointing webhooks or DNS).
- **You don't want to learn Turborepo** and want each repo to be simple and self-contained.
- **The "AI can't smush across repos" boundary** feels stronger to you than CLAUDE.md rules.

Choose monorepo if:

- **Rapid iteration on shared packages** matters most (one PR to change a client and update all consumers).
- **You want one command** to build/test everything and guarantee version consistency.
- **The structural prompt value** of seeing all four pillars in one directory tree outweighs the blast radius risk.
- **You're willing to invest** in Turborepo config, monorepo Vercel setup, and cross-app pipeline management.
