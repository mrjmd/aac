# Project Spec — July 2026 Audit Remediation

**Status:** Ready for implementation — not started
**Owner:** Matt (implementation handoff to a fresh agent session)
**Created:** 2026-07-02
**Pillars:** 1 (`apps/middleware/`), `packages/api-clients`, `packages/shared-utils`, repo-wide

---

## How to use this document

This is the complete, self-contained output of a five-track deep audit run on
2026-07-02 (middleware code audit, shared-packages audit, repo-wide architecture
sweep, security review, external-API currency research — all findings verified
against code at commit `4e7e13c`). A fresh agent should be able to implement any
phase from this doc alone without re-deriving the analysis.

Rules for the implementing session:

- **Work one phase at a time, in order.** Phases are sequenced by risk and by
  external deadlines. Do not reorder Phase 0/1 behind anything else.
- **Middleware is SACROSANCT** (root `CLAUDE.md` Rule 4). Every middleware change
  in this doc ships with a unit test in the same commit.
- **Shared-package changes** (`packages/api-clients`, `packages/shared-utils`)
  must not change existing function signatures without checking all consumers
  (middleware, agent, field, marketing, command-center, tools). Run
  `pnpm turbo test` after each change.
- Check items off in this doc as they land (edit the `[ ]` boxes), and note the
  commit hash next to completed items.
- Several items overlap `docs/projects/middleware-cleanup.md` (the 2026-05-28
  cleanup spec). Where they overlap, this doc is the superset; the older spec's
  items are folded into Phase 5 below.

**Verification baseline before starting:** `pnpm turbo test` — expected green:
middleware 215, agent 102, api-clients 237, shared-utils 52, scheduling 104,
quoting 34. (⚠️ see P2-1: the turbo test cache is currently unreliable for
middleware/agent — run with `--force` until P2-1 lands.)

---

## The five headline findings (context for everything below)

1. **Pipedrive API v1 shuts down 2026-07-31** (29 days from audit date).
   `PipedriveClient` is built entirely on v1. Nearly every endpoint dies that
   day — middleware webhooks, all crons, deal spine, agent, tools. → Phase 1.
2. **A live Gemini API key is committed to git**, and Gemini began rejecting
   *unrestricted* standard keys on 2026-06-19 — production entity extraction /
   scheduling classification may already be silently failing. → Phase 0.
3. **The Pipedrive webhook endpoint has zero authentication**, and
   **command-center auth is presence-only** (any cookie value passes; the real
   `verifySession()` is dead code). → Phase 0.
4. **Systemic: at-most-once processing.** Every middleware handler marks events
   processed *before* doing the work and returns 200 on failure. Transient
   PD/QB/Quo outages silently and permanently drop invoices, reminders, and
   lead activity. Only the QB-estimate path has a reconciliation backstop.
   → Phase 3.
5. **Systemic: the shared clients are inconsistently hardened.** The 429/retry
   work on Pipedrive (commit `d63d5a5`) didn't propagate; Quo and QB have none,
   and three data-destruction bugs are armed in the client layer. → Phase 4.

---

## External API deadline calendar (drives the phase order)

| Deadline | What | Action | Phase |
|---|---|---|---|
| **PASSED (2026-06-19)** | Gemini rejects unrestricted standard API keys | Verify prod key has an API restriction in Cloud Console TODAY | 0 |
| ~~2026-07-31~~ (v1 "out of support" since 2026-08-01, still functioning; NO announced removal date as of 2026-10-16) | Pipedrive v1 API shutdown | Migrate `pipedrive.ts` to v2 — schedulable, not deadline-driven | 1 |
| **2026-07-31** | QB legacy webhook payload dies | ✅ NONE — `/api/qb-webhook` is already CloudEvents-only (built that way day one, see DECISIONS.md 2026-05-29) | — |
| **2026-08-17** | `imagen-4.0-generate-001` shutdown | Rework `generateImage()` for `gemini-3.1-flash-image` (generateContent-style, NOT `:predict` — code change, not model-ID swap) | 6 |
| **2026-09-30 (approx "September")** | ALL Gemini standard keys die → service-account-bound auth keys | Migrate key type; move key from `?key=` query param to `x-goog-api-key` header | 6 |
| ~~2026-10-16~~ ☑ | `gemini-2.5-flash` shutdown | Superseded: clients use `gemini-flash-latest` alias; marketing vision libs migrated 2026-10-16 (quality-gate + crop, thinkingBudget 0) | 6 |
| ~~**~2026-11-01**~~ ☑ 2026-10-16 | US DST ends — hardcoded `-04:00` offsets go wrong | getDayRangeEastern now computes the real Eastern offset; followup noon anchors were already DST-safe | 3 |
| No date | Google Maps Distance Matrix is Legacy (≥12 mo notice promised); QB `minorversion=70` silently ignored since 2025-08 (runs as 75) | Routes API migration at leisure; bump minorversion pin to 75 as housekeeping | 6 |

**No action needed (verified current as of 2026-07-02):** Quo/OpenPhone API
(`api.openphone.com/v1` + signature scheme unchanged post-rebrand), Buffer
GraphQL API (open beta, personal API keys — the model `buffer.ts` already uses),
GA4 Data API v1beta, Calendar v3, Drive v3, Search Console v1.

---

## Phase 0 — Security fires (do first; ~1 day total)

### P0-1. Rotate the committed Gemini API key ☑ (2026-10-16: Google had auto-disabled the key — "reported as leaked"; hardcoded line replaced with env read. No rotation needed, prod uses a different key.)

- **Where:** `tools/src/scratch/spike-imagen.ts:16` —
  `const GEMINI_API_KEY = 'AIzaSy…'` hardcoded, committed in `5c0b60e`.
- **Fix:** (a) Matt revokes/rotates the key in Google Cloud Console — removal
  from HEAD is NOT enough, it's in git history; (b) replace the line with
  `process.env.GEMINI_API_KEY`; (c) repo-wide grep to confirm it was the only
  one (audit scanned for `sk-`/`AIza`/`ghp_`/`AKIA`/`xox`/bearer patterns —
  this was the only committed secret).
- **Requires Matt:** yes (Cloud Console access).

### P0-2. Verify the prod Gemini key is restricted ☐

- Since 2026-06-19 the Gemini API rejects unrestricted standard keys. If the
  key on the middleware/marketing Vercel projects is unrestricted,
  `extractEntities` / `classifySchedulingIntent` may be failing right now.
