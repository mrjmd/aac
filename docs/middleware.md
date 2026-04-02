# Middleware — Operations Brain

**Status:** Deployed to production (2026-04-01), in 7-day bake period
**Location:** `apps/middleware/`
**Runtime:** Plain Vercel Serverless Functions (no framework)
**Predecessor:** `aac-slim` (standalone repo, currently running production)

---

## What It Does Today

The middleware is the real-time integration layer between AAC's external systems.
It receives webhook events and synchronizes data across Pipedrive (CRM),
Quo/OpenPhone (telephony), QuickBooks (accounting), and Google Ads (lead capture).

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/webhooks/pipedrive` | POST | Receives Pipedrive person events, syncs to Quo + QuickBooks |
| `/api/webhooks/quo` | POST | Receives call/SMS events, logs activities in Pipedrive, extracts entities via AI |
| `/api/webhooks/google-ads` | POST | Receives Google Ads lead form submissions, creates Pipedrive person + follow-up task + SMS alert |
| `/api/health` | GET | Returns operational metrics (webhook counts, sync mappings, errors, heartbeat) |
| `/api/auth/quickbooks/connect` | GET | Initiates QuickBooks OAuth flow |
| `/api/auth/quickbooks/callback` | GET | Completes QuickBooks OAuth flow, stores tokens in Redis |

### Pipedrive Webhook (`/api/webhooks/pipedrive`)

**Triggers:** `person.added`, `person.updated`

When a person is created or updated in Pipedrive:

1. **Deduplication** — Checks Redis to skip already-processed events (24h TTL)
2. **Phone validation** — Extracts primary phone, normalizes to E.164
3. **Phone mapping** — Stores phone → Pipedrive ID in Redis for fast lookups
4. **Data fetch** — Gets company name (from org), job title (from custom field), email, address
5. **Parallel sync to Quo:**
   - Checks Redis cache for existing Quo contact ID
   - Falls back to Pipedrive custom field for mapping recovery
   - If mapped: updates existing Quo contact
   - If not mapped: searches Quo by phone → links if found, creates if not
   - Stores bidirectional ID mapping (Pipedrive ↔ Quo)
   - Writes Quo contact ID to Pipedrive custom field for durability
6. **Parallel sync to QuickBooks:**
   - Checks if QB is connected (valid OAuth tokens)
   - Same mapping logic as Quo (Redis cache → Pipedrive field → search → create)
   - Stores bidirectional ID mapping (Pipedrive ↔ QB)
7. **Quo enrichment** — Adds QuickBooks link URL and formatted address as Quo custom fields
8. **Health tracking** — Increments webhook count, updates last-processed timestamp

**Fail-safe:** Always returns 200 to Pipedrive, even on errors. Errors are logged
to Redis for the health endpoint.

### Quo Webhook (`/api/webhooks/quo`)

**Triggers:** `call.completed`, `message.received`, `message.delivered`, `call.transcript.completed`

When a call or SMS event occurs in Quo/OpenPhone:

1. **Signature verification** — HMAC-SHA256 with base64-encoded secret
2. **Deduplication** — Redis SET NX
3. **Phone extraction** — Extracts the remote (external) phone number:
   - Incoming: `from` number
   - Outgoing: `to` number
   - Transcripts: dialogue entries without userId (external caller)
4. **Find or create Pipedrive person:**
   - Check Redis phone cache → search Pipedrive → create "Unknown Lead" if not found
5. **Activity logging:**
   - **Calls:** Subject includes direction + duration, note includes recording/voicemail URLs
   - **SMS:** Subject includes truncated message, note includes full message
   - **Transcripts:** Formats dialogue with speaker labels (AAC vs Caller)
6. **AI entity extraction** (for inbound messages and transcripts):
   - Checks if content is worth processing (inbound, >10 chars)
   - Sends to Gemini for entity extraction (name, email, address)
   - Incrementally updates Pipedrive person (only fills empty fields, never overwrites)
   - Only updates name if current name matches "Unknown Lead" pattern
7. **Health tracking**

**What was stripped (lives in future marketing app):** Campaign response tracking
(opt-out detection, response counting, variant tracking). See MASTER-PLAN Phase 4.4.

### Google Ads Webhook (`/api/webhooks/google-ads`)

**Triggers:** Google Ads lead form submission

When someone submits a lead form on a Google Ads campaign:

1. **Google key verification** — Validates `google_key` matches configured secret
2. **Deduplication** — Skipped for test leads (Google reuses test IDs)
3. **Data extraction** — Name, phone, email, city from `user_column_data`
4. **Find or create Pipedrive person** — Search by phone first, create if not found
   - Updates "Unknown Lead" names with real names if person already exists
5. **Create follow-up task** — "Google Ads Lead - Call {name}" with campaign details
6. **SMS alert** — Sends notification to configured alert phone number via Quo
   - Includes `[TEST]` prefix for test leads

### Health Endpoint (`/api/health`)

Returns JSON with:
- **Webhook counts** — Today + yesterday per source (pipedrive, quo, google-ads)
- **Last processed timestamps** — Per source
- **Sync mapping counts** — Approximate counts of PD↔Quo, PD↔QB, Phone→PD mappings
- **Recent errors** — Last 50 from Redis error log
- **Heartbeat** — Writes middleware heartbeat timestamp on each call
- **Version** — Code version string for deployment verification

### QuickBooks OAuth (`/api/auth/quickbooks/connect` + `callback`)

Developer-facing OAuth flow:
- `connect` redirects to QuickBooks authorization page
- `callback` exchanges auth code for tokens, stores in Redis
- Tokens auto-refresh via the QuickBooks client (5-minute buffer before expiry)

---

## Architecture

```
External Systems          Middleware (Vercel Functions)        Shared State
─────────────────         ──────────────────────────          ────────────

