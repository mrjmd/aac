# AAC Business Automation System — Monorepo Governance

This is the root of the AAC four-pillar monorepo. Read this document at the
start of every session.

## Architecture

```
apps/
  middleware/        Pillar 1: Operations Brain (Next.js 14) [SACROSANCT]
  website/           Pillar 2: Public Website (Astro 5)
  marketing/         Pillar 3: Marketing Engine (Content Production)
  command-center/    Pillar 4: Analytics/BI Dashboard (Next.js 15)
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

## Reference Documents

- `docs/meta-architecture.md` — The master architecture spec
- `docs/alt-architecture-multi-repo.md` — The alternative we considered (and why we chose monorepo)
- Each app and package has its own CLAUDE.md with specific rules.

## Legacy Codebases (Archived, Read-Only Reference)

- `../aac-slim/` — Original middleware (production, being replaced by apps/middleware)
- `../aac-astro/` — Original website (production, being replaced by apps/website)
- `../aac-marketing-engine/` — Marketing engine experiment (specs are the value)
- `../attackacrack/` — Original all-in-one attempt (archived, reference only)