- **Check:** Cloud Console → key → API restriction = "Generative Language API".
  Also check `health:errors` (middleware `/api/health`) for Gemini failures
  since June 19.
- **Requires Matt:** yes.

### P0-3. Authenticate the Pipedrive webhook ☑ **[CRITICAL]** (2026-10-16: Basic auth on subscription 1376577 + timing-safe check in handler, fails closed 503 in prod; creds in Vercel PIPEDRIVE_WEBHOOK_USER/PASS; verified live end-to-end.)

- **Where:** `apps/middleware/api/webhooks/pipedrive.ts:122-137` — no signature,
  no Basic auth, no secret. Anyone who guesses the URL can POST forged
  `person.added` payloads → writes into Quo (`:259`, `:340`), creates QB
  customers (`:463`), poisons Redis phone→PD mappings (`:180`).
- **Fix:** Pipedrive webhook subscriptions support HTTP Basic auth. (a) Matt
  sets username/password on the PD webhook subscription; (b) add env
  `PIPEDRIVE_WEBHOOK_USER` / `PIPEDRIVE_WEBHOOK_PASS` to `lib/env.ts` +
  `.env.example` + Vercel; (c) handler verifies the `Authorization: Basic`
  header with `crypto.timingSafeEqual` BEFORE dedup/processing; 401 on
  mismatch; **fail closed** (503) if env unset in production — mirror the
  pattern in `api/qb-webhook.ts:94-97` (timing-safe) and its unconfigured-503
  behavior.
- **Test:** extend `__tests__/webhooks-pipedrive.test.ts`: valid auth passes,
  missing/wrong auth → 401, unset env in prod → 503.
- **Requires Matt:** setting the credential on the PD subscription (or agent
  does it via PD API if token permits webhook admin).

### P0-4. Gate `/api/enrich` behind auth ☑ **[HIGH]** (2026-10-16: verifyCronAuth bearer required.)

- **Where:** `apps/middleware/api/enrich.ts:11-12, 127-140` — comment says "No
  auth required"; returns extracted name/email/address for any sequential
  `personId`, burns Gemini quota per hit, and writes back to PD via
  `updatePersonIncremental` (`:112`). Enumerable PII leak + prompt-injection
  surface.
- **Fix:** it's an admin retry tool — require `verifyCronAuth` from
  `lib/cron.ts` (Bearer CRON_SECRET). Update the header comment.
- **Test:** new `__tests__/enrich.test.ts` — 401 without bearer, happy path
  with (mock clients).

### P0-5. Wire real session verification into command-center ☐ **[CRITICAL]**

- **Where:** `apps/command-center/middleware.ts:19-22` checks only cookie
  *presence* (`aac-session` — any value passes). The HMAC-checking
  `verifySession()` in `apps/command-center/lib/auth.ts:37` has ZERO callers.
  `app/api/todos/route.ts` (GET/POST/PATCH/DELETE) and
  `/api/health/middleware` have no route-level auth. `curl -H 'Cookie:
  aac-session=x'` currently reads business financials and writes/deletes todos.
- **Fix:** `apps/marketing` uses the byte-identical auth lib and wires it
  correctly — copy that wiring: call `verifySession()` in every API route
  (401 on fail) and in the dashboard layout/middleware. The HMAC uses Web
  Crypto so it CAN run in Edge middleware.
- **Also (same file, lower severity):** `checkPassword` (`lib/auth.ts:46`) and
  `verifySession` (`:41`) use non-timing-safe `===` → switch to
  `crypto.timingSafeEqual` (or the Web Crypto equivalent in Edge); add basic
  rate limiting on `app/api/auth/login/route.ts` (Upstash already available).
- **Note:** command-center has no test script (see P2-2) — at minimum add a
  route-level auth test if a test harness is introduced in the same session.

### P0-6. Add session validation to field-app read pages ☑ **[HIGH]** (2026-10-16: requireSession() on day + event-detail pages, deployed.)

