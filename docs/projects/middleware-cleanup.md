# Project Spec — Middleware Cleanup

**Status:** Deferred — opportunistic
**Owner:** Matt
**Created:** 2026-05-28
**Pillar:** 1 (`apps/middleware/`)

---

## Context

Middleware is SACROSANCT (per CLAUDE.md and `apps/middleware/CLAUDE.md`) — minimal changes, every change unit-tested. During the apps/agent stack analysis on 2026-05-28, a deep read of the codebase surfaced real cleanup opportunities that don't block apps/agent but would meaningfully improve the codebase the next time we're already in middleware for another reason.

**When to do this work:** opportunistically, alongside the apps/agent Crawl-phase work that adds deal-aware webhook handlers + `[deal:N]` marker support to middleware. Don't break the SACROSANCT rule for janitorial work alone.

## Cleanup items

### 1. Consolidate duplicated cron scaffolding

The four crons (`job-reminders`, `job-followups`, `invoice-create`, `invoice-send`) copy-paste several constants and helpers:

- `COLOR_IDS = ['10']` — duplicated in `cron/invoice-create.ts:34-36`, `cron/invoice-send.ts:32-34`, `cron/job-followups.ts:41-47`
- `EXCLUDE_KEYWORDS`, `MIN_DURATION_MINUTES` — duplicated similarly
- `isoDateDaysAgo` — defined twice (`cron/invoice-create.ts:39`, `cron/invoice-send.ts:80`)
- `getPastDateRange` — defined three times under slightly different names (`getTodayRange` in invoice-create; near-identical copies in invoice-send and job-followups)
- `extractFirstName` — defined in both `cron/job-reminders.ts:50` and `cron/job-followups.ts:69`

**Fix:** Consolidate into `lib/cron.ts` (which today only holds `verifyCronAuth`). Each cron imports the shared constants + helpers instead of redefining them.

### 2. Delete dead exports in `lib/redis.ts`

Zero callers in `api/` or `__tests__/` for:

- `wasEventProcessed`
- `getPipedriveIdFromQuo`
- `getPipedriveIdFromQb`
- `markCreatedByMiddleware`
- `wasCreatedByMiddleware`
- `writeHeartbeat` (heartbeat is written inline at `api/health.ts:135`)

Loop prevention has moved to Quo externalId lookups in `api/webhooks/pipedrive.ts`, so `createdByUs` is dead. Also check `keys.createdByUs` in `@aac/shared-utils` and prune if unused.

### 3. Close test gaps in mission-critical paths

These handlers have **zero direct tests** and are mission-critical:

- `api/webhooks/quo.ts` (555 LOC — biggest handler, signature verification + AI extraction branching)
- `api/auth/quickbooks/callback.ts` (writes OAuth tokens to Redis)
- `lib/job-customer-match.ts` (compound-name and email-fallback matching used by invoice crons)

**Fix:** Add focused tests covering the happy path + the known failure modes. For `webhooks/quo.ts`, captured webhook payloads as fixtures + signature verification path coverage.

### 4. Promote magic strings to shared constants

The following are hardcoded string literals scattered across handlers, but they're load-bearing identifiers that belong in `@aac/api-clients`:

- Pipedrive `JOB_TITLE` field hash
- Quo `ADDRESS` / `QUICKBOOKS` custom field IDs
- The address field UUID in `api/webhooks/pipedrive.ts:215`

**Fix:** Add a `constants.ts` to `@aac/api-clients` (per-provider sub-namespaces if it grows) and import from there.

### 5. Delete unused `estimateApprovedAlert` template

Defined at `lib/templates.ts:36-39`, never rendered anywhere. Either wire it up to an existing flow or delete.

## Out of scope (not cleanup — load-bearing inconsistencies)

- `api/webhooks/quo.ts` uses the Web Standard `Request/Response` handler shape (vs. `(req: VercelRequest, res: VercelResponse)` everywhere else). This is **load-bearing** — it's needed to access raw bytes for HMAC verification. Don't "fix" it.
- `api/cron/invoice-send.ts` exists in code but isn't wired in `vercel.json`. This is the Cron B kill decision (2026-05-27 DECISIONS.md) — the file remains as a manual emergency endpoint. Keep as-is.

## Related

- `docs/projects/apps-agent.md` — Crawl-phase work adds deal-aware webhook handlers to middleware; natural moment to also do this cleanup
- `apps/middleware/CLAUDE.md` — middleware governance rules
- `docs/DECISIONS.md` — 2026-05-27 Cron B kill (explains the unwired `invoice-send.ts`)
