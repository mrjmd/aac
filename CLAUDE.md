# AAC Business Automation System — Monorepo Governance

This is the root of the AAC monorepo. Read this document at the start of every
session, alongside `docs/PLAN.md` (current priorities, four-priority sequence,
what's deferred) and `docs/DECISIONS.md` (running log of architectural decisions
with reasoning).

## Architecture

```
apps/
  middleware/        Pillar 1: Operations Brain (Next.js 14) [SACROSANCT]
  website/           Pillar 2: Public Website (Astro 5)
  marketing/         Pillar 3: Marketing Engine (Content Production)
  command-center/    Pillar 4: Analytics/BI Dashboard (Next.js 15)
  field/             Pillar 5: Tech-facing Job-Completion App (Next.js 15)
  agent/             Pillar 6: Conversational Agent Platform (Next.js 15)
packages/
  api-clients/       @aac/api-clients — Shared API clients
  shared-utils/      @aac/shared-utils — Phone, Redis, Logger, Types
  tsconfig/          @aac/tsconfig — Shared TypeScript configs
tools/               Operational scripts (thin wrappers)
docs/                Architecture specs and forensic analyses
```

## The Cardinal Rules

### 1. Scope Lock Your Session

Before making any changes, identify which pillar you're working in. State it
explicitly: "I am working in apps/middleware" or "I am working in packages/api-clients."
Do not make changes across multiple pillars in a single session unless explicitly
asked.

### 2. No Direct API Calls in Apps

Apps MUST NOT contain direct `fetch()`, `axios`, or SDK calls to external services
(Pipedrive, Quo, QuickBooks, Google APIs, SearchBug, Buffer, Gemini). All external
API interaction goes through `@aac/api-clients`. If you need a method that doesn't
exist yet, add it to the shared client — do not work around it locally.

### 3. No Breaking Changes to Shared Packages

If you're editing `packages/api-clients` or `packages/shared-utils`:
- Do NOT change existing function signatures without checking all app consumers.
- Run `pnpm turbo test` after any change to verify nothing breaks.
- Add tests for any new functionality.
- `strict: true` is mandatory — no `any` types, no `@ts-ignore`.

### 4. The Middleware Is Sacrosanct

`apps/middleware/` is the most critical production system. It runs the business.
- Minimal changes only. Every change must be unit tested.
- No UI code. No bulk processing. No marketing logic.
- When in doubt, don't touch it.

### 5. Phone Normalization Has One Source of Truth

There is exactly ONE phone normalization implementation: `@aac/shared-utils/phone`.
If you find yourself writing phone parsing logic anywhere else, stop and import
from the shared package.

### 6. Redis Keys Are Defined Globally

All Redis keys are defined in `@aac/shared-utils/redis`. Never hardcode a Redis
key string in an app. Use the key builders (e.g., `keys.heartbeat('middleware')`).

## Tech Stack

- **Package manager:** pnpm with workspaces
- **Build orchestration:** Turborepo
- **Language:** TypeScript (strict mode everywhere)
- **Testing:** Vitest for packages, framework-specific for apps
- **Deployment:** Vercel (each app is a separate Vercel project)
- **State:** Upstash Redis (shared database, per-app connections)

## Quick Commands

```bash
pnpm install              # Install all dependencies
pnpm turbo build          # Build all packages and apps
pnpm turbo test           # Run all tests
pnpm turbo typecheck      # Type-check everything
```

## Deploy Convention (Vercel)

Every app deploys via a script in its own `package.json` that sets
`VERCEL_ORG_ID` + `VERCEL_PROJECT_ID` and runs `vercel deploy` from the repo
root. This is uniform across all apps and works around pnpm-workspace
monorepo issues (where Vercel can't auto-detect parent files when linked from
a subdirectory).

```bash
pnpm --filter @aac/field      run deploy            # prod
pnpm --filter @aac/field      run deploy:preview    # preview URL, no prod impact
pnpm --filter @aac/middleware run deploy            # prod
pnpm --filter @aac/marketing  run deploy            # prod
```

**Important:** use `run deploy` (not just `deploy`) — `pnpm deploy` is a
built-in pnpm subcommand that does something else entirely.

There are **no `.vercel/` link directories committed anywhere** — they are
git-ignored at the root. Each app's project ID lives in its `package.json`
deploy script (project IDs are not secrets; the Vercel auth token in
`~/Library/Application Support/com.vercel.cli/` is).

For each Vercel project in the team, the project settings must be:
- `rootDirectory = apps/{name}`
- `sourceFilesOutsideRootDirectory = true`

When adding a new app:
1. Create the Vercel project in the dashboard (or via `vercel link`, then
   delete the resulting `.vercel/` after extracting the project ID)
2. Set `rootDirectory` and `sourceFilesOutsideRootDirectory` on the project
   (via dashboard or PATCH to `https://api.vercel.com/v9/projects/{id}`)
3. Add `deploy` + `deploy:preview` scripts to the app's `package.json` using
   the new project ID

See `apps/field/package.json` for the canonical script template.

## Reference Documents

- **`docs/PLAN.md`** — Current state, four active priorities, what's deferred. Read at start of every session.
- **`docs/DECISIONS.md`** — Running log of architectural decisions with reasoning + alternatives considered.
- `docs/meta-architecture.md` — The master architecture spec
- `docs/alt-architecture-multi-repo.md` — The alternative we considered (and why we chose monorepo)
- Each app and package has its own CLAUDE.md with specific rules.

## Legacy Codebases (Archived, Read-Only Reference)

- `../aac-slim/` — Original middleware (production, being replaced by apps/middleware)
- `../aac-astro/` — Original website (production, being replaced by apps/website)
- `../aac-marketing-engine/` — Marketing engine experiment (specs are the value)
- `../attackacrack/` — Original all-in-one attempt (archived, reference only)
