# AAC Monorepo — Master Execution Plan

**Created:** 2026-03-29
**Status:** Active — Single source of truth for all work
**Last Updated:** 2026-03-29

This document is the comprehensive, granular task list for building the AAC
four-pillar monorepo. Every task can be checked off as completed. Gaps that
need discussion are marked with `[DISCUSS]`. Dependencies between tasks are
noted inline.

---

## Table of Contents

1. [Phase 0: Shared Package Extraction](#phase-0-shared-package-extraction)
2. [Phase 1: Command Center (Operational Cockpit)](#phase-1-command-center-operational-cockpit)
   - [1A: Foundation](#phase-1a--foundation) — Design system + app scaffold
   - [1B: Middleware Health](#phase-1b--card-middleware-health-first-card) — First card (Redis only)
   - [1C: Smart To-Do](#phase-1c--card-smart-to-do-list-second-card) — Second card (Redis + CRUD)
   - [1D: Business Pulse](#phase-1d--card-business-pulse-third-card) — Third card (QB + Pipedrive)
   - [1E: Remaining Cards](#phase-1e--remaining-cards-build-as-needed) — New Leads, Campaigns, Dates, Analytics
   - [1F: Enhancements](#phase-1f--enhancements-after-core-cards-work) — Config, AI detection, Attribution, Gmail
   - [1G: Deploy & Polish](#phase-1g--deploy--polish) — Full production setup
3. [Phase 2: Shadow Middleware Migration](#phase-2-shadow-middleware-migration)
4. [Phase 3: Website Migration](#phase-3-website-migration)
5. [Phase 4: Marketing Engine (Greenfield from Spec)](#phase-4-marketing-engine)
6. [Cross-Phase: Tools Migration](#cross-phase-tools-migration)
7. [Ongoing: Infrastructure & Governance](#ongoing-infrastructure--governance)

---

## Phase 0: Shared Package Extraction

**Goal:** Extract working, tested shared packages from aac-slim (and
aac-astro patterns) WITHOUT touching either production system.

**Risk level:** Zero. We're copying code out, not modifying anything.

### 0.1 — @aac/shared-utils: Phone Normalization ✅ COMPLETE (2026-03-31)

- [x] Read aac-slim `src/lib/phone.ts` (161 lines) — understand the 5 functions
- [x] Read the 4 duplicate phone implementations identified in aac-slim's TODO doc
- [x] Identify all phone edge cases from aac-slim git history (8+ commits fixing format mismatches: E.164, 10-digit, SearchBug format, Redis format)
- [x] Design the canonical API surface:
  - `normalizePhone(phone, country?)` → E.164 string or null
  - `parsePhone(phone, country?)` → NormalizeResult or null
  - `phonesMatch(phone1, phone2)` → boolean
  - `toRedisPhone(phone)` → 10-digit string or null
  - `formatForDisplay(phone)` → human-readable string
  - ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` SearchBug client handles its own format internally. `toSearchBugFormat()` not needed in shared-utils.
- [x] Add `libphonenumber-js` as dependency of `@aac/shared-utils`
- [x] Implement phone.ts — copy from aac-slim, consolidate duplicates
- [x] Write Vitest tests covering:
  - [x] Standard US numbers (10-digit, 11-digit, E.164, parenthesized, dashed, dotted)
  - [x] International number rejection (or handling — `[DISCUSS]` is this needed?)
  - [x] Empty/null/undefined input
  - [x] SearchBug format round-trip
  - [x] Redis format round-trip
  - [x] phonesMatch across formats
  - [x] Edge cases from the 8+ git commits that fixed phone bugs
- [x] Verify: `pnpm turbo build` passes
- [x] Verify: `pnpm turbo test` passes

### 0.2 — @aac/shared-utils: Redis Key Schema ✅ COMPLETE (2026-03-31)

- [x] Read aac-slim `src/lib/redis.ts` (870 lines) — inventory all key patterns
- [x] Cross-reference with our existing `packages/shared-utils/src/redis.ts` stub (already has key builders and TTL constants from the architecture discussion)
- [x] Identify any keys in aac-slim that are missing from our schema
- [x] Identify Redis patterns used in aac-slim that go beyond key building:
  - Deduplication helpers (`markProcessed`, `isProcessed`)
  - ID mapping helpers (`setMapping`, `getMapping`)
  - Suppression list helpers (`addToList`, `isInList`)
  - OAuth token storage (`storeTokens`, `getTokens`)
  - Campaign state CRUD
  - Health/heartbeat writes
  - Webhook audit stream writes (XADD)
- [x] Decide: how much of the Redis *logic* belongs in shared-utils vs. in each app?
  - Key schema builders: shared-utils (already decided)
  - Dedup helpers: shared-utils (generic pattern, used by middleware + potentially marketing)
  - ID mapping helpers: shared-utils (used by middleware, read by command center)
  - Suppression lists: `[DISCUSS]` shared-utils or marketing-specific?
  - Campaign state: marketing-specific (NOT shared-utils)
  - OAuth token storage: `[DISCUSS]` shared-utils or per-app? QB tokens are middleware-specific but the pattern is generic
- [x] Add `@upstash/redis` as dependency of `@aac/shared-utils`
- [x] Implement redis.ts — key schema (already done) + dedup + ID mapping helpers
- [x] Write Vitest tests (mocking Upstash Redis):
  - [x] Key builder output format correctness
  - [x] Dedup: mark → check → TTL expiry
  - [x] ID mapping: bidirectional set/get
  - [x] TTL constants match expected values
- [x] Verify: `pnpm turbo build` and `pnpm turbo test` pass

### 0.3 — @aac/shared-utils: Logger ✅ COMPLETE (2026-03-31)

- [x] Read aac-slim `src/lib/logger.ts` (99 lines)
- [x] Compare with our existing stub in `packages/shared-utils/src/logger.ts`
- [x] Decide: is our stub sufficient or does aac-slim's implementation have patterns we need?
- [x] Finalize logger implementation
- [ ] Write basic tests (structured output format, child logger context merging)
- [x] Verify build passes

### 0.4 — @aac/shared-utils: QStash Queue Helpers

- [ ] Read aac-slim `src/lib/queue.ts` (149 lines)
- [ ] Create `packages/shared-utils/src/queue.ts`
- [ ] Extract: `calculateDelay(index)`, `queueMessage()`, `batchQueue()`, `verifyQStashSignature()`
- [ ] Add `@upstash/qstash` as dependency
- [ ] Make functions accept config (QStash token, signing keys) as parameters, not env vars
- [ ] Write tests (delay calculation, signature verification)
- [ ] Add export to `packages/shared-utils/src/index.ts`
- [ ] Verify build passes

### 0.5 — @aac/shared-utils: Shared Types ✅ COMPLETE (2026-03-31)

- [x] Review our existing `packages/shared-utils/src/types.ts` stub
- [x] Cross-reference with aac-slim's actual data shapes:
  - [x] Read Pipedrive Person/Deal shapes from aac-slim client
  - [x] Read Quo Contact/Message shapes from aac-slim client
  - [x] Read QuickBooks Customer/Invoice shapes from aac-slim client
  - [x] Read Campaign/CampaignStats shapes from aac-slim Redis patterns
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` Start minimal, expand as consumers need them. Added QBOAuthTokens. Response types live in the client files, not shared-utils.
- [x] Finalize types.ts
- [x] Verify build passes (type-only, no runtime tests needed)

### 0.6 — @aac/api-clients: Pipedrive Client ✅ COMPLETE (2026-03-31)

- [ ] Read aac-slim `src/clients/pipedrive.ts` (537 lines)
- [x] Read aac-astro `api/leads.ts` — understand the website's simpler Pipedrive usage (create person only)
- [x] Read aac-slim `src/lib/env.ts` — extract Pipedrive config shape
- [x] Design PipedriveClient constructor config:
  ```typescript
  interface PipedriveConfig {
    apiKey: string;
    companyDomain: string;
    systemUserId?: string;  // For loop prevention
    referredByFieldKey?: string;  // Custom field
    leadSourceFieldKey?: string;  // Custom field
    quoContactIdFieldKey?: string;  // Custom field
    qbCustomerIdFieldKey?: string;  // Custom field
  }
  ```
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` Custom field keys hardcoded as constants on the class (`PIPEDRIVE_CROSS_SYSTEM_FIELDS`). Runtime discovery not needed.
- [x] Refactor: replace all `process.env` reads with `this.config.*`
- [x] Refactor: replace any direct `fetch()` with a private `this.request()` method that handles base URL, auth token, error handling, and logging
- [x] Preserve all existing methods:
  - [x] `searchPersonByPhone(phone)` — used by middleware (Quo webhook) AND website (lead dedup)
  - [x] `searchPersonByName(name)`
  - [x] `createPerson(data)` — used by middleware AND website
  - [x] `updatePerson(id, data)` — used by middleware (incremental updates)
  - [x] `getPerson(id)`
  - [ ] `createDeal(data)` — deferred (not used by simplified middleware)
  - [ ] `updateDeal(id, data)` — deferred (not used by simplified middleware)
  - [x] `logActivity(personId, type, data)` — call/SMS logging
  - [x] `createTask(data)`
  - [ ] `getReferralChain(personId)` — stripped (attribution engine)
  - [ ] `getPersonOwner(personId)` — stripped (attribution engine)
  - [x] `getOrganization(id)`
- [x] Import `normalizePhone` from `@aac/shared-utils/phone` for phone-based searches
- [x] Import `createLogger` from `@aac/shared-utils/logger`
- [x] Write Vitest tests (mocking fetch):
  - [x] Constructor validates required config
  - [x] Search by phone normalizes input before searching
  - [x] Create person sends correct payload shape
  - [x] Activity logging sends correct type codes
  - [x] Auth token is passed correctly in all requests
  - [x] Error handling: API errors, network errors, rate limits
- [x] Verify build passes

### 0.7 — @aac/api-clients: Quo (OpenPhone) Client ✅ COMPLETE (2026-03-31)

- [x] Read aac-slim `src/clients/quo.ts` (431 lines)
- [x] Design QuoConfig:
  ```typescript
  interface QuoConfig {
    apiKey: string;
    phoneNumber: string;
    webhookSecret?: string;
  }
  ```
- [x] Refactor: constructor-configured, no process.env
- [x] Preserve all methods:
  - [x] `createContact(data)`
  - [x] `updateContact(id, data)` — read-merge-write pattern
  - [x] `deleteContact(id)`
  - [x] `searchContactByPhone(phone)`
  - [x] `sendSMS(to, body)` — renamed to `sendMessage(to, text, from?)`
  - [ ] `createNote(contactId, content)` — deferred (not used by simplified middleware)
  - [ ] `getConversationHistory(phoneNumber)` — stripped (campaign dedup only)
  - [ ] `lookupPhoneNumberId(phoneNumber)` — stripped (campaign dedup only)
  - [x] `getCustomFieldDefinitions()`
- [x] Import phone normalization from shared-utils
- [x] Write Vitest tests
- [x] Verify build passes

### 0.8 — @aac/api-clients: QuickBooks Client ✅ COMPLETE (2026-03-31)

- [x] Read aac-slim `src/clients/quickbooks.ts` (397 lines)
- [x] Design QuickBooksConfig — the OAuth token management is the complex part:
  ```typescript
  interface QuickBooksConfig {
    clientId: string;
    clientSecret: string;
    realmId: string;
    redirectUri: string;
    getTokens: () => Promise<TokenSet>;
    saveTokens: (tokens: TokenSet) => Promise<void>;
  }
  ```
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` Token storage: callback pattern confirmed. Client accepts `getTokens`/`saveTokens` callbacks. Each app wires these to its own storage (middleware uses Redis).
- [x] Refactor: constructor-configured with token callbacks
- [x] Preserve: auto-refresh with 5-minute buffer, customer CRUD. Invoice queries stripped (attribution only).
- [x] Write Vitest tests
- [x] Verify build passes

### 0.9 — @aac/api-clients: SearchBug Client

- [ ] Read aac-slim `src/clients/searchbug.ts` (339 lines)
- [ ] Refactor: constructor-configured
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` SearchBug phone format conversion belongs in the client. Client accepts E.164 input, handles SearchBug format internally.
- [ ] Preserve: batch submission, exponential backoff polling, result filtering (DNC, TCPA, landline, inactive)
- [ ] Write Vitest tests
- [ ] Verify build passes

### 0.10 — @aac/api-clients: Gemini Client ✅ COMPLETE (2026-03-31)

- [x] Read aac-slim `src/clients/gemini.ts` (149 lines) — entity extraction only
- [x] Read aac-marketing-engine `src/lib/gemini.ts` (1,755 lines) — content generation, images, ideas
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` One `GeminiClient` class. Constructor takes API key. Entity extraction method first (middleware). Content generation + image methods added later for marketing. Marketing app constructs its own prompts; client handles API mechanics.
- [x] Design GeminiConfig and method surface
- [x] Implement: `extractEntities(text)` from aac-slim
- [ ] Implement: `generateContent(prompt, options)` as generic method that marketing app uses — deferred to Phase 4
- [ ] Implement: `generateImages(prompt, count, aspectRatio)` via Imagen API — deferred to Phase 4
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` Marketing-specific prompt engineering lives in the marketing app. Client provides generic `generateContent(prompt, options)` — app constructs prompts with brand context, platform constraints, etc.
- [x] Write Vitest tests
- [x] Verify build passes

### 0.11 — @aac/api-clients: Google Calendar Client

- [ ] Read aac-astro `scripts/lib/project-import-core.js` — understand the Calendar/Drive usage
- [ ] `[DISCUSS]` Auth model: aac-astro uses a shared OAuth2 client with stored tokens in `scripts/.credentials/`. The shared client needs to support:
  - OAuth2 with refresh token (most scripts)
  - Service account (CI environments)
  - How does this map to "constructor-configured"?
  ```typescript
  interface GoogleCalendarConfig {
    // Option A: Pre-authenticated OAuth2 client
    auth: OAuth2Client;
    // Option B: Credentials for the client to manage auth
    credentials: { clientId, clientSecret, refreshToken };
    // Option C: Service account JSON
    serviceAccountKey: object;
  }
  ```
- [ ] `[DISCUSS]` The `googleapis` npm package is heavy (171KB). aac-slim doesn't use it. Do we:
  - Use `googleapis` (what aac-astro uses) — heavier but handles auth complexity
  - Use raw `fetch()` (what aac-slim uses for its APIs) — lighter but more manual auth
  - Recommendation: Use `googleapis` for Google APIs. The auth complexity is real and the library handles token refresh, service accounts, etc.
- [ ] Add `googleapis` as dependency of `@aac/api-clients`
- [ ] Implement: `listEvents(calendarId, dateRange)`, `getEvent(calendarId, eventId)`
- [ ] Implement: photo download via Google Drive (currently in project-import-core.js)
- [ ] Write tests
- [ ] Verify build passes

### 0.12 — @aac/api-clients: Google Ads Client

- [ ] Read aac-astro `scripts/lib/google-ads-client.js` — REST-based GAQL client
- [ ] Note: This does NOT use the `googleapis` package — it uses raw fetch to `googleads.googleapis.com/v23`
- [ ] `[DISCUSS]` Auth requires: OAuth2 Bearer token + Developer Token + login-customer-id (MCC). Config shape:
  ```typescript
  interface GoogleAdsConfig {
    auth: OAuth2Client;  // For Bearer token
    developerToken: string;
    managerAccountId?: string;  // MCC login-customer-id
    customerId: string;
  }
  ```
- [ ] Implement: `executeGaql(customerId, query)` — the core method all scripts use
- [ ] Implement: `mutate(customerId, operations)` — for keyword/bid/asset changes
- [ ] Write tests
- [ ] Verify build passes

### 0.13 — @aac/api-clients: Google Analytics Client

- [ ] Read aac-astro `api/analytics-health.ts` — Vercel cron health check
- [ ] Read aac-astro analytics scripts — `ga4-report.js`, etc.
- [ ] Note: Uses raw fetch to `analyticsdata.googleapis.com/v1beta`
- [ ] `[DISCUSS]` Should this use `googleapis` package's analytics library or raw fetch?
- [ ] Implement: `runReport(propertyId, request)` — wraps the Data API
- [ ] Write tests
- [ ] Verify build passes

### 0.14 — @aac/api-clients: Google Search Console Client

- [ ] Read aac-astro `scripts/gsc-report.js` and related scripts
- [ ] Implement: `queryPerformance(siteUrl, request)`
- [ ] Write tests
- [ ] Verify build passes

### 0.15 — @aac/api-clients: Buffer Client (NEW — not in aac-slim)

- [ ] Read aac-astro `scripts/lib/buffer-client.js` — GraphQL API client
- [ ] Read aac-marketing-engine's simulated Buffer integration for expected interface
- [ ] `[DISCUSS]` Buffer uses a GraphQL API. Config:
  ```typescript
  interface BufferConfig {
    accessToken: string;
  }
  ```
- [ ] Implement: `getOrganizations()`, `getChannels()`, `createPost(data)`, `getScheduledPosts()`
- [ ] Include rate limiting logic (200ms min delay, exponential backoff on 429)
- [ ] Write tests
- [ ] Verify build passes

### 0.16a — @aac/api-clients: Google Business Profile Client (NEW)

- [ ] Read aac-astro `scripts/batch-post-gbp.js`
- [ ] `[DISCUSS]` Is this used enough to warrant its own client, or should it just be a method on a broader "Google" auth helper?
- [ ] Implement or defer based on discussion
- [ ] Write tests if implemented

### 0.16b — @aac/api-clients: Gmail Client (NEW)

- [ ] Design GmailConfig: `{ auth: GoogleAuth }` (uses shared Google OAuth from 0.17)
- [ ] Create `packages/api-clients/src/gmail.ts`:
  - [ ] `getRecentImportant(maxResults)` — fetch recent important/unread emails
  - [ ] `getUnreadCount()` — count of unread important emails
  - [ ] `getMessage(messageId)` — full message content
  - [ ] `getThread(threadId)` — conversation thread
- [ ] Add to `packages/api-clients/src/index.ts` barrel export
- [ ] Add to `packages/api-clients/package.json` exports map
- [ ] Write tests
- [ ] Verify build passes

### 0.17 — Google OAuth2 Shared Auth

- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` `@aac/shared-utils` exports a `createGoogleAuth(config)` factory. Each Google client's constructor accepts the auth client. Token storage is callback-based (same pattern as QB). Source: aac-astro `scripts/lib/project-import-core.js` `authorize()` function.
- [ ] Read aac-astro `scripts/lib/project-import-core.js` — extract `authorize()` (handles CLI, CI, local OAuth, service account)
- [ ] Create `packages/shared-utils/src/google-auth.ts`
- [ ] Design config: accept OAuth2 credentials OR service account key
- [ ] Export `createGoogleAuth(config)` factory returning authenticated client
- [ ] Token persistence via callbacks (same pattern as QuickBooks client)
- [ ] Handle both OAuth2 (interactive/refresh) and service account auth
- [ ] Handle credential file resolution (env vars → local files → error)
- [ ] Write tests
- [ ] Add export to `packages/shared-utils/src/index.ts`
- [ ] Verify build passes

### 0.18 — Phase 0 Integration Verification ✅ COMPLETE (2026-03-31)

- [ ] All packages build: `pnpm turbo build`
- [ ] All tests pass: `pnpm turbo test`
- [ ] Type-check passes: `pnpm turbo typecheck`
- [ ] Write a `scripts/smoke-test.ts` at repo root that imports from both packages and exercises key functions (phone normalization, key building, client construction)
- [ ] Verify smoke test passes
- [ ] Commit Phase 0 completion

---

## Phase 1: Command Center (Operational Cockpit)

**Goal:** Build the single place Matt opens every morning to understand the
state of the business. Not just middleware health — full business management
dashboard with configurable card categories.

**Risk level:** Low. Greenfield app, no production migration.

**Full spec:** `docs/command-center-spec.md`

**Build philosophy:** Ship incrementally. Scaffold the app, then build one
card at a time — each card pulls in only the clients it needs. No upfront
client blitz. A working dashboard with 3 real cards beats 7 half-built ones.

### 1.0 — Vision & Scope Definition ✅ COMPLETE (2026-03-31)

- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **What does Matt check every morning?** All of: business health (cash flow, invoices, estimates, scheduled jobs), to-do list, new leads, website/SEO/ads, middleware health, campaign stats, upcoming dates.
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **Auth model:** Simple password (single user). Upgrade path to multi-user later.
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **Mobile-first or desktop?** Desktop-first, responsive to mobile. Both need to work.
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **Framework:** Next.js 15 (App Router). Dashboard is 70%+ interactive, suits React. Shared design tokens with website via `packages/ui`.
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **Design system:** Tailwind + shadcn/ui. Shared Tailwind preset in `packages/ui`.
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **To-do storage:** Redis (same Upstash instance).
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **AI commitment detection:** Expand existing Quo webhook Gemini prompt.
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **Card system:** Show/hide + reorder. Not full drag-and-drop builder.
- [x] Define day-one feature set: All 7 card categories present (Business Pulse, Smart To-Do, New Leads, Website/SEO/Ads, Middleware Health, Marketing Campaigns, Important Dates).
- [x] Additional scope: Full-funnel attribution, Gmail monitoring, GSC data, approved estimate auto-flagging.
- [x] Write `docs/command-center-spec.md` capturing all decisions.
- [x] `[DECIDED 2026-04-01]` **Build order:** Incremental, card-by-card. Foundation → Middleware Health → Smart To-Do → Business Pulse → remaining cards as needed. API clients built just-in-time per card, not upfront.

### 1.1 — Client Dependencies (Just-In-Time)

API clients are built only when a card needs them. No upfront prerequisite phase.

| Card | Clients needed | Status |
|------|---------------|--------|
| Middleware Health | None (Redis only) | **Ready now** |
| Smart To-Do | None for MVP (Redis only), Gemini for AI detection | **Ready now** |
| Business Pulse | QuickBooksClient, PipedriveClient | **Ready now** (both done) |
| Business Pulse (jobs) | Google Calendar Client, Google OAuth | Build when adding job counts |
| New Leads | PipedriveClient | Ready (done) |
| Marketing Campaigns | None (Redis only) | Ready |
| Important Dates | PipedriveClient (done), Google Calendar Client | Build Calendar when needed |
| Website/SEO/Ads | GA4, GSC, Google Ads clients, Google OAuth | Build when starting this card |
| Full-Funnel Attribution | GA4 Client, QB + Pipedrive (done) | Build GA4 when starting |
| Gmail Monitoring | Gmail Client, Google OAuth | Build when starting |

**Remaining Phase 0 client tasks (deferred, not blocking):**
0.11 Google Calendar, 0.12 Google Ads, 0.13 GA4, 0.14 GSC, 0.15 Buffer,
0.16b Gmail (new), 0.17 Google OAuth. Each gets built when its card is ready.

---

### Phase 1A — Foundation

#### 1.2 — Shared Design System ✅ COMPLETE (2026-04-01)

- [x] Create `packages/ui/` package
- [x] Shared Tailwind preset (colors, typography, spacing matching AAC brand) — `tokens.css` with @theme
- [x] Export preset for consumption by apps — `@aac/ui/tokens.css`
- [x] Status indicator component (green/yellow/red dot + label)
- [x] Dashboard card wrapper component (title, status dot, content area, color-coded by status)
- [x] `cn()` utility (clsx + tailwind-merge)
- [x] Verify build passes

#### 1.3 — App Scaffold ✅ COMPLETE (2026-04-01)

- [x] Initialize `apps/command-center` as Next.js 15 App Router project
- [x] Add dependencies: next@15, react@19, tailwindcss@4, lucide-react, @aac/ui, @aac/shared-utils, @aac/api-clients, @upstash/redis
- [x] Set up tsconfig extending `@aac/tsconfig/nextjs.json`
- [x] Configure Tailwind v4 with shared preset from `@aac/ui/tokens.css`
- [x] Create root layout with route groups: `(auth)` and `(dashboard)`
- [x] Create sidebar navigation with all card sections + sign out
- [x] Create simple password auth (HMAC-signed cookie, 30-day session)
- [x] Create login page and logout API route
- [x] Create `/api/health` route (own heartbeat)
- [x] Create placeholder dashboard page with card grid
- [x] Self-hosted Inter + Space Grotesk fonts (copied from aac-astro)
- [x] Verify: `pnpm turbo build` passes, dev server starts and renders

---

### Phase 1B — Card: Middleware Health (first card) ✅ COMPLETE (2026-04-01)

**Why first:** Zero new clients needed. All data already flows into Redis
from the middleware. Fastest path to a real, working card on screen.

**Data sources:** Middleware `/api/health` endpoint (proxied server-side)

- [x] Create `app/api/health/middleware/route.ts` — proxies middleware health endpoint
- [x] Create shared status logic (`lib/middleware-status.ts`) — green/yellow/red based on:
  - [x] Recency of last processed webhook (>30m = yellow, >1h = red)
  - [x] Error count in last hour only (not total backlog)
- [x] Create Middleware Health card component:
  - [x] Color-coded status dot (green/yellow/red)
  - [x] Total events today + "last event Xm ago"
  - [x] Auto-polls every 30s
- [x] Create `/health` detail page:
  - [x] Per-source webhook counts (pipedrive, quo, google-ads) with last-processed timestamps
  - [x] Sync mapping counts (PD↔Quo, PD↔QB, Phone→PD)
  - [x] Error log (last 50) with source, message, details
  - [x] Consistent status indicator using shared logic
- [ ] Deploy to Vercel and verify with live Redis data

---

### Phase 1C — Card: Smart To-Do List (second card)

**Why second:** Immediately useful for daily operations. Redis-only for MVP,
AI commitment detection layers in later.

**Data sources:** Redis (to-do items), future: Gemini commitment detection from Quo webhook

- [ ] Add Redis key schema for to-dos in `@aac/shared-utils/redis`:
  - [ ] `keys.todo(todoId)` — individual to-do item
  - [ ] `keys.todoList` — sorted set of to-do IDs by due date
  - [ ] `keys.todoRecurring` — recurring task definitions
- [ ] Create `app/api/todos/route.ts` — CRUD API:
  - [ ] GET — list all pending to-dos, sorted by due date
  - [ ] POST — create new to-do (manual)
  - [ ] PATCH — update to-do (edit, complete, dismiss)
  - [ ] DELETE — remove to-do
- [ ] Create Smart To-Do card component:
  - [ ] Count of pending items + count overdue
  - [ ] Next 3 due items shown inline
  - [ ] Red highlight for overdue items
- [ ] Create `/todos` detail page:
  - [ ] Full to-do list with filters (pending/completed/all, manual/auto/recurring)
  - [ ] Add new to-do form (title, due date, notes)
  - [ ] Edit/complete/dismiss actions on each item
  - [ ] AI-detected items show source transcript excerpt + confidence badge
- [ ] Pre-populate recurring tasks:
  - [ ] Quarterly: Budget analysis and projections review
  - [ ] Monthly: Cost inventory and optimization check
  - [ ] Monthly: Review solicitation follow-up status
  - [ ] As-needed: Respond to new Google reviews

---

### Phase 1D — Card: Business Pulse (third card)

**Why third:** The most important card long-term, but needs the most data
sources. QB + Pipedrive clients are already done, so the core works now.
Google Calendar (scheduled jobs) can be added later.

**Data sources:** QuickBooks (invoices, estimates, cash flow) + Pipedrive (deal pipeline). Google Calendar (scheduled jobs) added when 0.11 is built.

- [ ] Create `app/api/financials/route.ts` — server-side data aggregation:
  - [ ] Query QB for outstanding invoices (unpaid, with aging)
  - [ ] Query QB for recent payments (last 30 days cash flow)
  - [ ] Query Pipedrive for deals in "Estimate Sent" stage (stale estimate detection)
  - [ ] Query Pipedrive for deals in "Estimate Accepted/Approved" stage — **high priority flag**
  - [ ] ~~Query Google Calendar for job count~~ → deferred until 0.11 Google Calendar Client
- [ ] Create Business Pulse card component:
  - [ ] Cash flow trend (positive/negative indicator)
  - [ ] Outstanding invoices count + total $
  - [ ] Stale estimates count (> 14 days in "Estimate Sent")
  - [ ] **Approved estimates needing scheduling** (count + total $, highlighted)
  - [ ] Jobs scheduled next 7 / next 30 days — placeholder until Calendar client ready
  - [ ] Green/yellow/red status based on thresholds
- [ ] Create `/financials` detail page:
  - [ ] Invoice list with aging (0-30, 30-60, 60-90, 90+ days)
  - [ ] Estimate pipeline funnel
  - [ ] Cash flow chart (date range selectable)
  - [ ] Approved estimates list with "Schedule" action links
- [ ] Auto-create to-do when estimate status changes to "Accepted":
  - [ ] Add Redis key schema for approved estimate tracking
  - [ ] Middleware or polling: detect QB estimate status changes
  - [ ] Create to-do item: "Schedule job for [customer] — Estimate #X ($Y)"

---

### Phase 1E — Remaining Cards (build as needed)

Each card below is independent. Build in any order based on what feels most
useful at the time. API clients get built just-in-time per card.

#### 1.5 — Card: New Leads

**Data sources:** Pipedrive (recent persons/deals), middleware health (webhook counts)

- [ ] Create `app/api/leads/route.ts`:
  - [ ] Fetch recent Pipedrive persons (last 24h, sorted by created date)
  - [ ] Fetch middleware webhook counts (Google Ads leads today)
  - [ ] Combine into lead activity summary
- [ ] Create New Leads card component:
  - [ ] Total new leads (24h)
  - [ ] Breakdown by source (Google Ads, inbound call, walk-in, referral)
- [ ] Create `/leads` detail page:
  - [ ] List of recent leads: name, phone, source, deal stage, date
  - [ ] Link to Pipedrive person (external)
  - [ ] Date range filter

#### 1.6 — Card: Marketing Campaigns

**Data sources:** Redis (campaign state + stats written by marketing engine or aac-slim)

- [ ] Create Marketing Campaigns card component:
  - [ ] Green/yellow/red status
  - [ ] Active campaign count + overall response rate
- [ ] Create `/campaigns` detail page:
  - [ ] Campaign list with stats per campaign
  - [ ] Drill into individual campaign (sent, delivered, responses, opt-outs)
- [ ] Note: This card shows data from Redis regardless of whether campaigns
  are managed by aac-slim or the future marketing engine

#### 1.7 — Card: Important Dates

**Data sources:** Pipedrive (business admin pipeline), Google Calendar, Redis (manual entries)

- [ ] Create `app/api/dates/route.ts`:
  - [ ] Query Pipedrive for business admin/renewal deals
  - [ ] Query Google Calendar for partnership events (when 0.11 ready)
  - [ ] Query Redis for manually added dates
- [ ] Create Important Dates card component:
  - [ ] Next 3 upcoming items with days-until-due
  - [ ] Red highlight for < 7 days
- [ ] Create `/calendar` detail page:
  - [ ] Calendar view of all upcoming dates
  - [ ] Add new date form (title, date, category, recurrence)
  - [ ] Categories: business renewal, partnership, seasonal, custom

#### 1.8 — Card: Website / SEO / Ads

**Data sources:** Google Analytics, Google Search Console, Google Ads
**Requires first:** 0.12 Google Ads Client, 0.13 GA4 Client, 0.14 GSC Client, 0.17 Google OAuth

- [ ] Build required Phase 0 clients (0.12, 0.13, 0.14, 0.17)
- [ ] Create `app/api/analytics/route.ts`:
  - [ ] GA4: sessions, users, bounce rate (7d vs prior 7d trend)
  - [ ] GA4: conversion events (phone_call_click, text_message_click)
  - [ ] GSC: impressions, clicks, avg position, top queries
  - [ ] Google Ads: spend, conversions, CPA
- [ ] Create Website/SEO/Ads card component:
  - [ ] Green/yellow/red status
  - [ ] Key numbers: sessions, ad spend, conversions
  - [ ] Trend arrows (up/down vs prior period)
- [ ] Create `/analytics` detail page:
  - [ ] Traffic chart with date range selector
  - [ ] Source/medium breakdown table
  - [ ] Landing page performance
  - [ ] Search Console: top queries, top pages, position trends
  - [ ] Google Ads: campaign performance, keyword breakdown, CPA trend
  - [ ] Comparison periods (this week vs last, this month vs last)

#### 1.8b — Lighthouse Cron Audit

**Source:** aac-astro `scripts/lighthouse-audit.js` (367 lines) — runs 3
Lighthouse audits per page, takes median scores, tracks CWV + failing audits.

- [ ] Move `lighthouse-audit.js` to `tools/lighthouse/audit.ts`
- [ ] Refactor to write results to Redis instead of local JSON file:
  - [ ] Add Redis key: `keys.lighthouseLatest` — most recent audit results
  - [ ] Add Redis key: `keys.lighthouseHistory(date)` — historical audit keyed by date
  - [ ] Add Redis sorted set: `keys.lighthouseRuns` — sorted set of run timestamps
  - [ ] History retention: keep all runs (no TTL)
  - [ ] Previous run comparison for diff
- [ ] Add regression detection (flag drops > 5 points, CWV regressions)
- [ ] Create cron job (GitHub Actions — Lighthouse needs Chrome)
- [ ] Command Center integration:
  - [ ] Website/SEO/Ads card reads `lighthouseLatest` from Redis
  - [ ] Shows scores, regression arrows, detail page with history

---

### Phase 1F — Enhancements (after core cards work)

#### 1.9 — Card Configuration System

- [ ] Create settings page (`/settings`):
  - [ ] Toggle cards visible/hidden
  - [ ] Reorder cards (move up/down)
- [ ] Persist card config in Redis (per-user key, future-proof for multi-user)
- [ ] Dashboard reads config and renders cards accordingly
- [ ] Default config shows all cards in logical order

#### 1.10 — AI Commitment Detection (Smart To-Do Auto-Generation)

**Depends on:** Middleware deployed, To-Do system (1C)

This expands the existing Quo webhook Gemini prompt to detect commitments.

- [ ] Design commitment extraction prompt:
  - [ ] Detect scheduling promises ("I'll schedule you for Thursday")
  - [ ] Detect follow-up promises ("I'll get back to you in two weeks")
  - [ ] Detect action promises ("Let me send you that estimate")
  - [ ] Extract: action, person name, due date/timeframe, confidence
- [ ] Add commitment detection to Quo webhook (`apps/middleware/api/webhooks/quo.ts`):
  - [ ] Second Gemini call after entity extraction (same text input)
  - [ ] Parse structured response into to-do item data
  - [ ] Write to-do item to Redis with `source: 'ai-detected'` and source context
- [ ] Add to-do key schema to `@aac/shared-utils/redis`
- [ ] Test with sample transcripts and messages
- [ ] Verify to-dos appear in Command Center dashboard

#### 1.11 — Full-Funnel Attribution Page

**Depends on:** GA4 client (built in 1.8), QB + Pipedrive clients (done)
**References:** aac-slim `src/lib/attribution.ts` (295 lines)

- [ ] Rebuild attribution engine logic:
  - [ ] Extract and adapt `runAttribution()` from aac-slim attribution.ts
  - [ ] Add `getPaidInvoices`, `getInvoice` methods back to QuickBooksClient
  - [ ] Add `getPersonReferredBy`, `getPipedriveUser`, `getPersonOwnerId` methods back to PipedriveClient
- [ ] Create `app/api/attribution/route.ts`:
  - [ ] Accept date range parameter
  - [ ] Fetch paid QB invoices → trace to Pipedrive person → walk referral chain
  - [ ] Correlate with GA4 session data
  - [ ] Include UTM source attribution
- [ ] Create `/attribution` detail page:
  - [ ] Per-job attribution view (full funnel)
  - [ ] Aggregated channel ROI
  - [ ] Date range + branch filter (MA vs CT)

#### 1.12 — Gmail Monitoring

**Depends on:** Gmail Client (0.16b), Google OAuth (0.17)

- [ ] Build 0.16b Gmail Client + 0.17 Google OAuth (if not yet done)
- [ ] Create `app/api/email/route.ts`:
  - [ ] Fetch recent important/unread emails
  - [ ] Detect lead-like emails
  - [ ] Correlate email senders with existing Pipedrive contacts
- [ ] Surface important emails as to-do items (`source: 'email'`)
- [ ] Create email detail view

---

### Phase 1G — Deploy & Polish

#### 1.13 — Deployment

- [ ] Create Vercel project `aac-command-center`
- [ ] Configure root directory to `apps/command-center`
- [ ] Set environment variables:
  - [ ] Redis URL/token (same Upstash as middleware)
  - [ ] Pipedrive API key
  - [ ] QuickBooks OAuth credentials
  - [ ] Google OAuth credentials (as needed per card)
  - [ ] Simple auth password (hashed)
  - [ ] Middleware health endpoint URL
- [ ] Deploy and verify
- [ ] Custom domain (e.g., `dashboard.attackacrack.com`)

Note: First deploy happens as part of 1B (Middleware Health card). This
section covers full production setup with all credentials.

#### 1.14 — Polish & Responsiveness

- [ ] Loading states for each card (skeleton loaders)
- [ ] Error states (card shows error message, doesn't break dashboard)
- [ ] Empty states (card shows helpful message when no data)
- [ ] Mobile responsive layout (cards stack vertically, sidebar collapses to hamburger)
- [ ] Auto-refresh on interval (30s for health, 5m for financials)
- [ ] Dark mode (optional, if easy with shadcn)

---

## Phase 2: Clean Middleware Extraction

**Goal:** Build a simplified `apps/middleware` from scratch, extracting only
the operational middleware core from aac-slim. No campaign code, no UI, no
attribution engine. Pure webhook-driven CRM sync + lead routing.

**Risk level:** Low-Medium. We're building fresh, not modifying production.
The old aac-slim stays running until this is verified.

**Runtime:** Plain Vercel Serverless Functions — no Next.js, no framework.
Each webhook handler is a standalone TypeScript file deployed as an independent
Lambda. This is the absolute simplest runtime for an API-only service.

**Decision (2026-03-31):** Changed from "Shadow Migration" (copy wholesale, then
strip) to "Clean Extraction" (build from scratch, pull only what's needed).
Rationale: cleaner result, no risk of campaign code leaking through, ~75%
smaller codebase (~3,000 lines vs ~16,000).

### 2.0 — What Stays in Middleware (DECIDED) ✅ COMPLETE (2026-03-31)

Based on the forensic analysis (aac-slim/03-domain-boundaries.md), these
decisions have been made:

**IN SCOPE — extract into `apps/middleware`:**
- [x] Pipedrive webhook (person.added/updated → sync to Quo + QB) — 425 lines, pure middleware
- [x] Quo webhook (call/message/transcript → log activity in Pipedrive + AI entity extraction) — stripped to ~515 lines
- [x] Google Ads webhook (lead form → create Pipedrive person + SMS alert + task) — 270 lines, lead routing
- [x] Health endpoint (webhook counts, error log, timestamps) — stripped to ~80 lines
- [x] QuickBooks OAuth routes (connect + callback) — minimal developer-facing flow
- [x] Webhook deduplication (Redis SET NX, 24h TTL)
- [x] ID mapping layer (Pipedrive ↔ Quo, Pipedrive ↔ QB, Phone → Pipedrive)
- [x] Loop prevention (created-by-us keys)
- [x] QB OAuth token storage/refresh via Redis
- [x] AI entity extraction from inbound messages/transcripts (Gemini)

**OUT OF SCOPE — NOT extracted (stays in aac-slim until rebuilt in Phase 4):**
- [x] ~~Campaign routes~~ (10 routes: create, send, stats, pause, archive, delete, draft, trigger-batch, process-batch, process-followups)
- [x] ~~Phone scrubbing routes~~ (3 routes: prefilter, scrub start, scrub status)
- [x] ~~Campaign Redis functions~~ (campaign state, variant tracking, suppression lists)
- [x] ~~Quo webhook campaign tracking block~~ (~55 lines stripped — see Phase 4.6 for rebuild plan)
- [x] ~~Attribution engine~~ (attribution.ts, referral chain traversal, commission calculation)
- [x] ~~CSV parser~~ (Property Radar import)
- [x] ~~Report generator~~ (commission reports)
- [x] ~~SearchBug client~~ (phone validation — campaign-only)
- [x] ~~QStash queue~~ (campaign message delivery)
- [x] ~~UI pages~~ (campaign list/new/detail, health dashboard, settings, login)
- [x] ~~Auth middleware~~ (login/logout — API-only service needs no auth UI)

**Previously `[DISCUSS]` — now resolved:**
- **Quo webhook split:** Strip campaign tracking block. Middleware publishes inbound message events to a Redis stream; marketing app subscribes and processes campaign logic (see Phase 4.6).
- **Campaign routes:** Go directly to `apps/marketing` in Phase 4. NOT copied to middleware.
- **UI pages:** Health dashboard → Command Center (Phase 1). Campaign UI → Marketing Engine (Phase 4). Middleware has zero UI.
- **Attribution engine:** Deferred. Will be rebuilt when needed — either in middleware (triggered by QB invoice webhook) or in Command Center (reporting). Not blocking for clean extraction.
- **Pre-migration cleanup:** The "Send Safety Layer" and "Dead Letter Queue" from aac-slim's TODO doc will be addressed as new features in the clean extraction, not backported to aac-slim.

### 2.1 — Scaffold Middleware App ✅ COMPLETE (2026-03-31)

- [x] Create `apps/middleware/package.json` — NO framework deps, just TypeScript + `@aac/api-clients`, `@aac/shared-utils`, `@upstash/redis`, `@vercel/node`
- [x] Create `apps/middleware/tsconfig.json` — extends `@aac/tsconfig/node.json`
- [x] Create `apps/middleware/vercel.json` — route mapping, runtime config (maxDuration, memory)
- [x] Create `apps/middleware/.env.example` — document all required env vars
- [x] Verify: `pnpm install` succeeds, workspace resolves correctly

### 2.2 — App Infrastructure (lib/) ✅ COMPLETE (2026-03-31)

- [x] Create `apps/middleware/lib/env.ts` — adapted from aac-slim's env.ts, stripped of campaign config (no qstash, no searchbug)
- [x] Create `apps/middleware/lib/clients.ts` — factory that bridges env vars to constructor-configured clients (lazy singletons for Pipedrive, Quo, QuickBooks, Gemini)
- [x] Create `apps/middleware/lib/redis.ts` — operational Redis layer (dedup, ID mappings, loop prevention, QB OAuth, health tracking). Imports key schema from `@aac/shared-utils/redis`.

### 2.3 — Extract Webhook Handlers ✅ COMPLETE (2026-03-31)

Each handler is converted from Next.js App Router (`export async function POST(req: Request)`)
to plain Vercel function (`export default async function handler(req: VercelRequest, res: VercelResponse)`).

- [x] `api/webhooks/pipedrive.ts` — from aac-slim `app/api/webhooks/pipedrive/route.ts` (425 lines). Pure middleware, no stripping needed. Refactor imports to use `@aac/api-clients` and `@aac/shared-utils`.
- [x] `api/webhooks/quo.ts` — from aac-slim `app/api/webhooks/quo/route.ts` (571→~515 lines). Strip the "CAMPAIGN RESPONSE TRACKING (Module 3)" block (~lines 438-494). Remove: `findCampaignForPhone`, `incrementCampaignStats`, `incrementVariantStats`, `isOptOutMessage`, `markRecipientResponded`. Keep: signature verification, dedup, activity logging, AI entity extraction.
- [x] `api/webhooks/google-ads.ts` — from aac-slim `app/api/webhooks/google-ads/route.ts` (270 lines). Lead routing: creates Pipedrive person, creates follow-up task, sends SMS alert. Clean extraction.
- [x] `api/health.ts` — from aac-slim `app/api/health/route.ts` (178→~153 lines). Strip: campaign metrics, QStash status, global settings. Keep: webhook counts, timestamps, error log, version, heartbeat.
- [x] `api/auth/quickbooks/connect.ts` — from aac-slim `api/auth/quickbooks/connect.ts`. Already a Vercel function. Minimal refactoring.
- [x] `api/auth/quickbooks/callback.ts` — from aac-slim `api/auth/quickbooks/callback.ts`. Refactor Redis calls to use app's operational Redis layer.

### 2.4 — Testing ✅ COMPLETE (2026-03-31)

- [x] Unit tests for each webhook handler (mock clients + Redis) — 20 tests across 3 test files
- [x] Test deduplication behavior
- [ ] Test Quo webhook signature verification — deferred (requires raw body stream mocking)
- [x] Test Google Ads google_key verification
- [x] Verify no campaign code present (grep for campaign-specific imports) — audit passed clean
- [x] Verify no direct `fetch()` calls to external APIs (all through `@aac/api-clients`) — one exception: QB OAuth callback token exchange (correct)
- [x] Verify: `pnpm turbo build` passes
- [x] Verify: `pnpm turbo typecheck` passes with zero errors
- [x] Verify: `pnpm turbo test` passes — 100 tests total (41 shared-utils + 39 api-clients + 20 middleware)

### 2.5 — Vercel Deployment ✅ COMPLETE (2026-04-01)

- [x] Create new Vercel project: `aac-middleware-monorepo`
- [x] Configure root directory to `apps/middleware`
- [x] Set all environment variables (15 vars copied from aac-slim via Vercel CLI)
- [x] Deploy and verify health endpoint responds
- [x] Test each webhook endpoint with sample payloads
- [x] Fix: Vercel `bodyParser: false` not respected in monorepo — switched Quo
  webhook to Web Standard API handler (`export async function POST(request: Request)`)
  for raw body access needed by HMAC signature verification
- [x] Fix: OpenPhone webhook secret is per-URL — updated `QUO_WEBHOOK_SECRET`
  with new secret from OpenPhone dashboard
- [x] Fix: QB token storage was double-serializing with `JSON.stringify` —
  switched to Upstash auto-serialization (pass object directly to `redis.set`)

### 2.6 — The Switch ✅ COMPLETE (2026-04-01)

- [x] Verify monorepo middleware is deployed and responding to health checks
- [x] Swap webhook URLs in OpenPhone/Quo to point to new middleware URL
- [x] Swap webhook URLs in Pipedrive to point to new middleware URL
- [x] Swap webhook URL in Google Ads to point to new middleware URL
- [x] Re-authorize QuickBooks OAuth via new middleware URL
- [x] Add new redirect URI to Intuit Developer Portal
- [x] End-to-end test: inbound SMS → Pipedrive person created → activity logged →
  AI entity extraction → name updated → QB customer synced → QB link + address
  enriched back to Quo contact
- [x] Keep old aac-slim Vercel project running (but no longer receiving webhooks)
- [x] Rollback reference doc saved: `docs/middleware-cutover-rollback.md`

**Production URL:** `https://aac-middleware-monorepo.vercel.app`

### 2.7 — Bake Period (7 days) — IN PROGRESS (started 2026-04-01)

- [ ] Day 1 (Apr 1): Active monitoring — check every few hours
- [ ] Day 2-3 (Apr 2-3): Normal monitoring — check daily
- [ ] Day 4-7 (Apr 4-7): Passive monitoring — check health endpoint
- [ ] Verify: no missed webhooks, no dedup failures, no sync errors
- [ ] If issues: roll back by re-pointing webhook URLs to old aac-slim

### 2.8 — Decommission (after 2026-04-08)

- [ ] Archive aac-slim repo as read-only
- [ ] Delete old Vercel project (or keep for reference, no cost if no traffic)
- [ ] Update root CLAUDE.md to mark middleware migration as complete

---

## Phase 3: Storefront Migration

**Goal:** Move aac-astro into `apps/website`, extract operational scripts
to `tools/`, re-plumb CI/CD.

**Risk level:** Medium-High. Complex CI/CD pipeline, 320+ content pieces,
live production site. DNS cutover is the scariest moment.

### 3.0 — Pre-Migration Preparation

- [ ] Read aac-astro forensic analysis `03-monorepo-migration-plan.md` for the detailed plan
- [ ] Verify all scripts are categorized (from `01-script-inventory.md`):
  - 12 scripts STOREFRONT (validation + dev tooling) — stay
  - 11 scripts TOOLS/analytics — move
  - 7 scripts TOOLS/google-ads — move
  - 8 scripts TOOLS/content-import — move
  - 2 scripts TOOLS/social — move
  - 4 scripts ARCHIVE — discard

### 3.1 — Copy Astro Site

- [ ] Copy aac-astro source into `apps/website/`:
  - `src/` (pages, components, content, layouts, utils, plugins, styles)
  - `public/` (images — this is 255MB, `[DISCUSS]` do we want this in git?)
  - `api/` (Vercel serverless functions — leads.ts, analytics-health.ts)
  - Config files: `astro.config.mjs`, `tailwind.config.*`, `package.json`
  - Validation scripts that stay (8 scripts)
  - Dev tooling scripts (4 scripts)
  - `data/` (import manifests)
- [ ] Do NOT copy:
  - Operational scripts (31 scripts → tools/)
  - `scripts/.credentials/` (these go to monorepo root or env vars)
  - `node_modules/`, `dist/`, `.astro/`
  - `docs/` (stays in archived repo for reference)
- [ ] Update `apps/website/package.json`:
  - Add `@aac/api-clients` and `@aac/shared-utils` as workspace dependencies
  - Remove `googleapis` and `@google/generative-ai` (only used by extracted scripts)

### 3.2 — Refactor API Calls

- [ ] `api/leads.ts`: Replace direct Pipedrive fetch with `@aac/api-clients` PipedriveClient
- [ ] `api/analytics-health.ts`: Replace direct GA4 fetch with `@aac/api-clients` GoogleAnalyticsClient
- [ ] Any content import cron that stays in website: use `@aac/api-clients` GoogleCalendarClient

### 3.3 — Extract Scripts to tools/

- [ ] Move analytics scripts (11) to `tools/analytics/`
- [ ] Move Google Ads scripts (7) to `tools/google-ads/`
- [ ] Move content import scripts (8) to `tools/content-import/`
- [ ] Move social scripts (2) to `tools/social/`
- [ ] Refactor each script to import from `@aac/api-clients` instead of local lib files
- [ ] Handle the `project-import-core.js` decomposition:
  - `authorize()` function → `@aac/shared-utils` or `@aac/google-auth` helper
  - Calendar event fetching → `@aac/api-clients/google-calendar`
  - Drive photo download → `@aac/api-clients/google-calendar` (or separate Drive client)
  - Gemini photo classification → `@aac/api-clients/gemini`
  - Markdown generation → stays in content-import script (app-specific logic)
- [ ] Update `tools/package.json` with needed dependencies
- [ ] Verify each script runs independently

### 3.4 — Re-Plumb CI/CD

- [ ] Adapt `.github/workflows/quality.yml` for monorepo structure:
  - Update working directory references
  - Update `npm run validate` to work within Turborepo
  - Ensure build step uses `pnpm turbo build --filter=@aac/website`
- [ ] Adapt pre-commit hooks:
  - Validation scripts need updated paths
  - `npm run validate` → `pnpm --filter @aac/website run validate`
- [ ] Adapt Lighthouse CI (`lighthouserc.cjs`):
  - Update URLs if staging domain changes
  - Verify thresholds still work
- [ ] Adapt content import cron (GitHub Actions or Vercel Cron):
  - Update to run from `tools/content-import/` directory
  - Verify Google OAuth credentials are accessible

### 3.5 — Vercel Deployment

- [ ] Create new Vercel project for website within monorepo
- [ ] Configure root directory to `apps/website`
- [ ] Set all environment variables (mirror from current aac-astro Vercel project)
- [ ] Configure Vercel's "Ignored Build Step" to only rebuild when website files change
- [ ] Deploy to staging domain and verify:
  - [ ] Homepage renders correctly
  - [ ] Blog posts render
  - [ ] Location pages render
  - [ ] Lead form submits correctly
  - [ ] SEO validation passes
  - [ ] Lighthouse scores meet thresholds

### 3.6 — DNS Cutover

- [ ] Verify staging site is fully functional
- [ ] Schedule cutover during low-traffic period
- [ ] Update DNS to point to new Vercel project
- [ ] Verify site is live on `www.attackacrack.com`
- [ ] Monitor for 404s, broken links, missing images

### 3.7 — Bake Period and Decommission

- [ ] 7 days of monitoring
- [ ] Archive aac-astro repo as read-only
- [ ] Delete old Vercel project

---

## Phase 4: Marketing Engine

**Goal:** Build the marketing engine fresh within the monorepo, consuming
shared packages from day one. Informed by gate docs and specs from the
archived aac-marketing-engine repo.

**Risk level:** Low. Greenfield build, no migration.

### 4.0 — Vision & Scope Definition

- [ ] `[DISCUSS]` **What's the MVP?** The gate docs define a massive scope. What do we build first?
  - Option A: Content production pipeline first (ideas → posts → approval → Buffer)
  - Option B: SMS campaign manager first (CSV import → scrub → send — this exists in aac-slim)
  - Option C: Both, but minimal — ideas + send, no approval workflow
  - `[DISCUSS]` Which delivers the most value soonest?
- [ ] `[DISCUSS]` **Data layer:** The marketing engine spec used SQLite/Prisma. Our meta-architecture says it "may use its own local data store." But:
  - SQLite doesn't work well on Vercel (serverless, no persistent filesystem)
  - Options: Turso (SQLite edge), Postgres (Neon/Supabase), or Redis-only
  - `[DISCUSS]` What's the right choice for the monorepo context?
- [ ] `[DISCUSS]` **SMS campaigns:** These currently live in aac-slim. During Phase 2, we may have pulled them out. Do they go here?
- [x] ~~`[DISCUSS]`~~ `[DECIDED 2026-03-31]` **Quo webhook campaign tracking:** Stripped from middleware. Rebuilt as separate marketing webhook/subscriber. See section 4.4 for full plan.
- [ ] Review and adopt from archived specs:
  - [ ] Copy `features.json` (48 features) as the backlog
  - [ ] Copy `brand-profile-attack-a-crack.md` as real client data
  - [ ] Copy Gate 1 (problem discovery) and Gate 4 (edge cases)
  - [ ] Review Gate 3 (tech plan) for data model reference
- [ ] Write `docs/marketing-engine-spec.md` with updated scope decisions

### 4.1 — App Scaffold

- [ ] Initialize `apps/marketing` as Next.js app (version TBD — `[DISCUSS]` 15? 16?)
- [ ] Set up database (based on data layer discussion above)
- [ ] Add dependencies: framework, `@aac/api-clients`, `@aac/shared-utils`, ORM, etc.
- [ ] Basic layout, auth, health check

### 4.2 — Content Production Pipeline (if chosen as MVP)

- [ ] Idea generation (Gemini via `@aac/api-clients`)
- [ ] Idea review UI (approve/iterate/replace/reject)
- [ ] Post creation from approved idea
- [ ] Platform variant generation (4 platforms)
- [ ] Caption approval workflow
- [ ] Image generation (Gemini Imagen via `@aac/api-clients`)
- [ ] Image approval workflow
- [ ] Version history and restore
- [ ] Calendar view for scheduling
- [ ] Buffer integration (real, not simulated) via `@aac/api-clients`
- [ ] Campaign results → Redis for Command Center visibility
- [ ] Quality tracking (rejection reasons, threshold alerts)

### 4.3 — SMS Campaign Manager (if chosen as MVP or added after content)

- [ ] CSV import (PropertyRadar format)
- [ ] Phone scrubbing via `@aac/api-clients` SearchBugClient
- [ ] Campaign creation with A/B testing
- [ ] Message queuing via QStash (from `@aac/shared-utils/queue`)
- [ ] Sending via `@aac/api-clients` QuoClient
- [ ] Opt-out handling
- [ ] Campaign stats → Redis for Command Center
- [ ] Business hours enforcement
- [ ] Daily limit enforcement

### 4.4 — Campaign Response Webhook (Stripped from Middleware Quo Webhook)

The middleware's Quo webhook was stripped of ~55 lines of campaign response
tracking during Phase 2 clean extraction. This logic needs to be rebuilt as
part of the marketing engine's inbound message handling.

**Architecture:** The middleware Quo webhook publishes inbound message events
to a Redis stream (`logs:inbound-messages` or similar). The marketing app
subscribes to this stream and processes campaign-related logic.

**Stripped logic to rebuild:**
- [ ] Opt-out detection (`isOptOutMessage` with `OPT_OUT_KEYWORDS` list)
- [ ] Global opt-out list management (`addOptOut`, `isOptedOut`)
- [ ] Campaign phone lookup (`findCampaignForPhone` — check if inbound phone matches any active campaign)
- [ ] Campaign response counting (`incrementCampaignStats` — increment response count)
- [ ] A/B variant tracking (`incrementVariantStats` — attribute response to correct variant)
- [ ] Recipient marking (`markRecipientResponded` — prevent follow-up sends)
- [ ] "Ever-messaged" tracking (`addToEverMessaged`, `wasEverMessaged`)

**Implementation options (to be decided during Phase 4 planning):**
- Option A: Marketing app has its own Quo webhook endpoint (Quo sends to both middleware + marketing)
- Option B: Middleware publishes to Redis stream, marketing subscribes via polling/cron
- Option C: Middleware forwards relevant events to marketing app via HTTP

**Source reference:** aac-slim `app/api/webhooks/quo/route.ts` lines 438-494

### 4.5 — Brand Profile System

- [ ] Markdown-based brand profile (reuse from marketing engine spec)
- [ ] Parser (reuse patterns from aac-marketing-engine)
- [ ] `[DISCUSS]` Does brand profile belong in `@aac/shared-utils` since multiple apps might use it? Or is it marketing-specific?

### 4.6 — Deployment

- [ ] Create Vercel project `aac-marketing`
- [ ] Configure root directory, env vars
- [ ] Deploy and verify
- [ ] `[DISCUSS]` Custom domain?

---

## Cross-Phase: Tools Migration

**Goal:** Migrate the 43+ operational scripts from aac-astro into `tools/`,
refactored as thin wrappers over `@aac/api-clients`.

**Timing:** Primarily during Phase 3, but can be done incrementally.

### T.1 — Analytics Scripts (11 scripts, ~5,600 lines)

- [ ] `ga4-report.js` → `tools/analytics/ga4-report.ts` (uses GoogleAnalyticsClient)
- [ ] `ga4-content-roi.js` → refactor
- [ ] `ga4-city-performance.js` → refactor
- [ ] `ga4-ct-vs-ma.js` → refactor
- [ ] `weekly-report.js` → refactor
- [ ] `monthly-report.js` → refactor
- [ ] `content-decay-alert.js` → refactor
- [ ] `conversion-journeys.js` → refactor
- [ ] `gsc-report.js` → refactor (uses GoogleSearchConsoleClient)
- [ ] `track-positions.js` → refactor
- [ ] `search-to-conversion.js` → refactor

### T.2 — Google Ads Scripts (7 scripts, ~3,300 lines)

- [ ] `google-ads-report.js` → `tools/google-ads/report.ts` (uses GoogleAdsClient)
- [ ] `google-ads-keywords.js` → refactor
- [ ] `google-ads-bids.js` → refactor
- [ ] `google-ads-assets.js` → refactor
- [ ] `google-ads-negatives.js` → refactor
- [ ] `google-ads-sitelinks.js` → refactor
- [ ] `google-ads-callouts.js` → refactor

### T.3 — Content Import Scripts (8 scripts, ~3,100 lines)

- [ ] `import-calendar-projects.js` → `tools/content-import/import-projects.ts`
- [ ] `cron-import-projects.js` → refactor
- [ ] `audit-photo-counts.js` → refactor
- [ ] `backfill-photo-ids.js` → refactor
- [ ] `fix-placeholder-projects.js` → refactor
- [ ] `generate-blog-images.js` → refactor (uses GeminiClient)
- [ ] `audit-image-diversity.js` → refactor
- [ ] `optimize-images.js` → `[DISCUSS]` this uses Sharp, not an API client. Does it still belong in tools?

### T.4 — Social Scripts (2 scripts, ~1,150 lines)

- [ ] `buffer-post-projects.js` → `tools/social/buffer-post.ts` (uses BufferClient)
- [ ] `batch-post-gbp.js` → `tools/social/gbp-post.ts` (uses GBP client)

### T.5 — Tools CI/CD

- [ ] `[DISCUSS]` How are tools invoked? Options:
  - `pnpm --filter @aac/tools run analytics:ga4-report`
  - `npx tsx tools/analytics/ga4-report.ts`
  - GitHub Actions scheduled workflows
  - Vercel Cron (but tools aren't a web app)
- [ ] Set up the invocation pattern
- [ ] Verify all scripts run successfully

---

## Ongoing: Infrastructure & Governance

### I.1 — ESLint Configuration

- [ ] Root ESLint config with shared rules
- [ ] `no-restricted-imports` rule blocking direct fetch to known API domains from `apps/`
- [ ] Per-app ESLint overrides where needed (Astro, Next.js)
- [ ] `[DISCUSS]` Custom ESLint rule or `no-restricted-syntax` with AST selectors for the fetch blocking?

### I.2 — CI/CD Pipeline

- [ ] GitHub Actions workflow for the monorepo:
  - On PR: `pnpm turbo build test typecheck lint` (affected packages only)
  - On merge to main: Deploy affected apps to Vercel
- [ ] Vercel "Ignored Build Step" configuration per app
- [ ] `[DISCUSS]` Branch strategy: trunk-based (merge to main) or feature branches?

### I.3 — Vercel Project Configuration

- [ ] `aac-command-center` Vercel project (Phase 1)
- [ ] `aac-monorepo-middleware` Vercel project (Phase 2)
- [ ] `aac-website` Vercel project (Phase 3)
- [ ] `aac-marketing` Vercel project (Phase 4)
- [ ] Each project: root directory, build command, env vars, domain

### I.4 — Documentation Maintenance

- [ ] Keep `docs/meta-architecture.md` updated as decisions are made
- [ ] Update per-directory CLAUDE.md files as apps are populated
- [ ] Keep this MASTER-PLAN.md updated as tasks are completed
- [ ] `[DISCUSS]` Should we move forensic analysis docs into this repo's `docs/`?

### I.5 — Monitoring & Alerting

- [ ] Command Center heartbeat monitoring (Phase 1)
- [ ] Webhook audit trail (Phase 1)
- [ ] `[DISCUSS]` External uptime monitoring? (e.g., Better Uptime, Vercel built-in)
- [ ] `[DISCUSS]` Error tracking? (e.g., Sentry)
- [ ] `[DISCUSS]` Log aggregation beyond structured JSON?

---

## Summary of All [DISCUSS] Items

These need resolution before or during the relevant phase:

### Phase 0 (Before Extraction)
1. SearchBug format conversion: client or shared-utils?
2. International phone numbers: handle or reject?
3. Redis logic split: what's shared vs. app-specific?
4. OAuth token storage pattern: callback-based?
5. Custom Pipedrive field keys: config or runtime discovery?
6. Gemini client: one class or two? Where does prompt engineering live?
7. Google OAuth2 shared auth: shared-utils, separate package, or per-client?
8. `googleapis` npm package: use it or raw fetch?
9. Google Business Profile: own client or not?
10. Shared types granularity: minimal or full?
11. Suppression lists: shared-utils or marketing-specific?

### Phase 1 (Command Center)
12. What does Matt check every morning?
13. What "Approve" actions exist?
14. Auth model for dashboard
15. Mobile-first or desktop?
16. Day-one feature set validation
17. Custom domain for dashboard
18. Design system choice

### Phase 2 (Middleware)
19. Pre-migration aac-slim improvements: before or during?
20. Quo webhook split: how to separate operational vs. marketing logic?
21. Campaign routes: straight to marketing or temporary in middleware?
22. UI pages: where do they go?
23. Attribution engine: middleware-specific or shared?
24. Sandbox environments available?

### Phase 4 (Marketing)
25. MVP scope: content production, SMS campaigns, or both?
26. Data layer: Turso, Postgres, Redis-only?
27. SMS campaign migration from middleware
28. Brand profile: shared or marketing-specific?
29. Custom domain for marketing app
30. Next.js version for marketing app

### Cross-Phase
31. Tools invocation pattern
32. ESLint fetch-blocking implementation
33. Branch strategy
34. External monitoring
35. Error tracking
36. Forensic docs location