Pipedrive CRM ──webhook──→ /api/webhooks/pipedrive ──→ Sync to Quo + QB
                                    │
Quo/OpenPhone ──webhook──→ /api/webhooks/quo ──→ Log activity in Pipedrive
                                    │              Extract entities (Gemini)
Google Ads    ──webhook──→ /api/webhooks/google-ads ──→ Create lead + alert
                                    │
                                    ├──→ Upstash Redis (dedup, mappings,
                                    │     health counters, QB tokens)
                                    │
Command Center ──reads──→ /api/health ──→ Metrics from Redis
```

### Key Patterns

- **Deduplication:** Every webhook uses `SET NX` with 24h TTL. Event ID format
  varies by source (Pipedrive: `webhookId-eventId-timestamp`, Quo: event ID,
  Google Ads: lead ID).
- **ID Mapping:** Bidirectional Redis keys with 7-day TTL. Backed by Pipedrive
  custom fields for durability (if Redis key expires, mapping recovers from
  Pipedrive on next event).
- **Loop Prevention:** When middleware creates a Pipedrive person (from Quo webhook),
  the Pipedrive webhook fires. Both handlers search-before-create, so duplicates
  are naturally prevented.
- **Fail Safe:** All webhook handlers return 200 regardless of processing outcome.
  Errors are logged to Redis and surfaced via the health endpoint.

### Dependencies

| Package | Purpose |
|---------|---------|
| `@aac/api-clients` | Pipedrive, Quo, QuickBooks, Gemini clients (class-based, constructor-configured) |
| `@aac/shared-utils` | Phone normalization, Redis key schema, logger, shared types |
| `@upstash/redis` | Serverless Redis client |
| `@vercel/node` | Vercel function types |

---

## Deployment

**Completed:** 2026-04-01
**Production URL:** `https://aac-middleware-monorepo.vercel.app`
**Vercel project:** `aac-middleware-monorepo`
**Old middleware:** `aac-middleware` (still running as fallback, no webhooks pointing to it)

### Cutover Notes

- Quo webhook uses Web Standard API handler (`export POST`) instead of default
  export, because Vercel's `bodyParser: false` config isn't respected in this
  monorepo. This gives `request.text()` for raw body HMAC verification.
- OpenPhone generates a unique webhook signing secret per URL. Secret must be
  updated when the webhook URL changes.
- Upstash Redis auto-serializes objects — don't double-serialize with JSON.stringify.

## Testing Strategy: Cutover Plan

The safest way to test in production:

**Option A: Clean swap (recommended for this middleware)**
1. Deploy the new middleware to Vercel (gets its own URL)
2. Test with curl/Postman using sample payloads against the new URL
3. Point webhook URLs to new middleware (Pipedrive, Quo, Google Ads)
4. Watch Vercel logs and `/api/health` for the first hour
5. If anything breaks: swap URLs back to aac-slim immediately (takes <1 minute)
6. aac-slim stays deployed and ready as fallback for the full 7-day bake period

**Why this works:** Both old and new middleware share the same Redis database.
ID mappings, dedup keys, and QB tokens are all in Redis. So the new middleware
picks up exactly where the old one left off — no data migration needed. And
because of deduplication, even if both briefly receive the same event during
URL switchover, only one will process it.