- **Where:** `apps/field/middleware.ts` is presence-only *by design* (Edge
  can't reach Redis; its comment says pages do the real lookup). The write
  server actions (`app/events/[id]/actions.ts`) and `settings/page.tsx`
  DO call `getCurrentSession()`/`requireSession()` — but
  `app/events/[id]/page.tsx:29` and `app/page.tsx` render customer
  name/phone/address without any session lookup. Forged cookie → PII read.
- **Fix:** `await requireSession()` at the top of both pages (and any other
  data-bearing page — sweep `app/**/page.tsx`).

### P0-7. Google Ads webhook: fail closed ☐ **[MEDIUM]**

- **Where:** `apps/middleware/api/webhooks/google-ads.ts:140-143` —
  `if (env.googleAds.webhookKey && payload.google_key !== …)` — check silently
  disappears if `GOOGLE_ADS_WEBHOOK_KEY` is unset (`lib/env.ts:101` marks it
  optional). Non-timing-safe compare, secret in body.
- **Fix:** return 503 when unconfigured (mirror qb-webhook); use
  `crypto.timingSafeEqual`.
- **Test:** extend `__tests__/webhooks-google-ads.test.ts` for the unset-env
  and wrong-key branches.

### P0-8. `FIELD_AUTH_BYPASS_EMAIL` prod guard ☐ **[MEDIUM]**

- **Where:** `apps/field/middleware.ts:21`, `apps/field/lib/session.ts:56`,
  `app/layout.tsx:30` — if this env is ever set on the production Vercel
  project, ALL field auth is off (it fabricates a valid session).
- **Fix:** honor it only when `process.env.VERCEL_ENV !== 'production'`.

### P0-9. QB OAuth: random CSRF state + escape callback HTML ☐ **[MEDIUM]**

- **Where:** `apps/middleware/api/auth/quickbooks/connect.ts:24` uses constant
  state `'aac-middleware'`; `callback.ts:43` just compares to the constant.
  Attack: attacker completes the flow with THEIR QB company → `storeQBTokens`
  (`callback.ts:100-105`) overwrites prod tokens with wrong-realm tokens →
  every QB call 403s until Matt re-auths (one-request integration DoS).
  Additionally `callback.ts:34-38, 83-87, 115-123` interpolate
  `error`/`error_description`/`errorText`/`realmId` unescaped into HTML
  (reflected XSS).
- **Fix:** (a) random state nonce stored in Redis with short TTL,
  verify-and-consume on callback — mirror `apps/field/lib/google-oauth.ts`
  (`consumeState`); (b) HTML-escape all interpolated values or return
  `text/plain`.
- **Test:** new `__tests__/qb-oauth.test.ts` covering state mismatch, token
  exchange failure, and that responses don't reflect raw query input.

### P0-10. Auth or trim middleware `/api/health` ☐ **[MEDIUM]**

- **Where:** `apps/middleware/api/health.ts:117-195` — unauthenticated; returns
  last 50 `health:errors` entries whose messages routinely embed customer
  names/phones (e.g. `invoice-create.ts:278` logs event summaries = customer
  names); `countKeysWithPrefix` (`:100-112`) SCANs the full shared keyspace
  ×3 per unauthenticated hit.
- **Fix:** require a bearer secret (reuse CRON_SECRET via `verifyCronAuth`);
  command-center already proxies it server-side
  (`apps/command-center/lib/middleware-health.ts`) so add the header there in
  the same change. Consider dropping/limiting error `details` in the response
  regardless. Cache or remove the SCAN-based mapping counts.
- **Consumer check:** anything else hitting `/api/health` unauthenticated
  (uptime monitors?) — ask Matt before shipping.

---

## Phase 1 — Pipedrive v2 migration (hard deadline 2026-07-31)

### P1-1. Migrate `PipedriveClient` from v1 to v2 ☐ **[URGENT]**

- **Where:** `packages/api-clients/src/pipedrive.ts:389` and `:816` — base URL
  `https://api.pipedrive.com/v1` (hardcoded twice). Per Pipedrive's deprecation
  schedule, v1 endpoints stop working 2026-07-31. 14 of the 15 endpoint shapes
  used are deprecated; only `POST /v1/notes` survives (v2 has no notes
  replacement yet — KEEP it on v1).
- **Endpoints in use (audit-verified):** `GET /persons/search` (`:445,:464`),
  `GET/POST/PUT /persons` (`:481,:516,:551,:646,:791`),
  `GET /organizations/{id}` (`:490`), `POST /notes` (`:522`),
  `POST /activities` (`:689,:712`), `GET /activities` (`:759`),
  `GET /persons/{id}/activities` (`:777`), and via `rawGet`:
  `GET /persons/{id}/deals` (`:973`), `GET /deals` (`:986`),
  `GET /deals/search` (`:1043`), plus `GET/POST/PUT /deals`
  (`:934-:1055`).
- **v2 changes to apply:** base path → `/api/v2/...`; updates `PUT` → `PATCH`;
  person `phone`/`email` → `phones[]`/`emails[]` arrays; custom fields move
  under a `custom_fields` object; search + list response shapes change;
  `api_token` auth mechanism itself unchanged. v2 calls cost 50% fewer
  rate-limit tokens (bonus).
- **Fold in P4-4 here:** route `rawGet` (`:801-828`, currently NO throttle and
  NO 429 retry) through the throttled `request()` (`:385-439`) so
  `getDealsByPerson`/`listDeals`/`findDealByExternalId` get the same
  protection. The deal-reconcile cron loops `findDealByExternalId` per QB
  record — exactly the batch load the throttle was built for.
- **Safety net:** the existing 697-line `pipedrive.test.ts` (incl. dedicated
  429/Retry-After suite at `:628-687`) — update expectations to v2 URL/body
  shapes; keep every behavioral assertion.
- **Consumers to re-verify after:** middleware (webhooks + crons + deal spine),
  agent, field, tools. `pnpm turbo test --force`, then a live smoke test
  (e.g. `getPersonById` + `searchPersonByPhone` against prod PD via a scratch
  script).

### P1-2. Confirm the PD webhook subscription is v2 ☐

- The handler's payload types (`apps/middleware/api/webhooks/pipedrive.ts:41-70`)
  are v2-shaped (`data`/`previous`, `data.phones[]`) but the `meta.action`
  union says `'added'|'updated'|'deleted'` — that's v1 naming; v2 uses
  `create|change|delete`. Action is only logged (`:145`), never branched on,
  so this is currently cosmetic — but fix the type union and confirm with Matt
  (or via PD API) that the subscription itself is a v2 webhook. v1 webhooks
  are deprecated "completely in 2026" with no exact date published.

---

## Phase 2 — Repo trust infrastructure (tiny fixes, big leverage; same session as Phase 1 is fine)

### P2-1. Fix `turbo.json` test inputs ☐ **[HIGH — silent false green]**

- **Where:** root `turbo.json`, test task: `"inputs": ["src/**", "tests/**",
  "*.test.*"]`. Middleware and agent code lives in `api/`, `lib/`,
  `__tests__/` — NONE match, so Turbo can serve **stale cached test passes
  after real code changes** on the sacrosanct pillar.
- **Fix:** drop the `inputs` field (default = all package files) or add
  `api/**`, `lib/**`, `__tests__/**`. Verify: change a middleware file, run
  `pnpm turbo test`, confirm cache MISS for `@aac/middleware`.

### P2-2. Fix the four `log.error` arity bugs ☐ **[5-minute fix, big forensic payoff]**

- **Where:** `Logger.error(message, error?, context?)` per
  `packages/shared-utils/src/logger.ts:15` — but all four operational-cron
  catch blocks pass a context object in the ERROR slot:
  `api/cron/invoice-create.ts:272-276`, `invoice-send.ts:192-196`,
  `job-reminders.ts:241-245`, `job-followups.ts:250-254`. Result: failure logs
  read `error: "[object Object]"` with no eventId/summary/stack — exactly the
  runs that need forensics produce garbage.
- **Fix:** `log.error(msg, err, { eventId, summary })`. Add a test asserting
  the log shape on the failure path of one cron.

### P2-3. Root CLAUDE.md / PLAN.md reality sync ☐

These docs are loaded into every AI session; drift here misleads all future
work. Corrections (all audit-verified):

- Root `CLAUDE.md` architecture block: middleware is **plain Vercel serverless
  functions** (not "Next.js 14"); agent is also plain Vercel functions (not
  "Next.js 15"); packages list is missing `quoting`, `scheduling`,
  `agent-tools`, `ui`; `apps/website` is an empty shell (CLAUDE.md only — the
  real site still lives in `../aac-astro`), say so.
- `docs/PLAN.md` architecture section: same middleware/agent framework fix.
- Root `package.json` description still says "Four-Pillar Monorepo" (six).
- `apps/command-center/CLAUDE.md` says "read-only dashboard" — it has write
  endpoints (todos POST/PATCH/DELETE). Update.
- `tools/CLAUDE.md` describes script types (GA4 reporting, Ads management,
  Buffer batch posting) that don't exist; actual content is data-repair
  one-offs + analysis pipeline. Update alongside P5-8.
- `apps/command-center/package.json` is missing the uniform `deploy` /
  `deploy:preview` scripts (root CLAUDE.md claims uniformity) — add them per
  the canonical template in `apps/field/package.json`.

---

## Phase 3 — Middleware reliability epic (before Walk #7 / `executeDirective`)

The theme: today the system is **at-most-once**. Handlers mark work done before
doing it and return 200 on failure (per the "fail safe" doctrine in
`apps/middleware/CLAUDE.md:26-27`). That doctrine is only sound when paired
with reconciliation backstops — today only QB estimates have one
(`qb-reconcile`). These items make failure states visible and retryable.
**All are middleware changes → each ships with tests.**

### P3-1. Crons: mark-after-success (start with invoice-create) ☐ **[HIGH — direct revenue]**

- **Where:** `api/cron/invoice-create.ts:149` calls
  `markCronAction('invoice-create', event.id)` BEFORE creating the invoice at
  `:251`. Same pattern: `invoice-send.ts:146` (send at `:181`),
  `job-reminders.ts:175` (send at `:226`), `job-followups.ts:153` (send at
  `:228`). Failure scenario: QB 500s on `createInvoiceFromEstimate` → event
  already stamped (7-day TTL) → tomorrow's run reports `skipped_dedup` → the
  customer is **never invoiced** and nothing alerts.
- **Fix (choose one, apply consistently):**
  (a) mark AFTER success — accept the small double-send risk on crash-between,
  or (b) mark with status `pending` → work → update to `done`; next run
  retries `pending`/`error` entries older than N minutes. Option (b) is
  strictly better for the invoice crons; (a) is acceptable for
  reminders/followups (duplicate SMS is annoying, missed invoice is money).
- **Test:** simulate QB failure on create → assert the action is NOT marked
  done (or marked `error`) and the next run retries it.

### P3-2. Build the missing inbound-lead-deal sweep (or delete the claim) ☐ **[HIGH]**

- **Where:** `api/webhooks/quo.ts:388-390` comment: "the nightly deal-reconcile
  cron sweeps any missed inbound-lead deals." **False** —
  `lib/deal-reconcile.ts` reconciles only QB estimates/invoices. If
  `ensureInboundLeadDeal` throws (`quo.ts:386`, soft-caught), that lead
  permanently has no deal; the deal spine and attribution silently miss it.
- **Fix:** add a sweep to the existing deal-reconcile cron: PD persons
  created/updated in the window lacking a lead deal (`pd-person-{id}` external
  id) → `ensureInboundLeadDeal`. Or, if deliberately deferred, delete the
  comment and log a health error when the soft-catch fires. Recommend building
  it — this is also a Walk-#7 adjacency.

### P3-3. Fix hardcoded `-04:00` Eastern offsets before November ☐ **[MEDIUM]**

- **Where:** `lib/cron.ts:103, 115-117` (`timeMin/timeMax` always
  `T00:00:00-04:00`/`T23:59:59-04:00`) and `lib/followup.ts:69` (`formatWhen`
  parses at `T12:00:00-04:00`). During EST (Nov–Mar) every cron day-window is
  shifted one hour (actually covers 11pm–10:59pm ET) — reminders/followups at
  window edges hit the wrong day.
- **Fix:** compute the offset from the actual date (e.g.
  `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', … })`-derived
  offset, or a tiny helper that checks DST for the target date — no new deps
  needed). Test with a January date and a July date.

### P3-4. Quo webhook: create-lock for PD person creation ☐ **[MEDIUM]**

- **Where:** `api/webhooks/quo.ts:356-375` — cache-miss → `searchPersonByPhone`
  → `createPerson` with no lock. A `message.received` + `call.completed` pair
  for the same call (distinct event IDs — dedup doesn't help) arriving within
  ~1s both create → duplicate "Unknown Lead" persons, each spawning its own
  Quo/QB sync cascade. Same gap in `google-ads.ts:186-214`.
- **Fix:** reuse `tryAcquireContactCreateLock` from shared-utils (the PD
  handler already uses it for Quo-contact creation at `pipedrive.ts:307`) keyed
  on the normalized phone; on lock-miss, brief wait + re-search.

### P3-5. deal-reconcile: per-record error isolation ☐ **[MEDIUM]**

- **Where:** `lib/deal-reconcile.ts:104-156, 177-230` — no try/catch per
  iteration; one PD 500 aborts the whole sweep (handler catch at
  `api/cron/deal-reconcile.ts:80-88`), leaving every remaining record
  unreconciled until tomorrow. Its sibling `qb-reconcile.ts:84-124` does this
  correctly (per-record try/catch + `errors` count).
- **Fix:** copy the qb-reconcile pattern. Test: second record throws → first
  and third still processed, errors counted.

### P3-6. Loop prevention: implement or remove the claim ☐ **[MEDIUM]**

- **Where:** `api/webhooks/quo.ts:10-12` claims "the Pipedrive webhook uses
  loop prevention (system user ID)". Not implemented: the PD handler never
  reads `meta.user_id`, and the purpose-built
  `markCreatedByMiddleware`/`wasCreatedByMiddleware` (`lib/redis.ts:131-140`)
  have zero callers. Today each person sync's PD custom-field writes
  (`pipedrive.ts:283,320,355,452,476`) re-fire the webhook 2–3 bounded extra
  cycles (update path happens not to write PD). **Any future PD write on the
  update path re-opens an unbounded loop.**
- **Fix:** check `meta.user_id` against the API-token user (add
  `PIPEDRIVE_SYSTEM_USER_ID` env — `PipedriveConfig.systemUserId` already
  exists but is unused, see P4-7) and short-circuit self-caused events; or
  wire the created-by-us Redis markers. Then fix the comment. Note the related
  memory: PD writes triggering sync is a known live hazard
  (`[[pd-writes-trigger-sync]]`).

### P3-7. Dead-letter for failed webhook events ☐ **[MEDIUM]**

- **Where:** nothing persists a failed event payload anywhere replayable —
  `logHealthError` (`lib/redis.ts:192-212`) stores a truncated message only.
  Combined with mark-before-work, a failed event cannot be reconstructed.
- **Fix (minimal, fits "no new infrastructure"):** on catch in each webhook
  handler, `LPUSH` the raw payload + error to a capped Redis list
  (`deadletter:{source}`, keep last ~100, key builder in shared-utils per Rule
  6). A manual replay endpoint can come later; capture-first.

### P3-8. Env validation at module load + decouple health ☐ **[MEDIUM]**

- **Where:** `lib/env.ts:76-144` — `requireEnv` throws inside `getEnv()` per
  request; a missing var 500s EVERY endpoint including `/api/health` (which
  only needs Redis but transitively calls `getEnv()` via
  `lib/redis.ts:22-31`). The diagnostic endpoint dies with the patient.
- **Fix:** validate required envs at module load (top-level in `env.ts`) so
  deploys fail fast in Vercel build/first-boot logs; give `getRedis()` a
  narrower env accessor so `/api/health` works when unrelated vars are
  missing.
- **Also:** `.env.example` is missing 4 vars that `env.ts` reads:
  `GOOGLE_MAPS_API_KEY`, `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`,
  `SCHEDULING_PROPOSAL_SECRET`, `AGENT_BASE_URL` (`env.ts:107,114,133,134`).
  Add them.
- **Also:** `lib/clients.ts:73-81` — `getGemini()` builds a client with
  `apiKey: ''` when unset → every extraction fails at runtime and pollutes
  `health:errors`. Return null + skip cleanly, like `getMaps()` (`:83-90`).

### P3-9. `vercel.json` maxDuration for webhook functions ☐ **[LOW]**

- 30s ceiling + new PD 429 retry/backoff + 2s lock-wait sleeps + up to ~10
  sequential external calls per webhook = a rate-limited run can be killed
  mid-sync by Vercel with NO catch-block log (worst observability outcome).
  Bump webhook functions to 60s. (Keep crons as-is unless observed near
  limit.)

---

## Phase 4 — Shared-client hardening (`packages/api-clients`)

Rule 3 applies: no signature breaks without checking all consumers; tests for
everything; `pnpm turbo test` after each item.

### P4-1. QB OAuth refresh: single-flight lock ☐ **[HIGH — three-app outage class]**

- **Where:** `packages/api-clients/src/quickbooks.ts:182-241`
  (`refreshAccessToken`/`getValidAccessToken`). Consumers share ONE Redis token
  slot (`keys.qbOAuthTokens`, `shared-utils/src/redis.ts:64`): middleware
  (`lib/redis.ts:161-173`), agent (`lib/redis.ts:46-56` — whose comment
  literally documents the race: "whichever app refreshes last wins"), field
  (`lib/clients.ts` inline), tools. No lock. Intuit ROTATES refresh tokens:
  two concurrent refreshes in the 5-min expiry window → loser consumes a dead
  token or overwrites the newer one → all QB integration 400s until Matt
  re-authorizes.
- **Fix:** Redis `SET NX PX` lock around refresh (the `contactCreateLock`
  pattern in shared-utils is the template): acquire → re-read tokens (another
  instance may have refreshed) → refresh only if still stale → save → release.
  Lock helper goes in shared-utils with a key builder; the client keeps its
  storage-callback abstraction (add optional `acquireRefreshLock`/`release`
  callbacks to the config so the package stays Redis-agnostic).
- **Also (same function):** `quickbooks.ts:208-216` reads
  `data.access_token`/`data.expires_in` off `any`; a malformed response stores
  `expiresAt: NaN`, and `NaN < now` is always false → **stale token never
  refreshes again** until cold start. Validate the response shape; throw on
  malformed.

### P4-2. `QuoClient.updateContact`: fallback must throw, not partial-PATCH ☑ **[HIGH]** (2026-10-16: throws on pre-merge read failure; test added.)

- **Where:** `packages/api-clients/src/quo.ts:384-391`. The primary
  read-merge-write path is correct (encodes the "Quo PATCH is destructive"
  lesson, tested at `quo.test.ts:190-276`). BUT `getContact()` returns null on
  ANY error (`quo.ts:271-279`, incl. transient 500/timeout) and updateContact
  then sends a **partial PATCH anyway** ("Cannot read contact for merge,
  sending partial update") — which is precisely the document-wipe the merge
  exists to prevent. A 30s Quo blip during a PD-sync webhook wipes the
  contact's name/phones/emails/externalId.
- **Fix:** throw when the pre-merge GET fails; callers already handle
  update failures (webhook soft-catch). Add a test for the GET-fails path.

### P4-3. `QuickBooksClient.updateCustomer`: sparse update ☑ **[HIGH — one-liner]** (verified already fixed in code, `sparse: true` present.)

- **Where:** `quickbooks.ts:362-385` — POSTs `{ Id, ...updates }` WITHOUT
  `sparse: true`. QBO default POST-update semantics are FULL update: omitted
  writable fields are CLEARED. Updating just `PrimaryPhone` blanks
  `BillAddr` + email.
- **Fix:** add `sparse: true` to the body. Test asserting it's present.
- **Related (LOW, note only):** the middleware PD-webhook's
  getCustomer→updateCustomer read-modify-write (`pipedrive.ts:405-426`) can
  lose a concurrent update via stale SyncToken (swallowed by
  `Promise.allSettled`) — acceptable, self-heals on next PD update.

### P4-4. Pipedrive `rawGet` throttle/429 ☐ — **folded into P1-1**

### P4-5. QB list pagination ☐ **[MEDIUM]**

- **Where:** `quickbooks.ts:450, 486` — `listRecentEstimates`/
  `listRecentInvoices` cap at `MAXRESULTS 200`, no pagination; QBO silently
  truncates → a busy reconcile window misses records and deals never advance.
  `getEstimatesByCustomer`/`getInvoicesByCustomer` cap at 100.
- **Fix:** paginate with `STARTPOSITION` until short page. Reminder: TxnStatus
  is NOT SQL-queryable on Estimate (see `[[qbo-query-quirks]]` memory /
  existing client-side filtering) — don't "optimize" the filter into the query.

### P4-6. Quo + QB: 429/timeout handling ☐ **[MEDIUM]**

- Quo (highest traffic — every webhook) and QB (3 apps + crons) have ZERO
  rate-limit retry and no request timeouts. Copy the Pipedrive `request()`
  pattern (Retry-After-aware retry, max 3, plus an AbortSignal timeout ~15s).
  Keep in mind all throttle state is per-lambda-instance (worth a comment; a
  true global limiter is out of scope).
- Also brittle: QB 404 detection by `msg.includes('404')` string-matching
  (`quickbooks.ts:413`) → use the status code.

### P4-7. Client hygiene batch ☐ **[LOW–MEDIUM, one PR]**

- `GeminiClient`: add a vision method (inlineData image parts) and migrate
  `apps/marketing/lib/image-quality-gate.ts:27` + `image-crop.ts:25` off their
  direct `fetch` to `generativelanguage.googleapis.com` (Rule 2 violations;
  they also hardcode `gemini-2.5-flash`, which dies in October — see Phase 6).
- `buffer.ts:434-437` (`createIdea`): `mediaUrls` string-interpolated into the
  GraphQL doc — a `"` in a URL breaks/injects the mutation. Use GraphQL
  variables like everywhere else. Also `buffer.ts:378,464` non-null assertions
  → real error messages. Add missing `"./buffer"` subpath export in
  `packages/api-clients/package.json`.
- `pipedrive.ts:1070` + `quo.ts:587`: identical `parseFullName` statics →
  hoist to shared-utils.
- Google OAuth boilerplate duplicated verbatim ×4 (calendar `:104-127`, drive
  `:43-65`, analytics `:103-126`, gsc `:64-87`) → one shared helper.
- Dead config fields forcing consumers to supply meaningless values:
  `PipedriveConfig.companyDomain` (required, never read),
  `QuoConfig.webhookSecret` (never used — verification lives in shared-utils).
  `PipedriveConfig.systemUserId` is unused today but becomes used by P3-6 —
  keep it.
- `gemini.ts:279`: `JSON.parse(...) as ExtractedEntities` unvalidated → apply
  the field-by-field validation pattern that already exists in the same file
  (`parseClassifierResponse`, `gemini.ts:658-714`).
- shared-utils dead exports (verified zero consumers): `types.ts` `Lead`,
  `LeadSource`, `Estimate` (type also contradicts the QBO-is-quote-truth
  model), `WebhookEvent`, `CampaignStats`, `Heartbeat` (keep `QBOAuthTokens`);
  `phone.ts` `parsePhone`, `phonesMatch`, `toRedisPhone`,
  `quickNormalizePhone` (keep `normalizePhone`). Delete.
- `logger.ts`: (a) `child().child()` (`:63`) drops accumulated context (marked
  TODO) — fix; (b) dead `wrap` helper (`:52-56`) uses banned `Function` type —
  delete; (c) no level filtering (debug always emits) — add `LOG_LEVEL` env
  filter; (d) add a key-name redaction denylist
  (token/secret/password/authorization/refresh_token) as defense-in-depth.
  Add a logger test file (currently none).
- `webhook-signature.ts`: no timestamp freshness check → >24h replay window
  after dedup TTL expiry. Add max-age check (e.g. 5 min) with a config knob.
  Note: `quo.ts:242-251`'s re-serialized-body fallback verification papers
  over a raw-body plumbing question — leave functionally, add a comment.
- `buffer.test.ts:435` burns 14 real seconds (no fake timers) → fake timers.
- No tests at all: `google-search-console.ts` (also zero consumers — consider
  deleting the client entirely), stubs `google-ads.ts`/`searchbug.ts` (fine as
  stubs).

---

## Phase 5 — Cross-pillar consolidation + middleware janitorial

Honors `[[dry-principle]]`: hoist AND migrate all callers in the same change.

### P5-1. Hoist customer matching (3 copies) ☐ **[HIGH-value]**

- `apps/field/lib/customer-match.ts:1-9` — header admits it duplicates
  `apps/middleware/lib/job-customer-match.ts` "almost verbatim"; that file's
  header (`:1-7`) admits job-reminders/job-followups carry a third inline
  variant. This is core business logic (calendar event → PD person → QB
  customer resolution).
- **Fix:** hoist into a shared package (`@aac/scheduling` is the natural home
  — it already owns event/deal conventions) and migrate all three callers +
  their tests.

### P5-2. Centralize calendar colorId conventions (4 encodings) ☐ **[HIGH-value]**

- `apps/field/lib/event-classification.ts:15-20` (10→repair, 3→assessment,
  5→callback), `apps/middleware/lib/cron.ts` (`GREEN_COLOR_IDS`,
  `REMINDER_COLOR_IDS`, `NON_JOB_KEYWORDS`, `MIN_JOB_DURATION_MINUTES`),
  `packages/scheduling/src/types.ts:46`, plus tools scripts hardcoding `'10'`.
  One business convention, four independent encodings (memory:
  `[[calendar-color-ids]]`).
- **Fix:** single module in `@aac/scheduling` exporting the color map +
  classification helper; migrate all callers.

### P5-3. Proposal types + Redis helpers → `@aac/scheduling` ☐

- `apps/command-center/lib/scheduling.ts:20-24` mirrors
  `RecordedProposalDecision` from `apps/middleware/lib/redis.ts` with a
  "must stay in sync" comment; middleware (`lib/redis.ts`, 398 lines) and
  agent (`lib/redis.ts`, 274 lines) both hand-wrap the same
  `scheduling:pending*` contract. Move shared types + read/write helpers into
  `@aac/scheduling`; per-app Redis *connections* stay per-app.

### P5-4. `verifyCronAuth` → shared-utils ☐

- `apps/agent/lib/cron.ts` header: "Mirrors apps/middleware/lib/cron.ts."
  Hoist into `@aac/shared-utils` (add timing-safe compare while moving — see
  P0 items); migrate both apps.

### P5-5. Middleware janitorial (= `docs/projects/middleware-cleanup.md`, re-verified 2026-07-02) ☐

All items from that spec re-confirmed still present, plus additions:

- Consolidate duplicated cron scaffolding into `lib/cron.ts` (COLOR_IDS →
  actually into P5-2's shared module; `EXCLUDE_KEYWORDS`,
  `MIN_DURATION_MINUTES`, `isoDateDaysAgo` ×2, `getPastDateRange` ×3,
  `extractFirstName` ×2).
- Delete dead `lib/redis.ts` exports (verified zero callers):
  `wasEventProcessed`, `getPipedriveIdFromQuo`, `getPipedriveIdFromQb`,
  `writeHeartbeat` (health.ts re-implements inline at `:188`),
  `getProposalDecisionForDirective` (`:326`, comment-only reference).
  EXCEPTION: `markCreatedByMiddleware`/`wasCreatedByMiddleware` — do NOT
  delete if P3-6 chooses the Redis-marker approach; decide P3-6 first.
- Delete unused `estimateApprovedAlert` template (`lib/templates.ts:36-39`,
  referenced only by its own test) — or wire it, per Matt.
- Promote magic strings to `@aac/api-clients` constants: PD `JOB_TITLE` field
  hash, Quo `ADDRESS`/`QUICKBOOKS` custom field IDs, the address-field UUID at
  `api/webhooks/pipedrive.ts:215`.
- Redis Rule-6 fixes: add key builders to shared-utils for
  `cron:${action}:${entityId}` (`lib/redis.ts:352`),
  `cron:${jobName}:last-run`/`:result` (`:369-370`),
  `followup:variant:${eventId}` (`lib/followup.ts:316`); derive the prefixes
  in `api/health.ts:142-144` from `keys.*` instead of literals.
- Deduplicate the entity-extraction post-processing (name-assembly ladder +
  `updatePersonIncremental`) shared by `api/webhooks/quo.ts:513-533` and
  `api/enrich.ts:99-119` → one lib helper.
- Stale comments: `job-customer-match.ts:4-6` (crons now import the helper),
  `job-followups.ts:4-5` ("9 AM Eastern (13:00 UTC)" only true in EDT;
  `DEFAULT_DELAY_DAYS = 1` at `:48` contradicts header "default 2"),
  `health.ts:16` stale `CODE_VERSION` constant → use `VERCEL_GIT_COMMIT_SHA`
  (already used at `redis.ts:201`).
- `invoice-send.ts` remains unscheduled by decision (Cron B kill, DECISIONS.md
  2026-05-27) — keep as manual endpoint, but note it inherits P3-1's
  mark-after-success fix and its `invoices[0]` blind-send
  (`invoice-send.ts:162-181`, no event↔invoice linkage) must be fixed or the
  endpoint deleted before anyone ever schedules it. Ask Matt: delete now that
  field app is steady-state?
- `?delay=0` impossible: `parseInt(...) || DEFAULT` coerces 0
  (`invoice-send.ts:70`, `job-followups.ts:75`) — use `Number.isNaN` check.

### P5-6. Close middleware test gaps ☐

Priority order:

1. **`api/webhooks/quo.ts` — the busiest handler, ZERO tests** (~555 LOC).
   Cover: signature verify + re-serialization fallback, wrapped/unwrapped
   payload parsing, event filtering, person find-or-create (+ new create-lock
   from P3-4), `ensureInboundLeadDeal` soft-failure, call-duration fallback
   (`quo.ts:406-413`), activity formatting, AI-extraction branch,
   `buildDispatchContext` mapping. Use captured webhook payloads as fixtures.
2. `api/cron/job-followups.ts` handler (lib is tested; handler wiring —
   variant-record-after-send ordering, dedup, classify wiring — is not).
3. `api/enrich.ts` (the transcript/SMS regex extraction at `:52-67` is exactly
   the brittle parsing that wants tests) — lands with P0-4.
4. QB OAuth pair — lands with P0-9.
5. `api/cron/deal-reconcile.ts` handler (qb-not-connected skip, windowDays
   parsing, error accounting).
6. Deepen `webhooks-pipedrive.test.ts`: the QB sync branch
   (`pipedrive.ts:372-491`) currently runs only with `isConnected: false`;
   the Quo custom-field enrichment block (`:510-545`) is never asserted.

### P5-7. Field app: minimum test harness ☐

- field has ZERO tests and no `test` script while handling payments and QB
  writes (`lib/completion.ts`, `lib/payment-branches.ts`). `turbo test`
  silently skips it. Add vitest + a suite for the payment-branch logic and
  customer matching (after P5-1 hoist, test lives in the package). Add `test`
  scripts (even placeholder `--passWithNoTests` is worse than nothing — write
  the payment-branch tests at minimum) to field; add scripts to
  command-center/marketing as harnesses appear.

### P5-8. tools/ hygiene ☐ **[LOW-MEDIUM, bounded effort]**

- **Move the production data pipeline out of scratch:**
  `tools/src/scratch/generate-duration-reference.ts` regenerates
  `packages/quoting`'s shipped dataset (`estimate-duration.ts:10-12` documents
  this) → move to `packages/quoting/scripts/` (or `tools/src/setup/`), update
  the doc pointer in DECISIONS.md 2026-05-29 entry if needed.
- Give `tools/` a `tsconfig.json` + `typecheck` script so `turbo typecheck`
  covers it (currently invisible to all gates; no test/lint either).
- Split `tools/src/scratch/` → `archive/` (completed one-off repairs:
  fix-miletich, restore-booher, etc. — candidates for deletion) vs live
  diagnostics.
- Known charter violations to fix opportunistically, not as a big-bang:
  ~30 scripts raw-fetch PD/Quo/QB/Gemini/Upstash (notably
  `recover-damaged-contacts.ts:234` raw-PATCHes Quo contacts — the exact
  destructive op `QuoClient.updateContact` exists to prevent;
  `fix-prospect.ts:140-141` hardcodes `map:pd-to-quo:*` with a 30-day TTL
  where the schema says 7 days; ~15 scripts copy-paste a raw Upstash REST
  helper). Rule for NEW tools scripts starting now: clients + key builders
  only. Update `tools/CLAUDE.md` to describe what tools/ actually is (P2-3).
- `tools/src/analysis/build-dashboard.ts` (1,300+ lines embedding a full HTML
  dashboard) is app-grade code in tools — note for a future decision (move
  into command-center or leave; NOT part of this remediation).

### P5-9. Session hardening for command-center + marketing (post-P0-5) ☐ **[MEDIUM]**

- Both use a deterministic forever-token: `HMAC(AUTH_SECRET, "authenticated")`
  — same value every login, no expiry beyond cookie maxAge, no server-side
  revocation. Field's design (Redis-backed sessions via `keys.fieldSession`,
  real server-side lookup) is the in-repo gold standard. Migrate both apps to
  it and de-duplicate the byte-identical `lib/auth.ts` into a shared package
  while at it (the duplication already hid the P0-5 bug once).

---

## Phase 6 — Gemini/Google deadline work (calendar-driven, see table up top)

### P6-1. By 2026-08-17: Imagen migration ☐

- `packages/api-clients/src/gemini.ts:124` `DEFAULT_IMAGE_MODEL =
  'imagen-4.0-generate-001'` dies Aug 17. Replacement
  `gemini-3.1-flash-image` is a generateContent-style model — `generateImage()`
  (`gemini.ts:550`, `:predict` endpoint) needs a rework, not a model-ID swap.
  Consumer: apps/marketing image pipeline (Spike 4.0 validated Puppeteer +
  Imagen — re-validate output quality on the new model before cutover).

### P6-2. By 2026-09: Gemini auth-key migration ☐

- All standard keys die ~September; migrate to service-account-bound auth
  keys. Move key from `?key=` query param (`gemini.ts:227,369,483,550` + the
  two marketing direct-fetch files until P4-7 removes them) to the
  `x-goog-api-key` header. Requires Matt for the Cloud Console key issuance.

### P6-3. By 2026-10-16: text model bump ☐

- `gemini.ts:123` `DEFAULT_TEXT_MODEL = 'gemini-2.5-flash'` dies Oct 16 →
  `gemini-3.5-flash`. Re-verify: the `thinkingConfig: { thinkingBudget: 0 }`
  workaround (added in `3e06d7d` because 2.5 thinking broke
  extractEntities/classifySchedulingIntent), the role-guard parser behavior,
  and the classifier test suite (19 tests) against the live model before
  deploy. Also the two marketing files hardcode `gemini-2.5-flash` — P4-7
  migration must land first or they break in October.

### P6-4. Housekeeping (no deadline) ☐

- `quickbooks.ts` `minorversion=70` → `75` (~10 sites: `:408,:431,:453,:470,
  :489,:592,:661,:724,:755,:763`; it's been silently treated as 75 since
  2025-08 — cosmetic truth-telling). Note some endpoints omit minorversion
  entirely (`:505,:555,:574,:731`, customer CRUD) — make uniform.
- Google Maps Distance Matrix (`google-maps.ts:86`) is Legacy-status: works
  indefinitely with ≥12-months-notice guarantee, but don't build NEW features
  on it; the successor is Routes API `computeRouteMatrix`. Affects
  `packages/scheduling` travel-time + `apps/field` travel legs when it
  eventually moves.

---

## Findings intentionally NOT scheduled (accepted risks — revisit if they bite)

- Automated outbound SMS re-enters the system as `message.delivered` webhook
  events (`quo.ts:454-477`): activities get logged to the *destination*
  person, Matt-side classifier runs on them, and an unmapped alert phone would
  get an "Unknown Lead" person. Low harm today; becomes relevant when
  outbound volume grows (LLM-personalized outbound plans).
- Non-timing-safe compares in `proposal-decision.ts:62` and `lib/cron.ts:42`
  — near-nil practical exploitability over HTTPS; fix opportunistically when
  P5-4 hoists cron auth.
- Per-lambda-instance throttle state in api-clients (the "200ms global gap" is
  per-instance only) — inherent to serverless; document, don't fix.
- Cron error-path status codes inconsistent (500 vs 200-with-error) — Vercel
  Cron doesn't retry either way; standardize whenever P3-1 touches the files.
- Error-alerting strategy: today only 2 hand-picked SMS alerts exist
  (Google Ads lead, multi-estimate skip); everything else waits in
  `health:errors`. The real fix is the errors→diagnostic-agent design
  (`[[errors-as-diagnostic-agent-signals]]` memory) — that's apps/agent
  roadmap work, not remediation. P3-7's dead-letter capture is the
  prerequisite that IS scheduled.
- `packages/tsconfig/node.json` includes DOM lib (how fetch/Response types
  resolve) — misleading name, functional; leave.
- Minor dep drift (`@upstash/redis` 1.28/1.34/1.38) — align opportunistically.

---

## What the audit found HEALTHY (do not "fix" these)

- Quo + Intuit webhook signature verification: correct, timing-safe, raw-body,
  verify-before-act (`shared-utils/webhook-signature.ts`,
  `qb-webhook.ts:84-98`, `apps/agent/api/webhooks/quo.ts`).
- All Vercel crons + scheduling endpoints authenticate and fail closed.
- Field app photo-upload, OAuth (random Redis-backed CSRF state,
  email-verified whitelist, open-redirect guard), and session design.
- The scheduling-directive pipeline overall: per-event error isolation,
  reverse index + reconcile backstop, confidence gating — the app's most
  mature subsystem and the model for Phase 3's fixes.
- Zero app→app source imports; phone normalization single-sourced everywhere;
  no committed build artifacts; no `.env` files in git; no NEXT_PUBLIC
  secrets; strict TS with no `any`/`@ts-ignore` in package/app source.
- `api/webhooks/quo.ts` using Web-standard Request/Response while others use
  `(req,res)` — load-bearing for raw-body HMAC (per middleware-cleanup.md);
  don't unify.
- `packages/quoting`: clean throughout (the `src/data` move + build-script
  `cp` currently uncommitted on this branch is correct for Next.js tracing).
- Upstash auto-serialization, `[[vercel-monorepo-gotchas]]`,
  bodyParser:false workaround — all already correctly handled; don't rediscover.

---

## Suggested session breakdown for implementation

| Session | Scope | Size |
|---|---|---|
| A | Phase 0 complete (P0-1..P0-10) + P2-1 + P2-2 | ~1 day |
| B | Phase 1 (PD v2 migration incl. rawGet fix) + P2-3 doc sync | ~1-2 days |
| C | Phase 3 (middleware reliability: P3-1..P3-9) | ~1-2 days |
| D | Phase 4 (P4-1, P4-2, P4-3 first — the three data-loss bugs; then P4-5, P4-6, P4-7) | ~1-2 days |
| E | Phase 5 (consolidations + janitorial + tests) — can split into E1 (hoists P5-1..P5-4), E2 (janitorial P5-5), E3 (tests P5-6, P5-7), E4 (tools P5-8, sessions P5-9) | opportunistic |
| F | Phase 6 items as their deadlines approach (Aug/Sep/Oct) | small each |

Sessions A and B are the non-negotiables before any new feature work
(Walk #7 / `executeDirective` should not ship before C and the P4 data-loss
trio either — an autonomous calendar-writing agent on top of at-most-once
delivery and unlocked QB token refresh compounds the risk).

---

## Related

- `docs/projects/middleware-cleanup.md` — 2026-05-28 cleanup spec; folded into
  P5-5 here (this doc supersedes it as the tracking surface; that spec stays
  as historical context).
- `docs/projects/scheduling.md` — Walk #7 prerequisites (the 4 dedup gaps)
  remain tracked THERE; this doc adds the reliability gates above.
- `docs/DECISIONS.md` — 2026-05-29 CloudEvents day-one decision (why QB
  webhook needs no migration); 2026-05-27 Cron B kill (why invoice-send is
  unscheduled).
- `docs/middleware.md` — endpoint/architecture reference (note: its "Future
  State" list still includes the dead-letter queue + send-safety items this
  doc now schedules as P3-7).