**What to watch during bake period:**
- `/api/health` — webhook counts should be non-zero for each source
- Vercel function logs — no unexpected errors
- Pipedrive — activities still being logged from calls/SMS
- Quo — contacts still being created/updated when Pipedrive changes
- QuickBooks — customers still syncing

**Rollback:** Change webhook URLs back to aac-slim. Takes effect immediately.
No data loss — both systems use the same Redis.

---

## Future State

Things we know we want this middleware to do but haven't built yet:

### Near-term (rebuild from aac-slim)

- [ ] **Attribution engine** — Full-funnel attribution correlating website visits
  (GA4) → phone clicks → actual calls (Quo) → CRM leads (Pipedrive) → revenue
  (QuickBooks). Middleware owns the correlation logic and writes results to
  Pipedrive (the single source of truth for per-deal attribution). Includes:
  - GA4 ↔ Quo call timestamp correlation (validate false positive rate first)
  - QuickBooks lifecycle → Pipedrive deal stage sync (quote → invoice → paid)
  - Referral chain traversal for commission attribution
  - GCLID passthrough for Google Ads offline conversion import (OCI)
  See MASTER-PLAN §1.11 for full breakdown and validation plan.
- [ ] **Send safety layer** — DNC check before any outbound message. Was flagged
  as CRITICAL in aac-slim's TODO. Prevents sending to numbers on suppression lists.
- [ ] **Dead letter queue** — Store failed webhook events for retry/investigation.
  Was flagged as HIGH priority in aac-slim's TODO.

### Medium-term (new capabilities)

- [ ] **Webhook audit stream** — Write every processed event to a Redis stream
  (`XADD`) for the Command Center to display as an audit trail.
- [ ] **Inbound message event stream** — Publish inbound Quo messages to a Redis
  stream so the marketing app can subscribe for campaign response tracking
  (see MASTER-PLAN Phase 4.4).
- [ ] **QuickBooks lifecycle sync** — Receive QB invoice/payment events to:
  (a) update Pipedrive deal stages automatically (quote→invoice = "Job Complete",
  paid = "Won/Closed" with revenue amount), and (b) trigger attribution
  calculations. This is the primary mechanism for closing the revenue loop.
- [ ] **Smoke test endpoint** — `GET /api/smoke` that makes a lightweight call
  to each external API to verify connectivity.

### Long-term (expansion)

- [ ] **Calendar integration** — Bidirectional: (a) create Google Calendar events
  when Pipedrive deals reach "Estimate Scheduled" stage, and (b) detect when a
  job is added to the calendar and update the Pipedrive deal stage to "Scheduled."
  The calendar→Pipedrive direction is needed for full deal lifecycle tracking
  in attribution (see MASTER-PLAN §1.11).
- [ ] **Estimate drafting** — Auto-generate QuickBooks estimates from Pipedrive
  deal data.
- [ ] **Multi-channel activity logging** — Log email, chat, and other
  communication channels beyond calls and SMS.

---

## File Map

```
apps/middleware/
  api/
    webhooks/
      pipedrive.ts        POST — Pipedrive person sync
      quo.ts              POST — Call/SMS activity logging + AI extraction
      google-ads.ts       POST — Lead form routing + SMS alert
    health.ts             GET  — Operational metrics + heartbeat
    auth/quickbooks/
      connect.ts          GET  — OAuth initiation
      callback.ts         GET  — OAuth completion
  lib/
    env.ts                Environment variable validation
    clients.ts            API client factory (lazy singletons)
    redis.ts              Operational Redis layer (dedup, mappings, health)
  __tests__/
    health.test.ts              5 tests
    webhooks-pipedrive.test.ts  7 tests
    webhooks-google-ads.test.ts 8 tests
  package.json            Dependencies (no framework)
  tsconfig.json           TypeScript config
  vercel.json             Vercel deployment config
  .env.example            Required environment variables
  .vercelignore           Files excluded from deployment
  CLAUDE.md               AI agent rules (not documentation)
```

---

## Comparison with Predecessor

| | aac-slim (old) | apps/middleware (new) |
|---|---|---|
| Total lines | 12,881 | 3,718 (71% reduction) |
| Framework | Next.js 14 | None (plain Vercel functions) |
| API routes | 20 | 6 |
| UI pages | 10 (3,209 lines) | 0 |
| Campaign code | 12 routes (3,205 lines) | 0 |
| API clients | Inline, env-coupled | Shared package, constructor-configured |
| Phone normalization | Local copy | Shared package (single source of truth) |
| Tests | Fragile, partial | 100 tests, all passing |
| Redis keys | Hardcoded strings | Shared key schema package |
