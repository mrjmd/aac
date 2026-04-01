# Command Center — Specification

**Status:** Brainstormed 2026-03-31, not yet built
**Location:** `apps/command-center/`
**Framework:** Next.js 15 (App Router, React Server Components)
**Auth:** Simple password (single user, upgrade path for multi-user later)
**Design:** Desktop-first, responsive to mobile. Shared Tailwind design tokens with website via `packages/ui`.

---

## Vision

The Command Center is the operational cockpit for running AAC. It's the one
place Matt opens every morning to understand the state of the business. It
consolidates data from QuickBooks, Pipedrive, Google Calendar, Google Analytics,
Google Ads, the middleware health system, and the marketing engine into a single
dashboard with configurable cards.

It is NOT just a middleware health dashboard. It is a business management tool
that happens to also show system health.

---

## Dashboard Cards (Day One — All Present)

Each card shows a simple summary (green/yellow/red + key numbers) on the main
dashboard. Clicking a card navigates to a detail page with full data, filters,
and history.

### 1. Business Pulse

**The most important card.** Answers: "Is the business healthy right now?"

| Metric | Source | Detail |
|--------|--------|--------|
| Cash flow (last 30 days) | QuickBooks | Income vs expenses trend |
| Outstanding invoices | QuickBooks | Count + total $ of unpaid invoices |
| Stale estimates | Pipedrive | Deals in "Estimate Sent" stage > X days |
| Jobs scheduled (next 7 days) | Google Calendar | Count of upcoming jobs |
| Jobs scheduled (next 30 days) | Google Calendar | Count + pipeline view |

| Approved estimates (needs scheduling) | QuickBooks | Count + total $ ready to convert |

**Approved estimates deserve special treatment.** When a QB estimate status
changes to "Accepted", this should:
1. Show prominently on the Business Pulse card (these are money in the bank)
2. Auto-create a to-do item: "Schedule job for [customer name] — estimate #X ($Y)"
3. The to-do stays until the job appears on Google Calendar

Approval signals can also come via text/email ("Hey, we want to get this
scheduled") — the AI commitment detection should catch these and flag them
even before the QB estimate status changes.

**Status logic:**
- Green: Positive cash flow, no invoices > 30 days overdue, estimates moving
- Yellow: Any invoice > 30 days, or estimate stale > 14 days, or approved estimate unscheduled > 48h
- Red: Negative cash flow trend, or overdue invoices > $X threshold

**Detail page:** Full financial dashboard with date range filters, invoice list
with aging, estimate pipeline funnel, cash flow chart.

### 2. Smart To-Do List

**The killer feature.** A to-do list with two sources:

1. **Manual items** — Matt adds tasks directly (title, due date, notes)
2. **Auto-generated items** — AI detects commitments from call transcripts and
   SMS messages, creates to-do items with appropriate due dates

**Auto-detection examples:**
- "I'll schedule you for Thursday" → To-do: "Schedule job for [person]", due Thursday
- "Let me send you that estimate" → To-do: "Send estimate to [person]", due today
- "I'll follow up in two weeks" → To-do: "Follow up with [person]", due +14 days
- "I'll get back to you Monday" → To-do: "Get back to [person]", due next Monday

**Recurring tasks (pre-populated):**
- Quarterly: Budget analysis and projections review
- Monthly: Cost inventory and optimization check
- Monthly: Review solicitation follow-up status
- As-needed: Respond to new Google reviews

**Storage:** Redis (same Upstash instance). Key schema in `@aac/shared-utils/redis`.

**Data model:**
```
{
  id: string,
  title: string,
  description?: string,
  dueDate?: string (ISO),
  source: 'manual' | 'ai-detected' | 'recurring' | 'system',
  sourceContext?: {
    personId?: number,     // Pipedrive person
    personName?: string,
    transcriptExcerpt?: string,
    confidence?: 'high' | 'medium' | 'low'
  },
  status: 'pending' | 'completed' | 'dismissed',
  createdAt: string,
  completedAt?: string
}
```

**Card summary:** Count of pending items, count overdue, next due item.
**Detail page:** Full to-do list with filters (pending/completed/all, manual/auto),
ability to add/edit/complete/dismiss items. AI-detected items show the source
transcript excerpt and confidence level.

### 3. New Leads (Last 24h)

**Answers:** "Did any new business come in overnight?"

| Metric | Source |
|--------|--------|
| Google Ads leads | Middleware health endpoint (webhook counts) + Pipedrive recent persons |
| Inbound calls | Quo webhook activity (middleware health counts) |
| New Pipedrive contacts | Pipedrive API (recent persons, sorted by created date) |

**Card summary:** Total new leads count, breakdown by source.
**Detail page:** List of recent leads with name, phone, source, deal stage,
link to Pipedrive.

### 4. Website / SEO / Ads

**Answers:** "Is the website healthy and are ads performing?"

| Metric | Source |
|--------|--------|
| Website uptime/health | Vercel (or external ping) |
| Traffic trend (7d vs prior 7d) | Google Analytics 4 |
| Top landing pages | Google Analytics 4 |
| Ad spend / conversions / CPA | Google Ads |
| Search Console impressions / clicks / position | Google Search Console |
| Lighthouse scores | Redis (from cron audit — `tools/lighthouse/`) |
| Lighthouse regressions | Diff of current vs previous audit run |

**Status logic:**
- Green: Traffic up or stable, ad CPA within target, no Lighthouse regressions
- Yellow: Traffic down >10%, CPA above target
- Red: Website down, ad account issues, major Lighthouse regression

**Card summary:** Green/yellow/red + key numbers (sessions, ad spend, leads).
**Detail page:** Full analytics dashboard with date range selectors, charts,
comparison periods. Includes Search Console data (impressions, clicks, average
position, top queries, top pages).

### 5. Middleware Health

**Answers:** "Is the integration layer running?"

| Metric | Source |
|--------|--------|
| Heartbeat status | Redis (`health:middleware:ts`) |
| Webhook counts (24h) | Middleware health endpoint |
| Last processed per source | Middleware health endpoint |
| Recent errors | Middleware health endpoint |

**Status logic:**
- Green: Heartbeat < 6 min old, all sources processing, no errors
- Yellow: Heartbeat 6-15 min old, or errors in last hour
- Red: Heartbeat > 15 min or missing, or persistent errors

**Card summary:** Green/yellow/red + "X events processed today".
**Detail page:** Full health metrics, error log, per-source breakdown.

### 6. Marketing Campaigns

**Answers:** "How are campaigns performing?"

| Metric | Source |
|--------|--------|
| Active campaigns | Redis (campaign state) |
| Messages sent / responses / opt-outs | Redis (campaign stats) |
| Response rate | Derived |

**Status logic:**
- Green: Active campaigns running, response rate healthy
- Yellow: No active campaigns, or response rate declining
- Red: Campaign errors, high opt-out rate

**Card summary:** Green/yellow/red + active campaign count + overall response rate.
**Detail page:** Campaign list with stats, drill into individual campaigns.

**Note:** This card lights up once the Marketing Engine (Phase 4) is built.
Until then, it reads whatever campaign data exists in Redis from aac-slim.

### 7. Important Dates

**Answers:** "What's coming up that I can't miss?"

| Category | Examples |
|----------|----------|
| Business renewals | ASHI certification, insurance, domain registrations, licenses |
| Partnership events | Key dates for partnership leads |
| Recurring tasks | Quarterly budget review, monthly cost analysis |
| Seasonal prep | Pre-season marketing pushes, equipment maintenance |

**Source:** Pipedrive deals (a "Business Admin" pipeline or custom fields),
Google Calendar, or stored directly in Redis/DB.

**Card summary:** Next 3 upcoming items with days-until-due. Red highlight
for anything < 7 days.
**Detail page:** Calendar view with all upcoming dates, ability to add new ones.

---

## Deep-Dive Features (Beyond Day-One Cards)

These are detail-page features and cross-cutting capabilities that don't fit
neatly into a single card but are core to the Command Center's value.

### Full-Funnel Attribution

**The question:** "That $3,000 job we completed — what originally brought
that customer to us?"

This traces the complete user journey from first touch to paid invoice:

```
Traffic Source → Website Visit → Call/Text → Pipedrive Lead → Estimate → Job → Invoice → Payment
     ↑                ↑              ↑            ↑              ↑         ↑         ↑
  Google Ad       UTM params     Quo webhook   PD webhook     PD deal    QB est    QB invoice
  Facebook        GA4 session    Call/SMS log   Person created  Stage     Approved   Paid
  BBB listing     Landing page   Activity       Contact linked  Moved     Scheduled  Collected
  GBP             Referral path
  Organic search
```

**Data sources for attribution:**
- **UTM parameters** — Already being added to Facebook, BBB, Google Business
  Profile, and other referral sources. Tracked in GA4.
- **GA4 sessions** — Landing page, source/medium, campaign, referral path
- **Quo call/SMS logs** — Which phone number (CT vs MA) received the contact,
  correlated with the session that preceded it
- **Pipedrive** — Person creation → deal → estimate → won/lost
- **QuickBooks** — Estimate accepted → invoice → payment collected

**Attribution model:**
- First-touch: What originally brought them to us?
- The referral chain already exists in Pipedrive (the "Referred by" field
  traversal from the attribution engine in aac-slim)
- Correlate Pipedrive person phone with Quo activity timestamps, then match
  to GA4 sessions within a time window

**Branch-specific:** Full attribution currently works for Massachusetts
(website + Google Ads + calls/texts all trackable). Connecticut can track
calls/texts but not necessarily the website-to-call journey yet.

**Detail page:** `attribution/page.tsx` — Per-job attribution view showing
the full funnel. Filterable by date range, source, branch. Aggregated views
showing which channels drive the most revenue (not just leads, but actual
completed paid jobs).

**Existing work:** The aac-astro codebase has analytics scripts that already
pull GA4 and Search Console data. The aac-slim attribution engine traces
Pipedrive referral chains to QuickBooks invoices. These need to be unified
into a single view.

### Email/Gmail Monitoring

**The question:** "Are there emails I need to deal with?"

Gmail is a secondary lead channel — occasional leads come in via email, and
business correspondence happens there too.

**Capabilities:**
- Surface emails flagged as important or from known contacts
- Detect lead-like emails (someone asking for an estimate, service inquiry)
- Auto-create to-do items for emails that need a response
- Correlate email leads with Pipedrive (does this person already exist?)

**Data source:** Gmail API (read-only). Requires OAuth with Gmail scope.

**Integration approach:** This is a new data source not yet in `@aac/api-clients`.
Needs a `GmailClient` extraction (or inclusion in the Google OAuth shared auth).
Could be implemented as:
- A periodic poll (every 15 min) that checks for new important/unread emails
- A Gmail push notification (webhook via Google Cloud Pub/Sub) for real-time

**Card integration:** Important emails surface as items in the Smart To-Do
list with `source: 'email'`. The card summary on the dashboard could show
"X unread important emails" as part of the to-do count or as its own indicator.

---

## Architecture

```
apps/command-center/
  app/
    layout.tsx            Root layout (sidebar nav, auth check)
    page.tsx              Dashboard (card grid)
    todos/page.tsx        Smart to-do list detail
    leads/page.tsx        Lead activity detail
    financials/page.tsx   Business pulse detail
    analytics/page.tsx    Website/SEO/Ads + Search Console detail
    attribution/page.tsx  Full-funnel attribution (source → job → payment)
    health/page.tsx       Middleware health detail
    campaigns/page.tsx    Marketing campaigns detail
    calendar/page.tsx     Important dates detail
    settings/page.tsx     Card config (show/hide, reorder)
    api/
      todos/route.ts      CRUD for to-do items
      health/route.ts     Proxy to middleware health endpoint
      ...
```

### Data Flow

The Command Center is primarily a **read-only aggregator**. It reads from:
- **Redis** — Middleware heartbeat, webhook counts, campaign stats, to-do items
- **Pipedrive API** — Recent persons, deals, pipeline stages (via `@aac/api-clients`)
- **QuickBooks API** — Invoices, payments, cash flow (via `@aac/api-clients`)
- **Google Calendar API** — Scheduled jobs (via `@aac/api-clients`, once extracted)
- **Google Analytics API** — Traffic, conversions (via `@aac/api-clients`, once extracted)
- **Google Ads API** — Spend, CPA, leads (via `@aac/api-clients`, once extracted)
- **Google Search Console API** — Impressions, clicks, positions (via `@aac/api-clients`, once extracted)
- **Gmail API** — Important/unread emails, lead detection (via `@aac/api-clients`, once built)

The only writes it makes:
- To-do CRUD (Redis)
- Card configuration (Redis or localStorage)
- Heartbeat (its own health key in Redis)

### Smart To-Do: AI Commitment Detection

The commitment detection pipeline:

1. **Quo webhook** (middleware) already processes inbound messages and transcripts
   through Gemini for entity extraction
2. **Expand the Gemini prompt** to also detect commitments/promises:
   - "I'll schedule you for..." → extract date, action, person
   - "Let me send you..." → extract action, person
   - "I'll follow up in..." → extract timeframe, person
3. **Write detected commitments to Redis** as to-do items with `source: 'ai-detected'`
4. **Command Center reads and displays** them in the to-do list with source context

This means the middleware Quo webhook gains a second AI analysis pass. The entity
extraction (name, address, email) stays as-is. The commitment detection is a new
prompt that runs on the same text.

---

## Tech Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Next.js 15 | Dashboard is 70%+ interactive; App Router layouts suit dashboard navigation |
| UI library | shadcn/ui + Tailwind | Accessible components, easy to customize, shared tokens with website |
| Design tokens | `packages/ui` (shared) | Brand coherence between website and command center |
| Auth | Simple password | Single user for now. Stored as hashed env var. Upgrade path to proper auth later. |
| To-do storage | Redis | Same Upstash instance. No new infrastructure. |
| Commitment detection | Expand Quo webhook | Already processes transcripts. Add second Gemini prompt for commitment extraction. |
| Card config | Redis or localStorage | User preferences for card visibility and order. |
| Refresh strategy | ISR + client polling | Server-rendered initial load, client-side polling (30s) for live data. |

---

## Dependencies on Other Phases

| Dependency | Status | Impact |
|------------|--------|--------|
| `@aac/api-clients` Pipedrive + QB | Done | Business Pulse, Leads, To-Do auto-detection |
| `@aac/api-clients` Gemini | Done | Commitment detection |
| Middleware deployed | Not yet | Health card, webhook counts, auto to-do items |
| `@aac/api-clients` Google Calendar | Not built | Jobs scheduled counts |
| `@aac/api-clients` Google Analytics | Not built | Website/SEO card |
| `@aac/api-clients` Google Ads | Not built | Ads performance card |
| `@aac/api-clients` Google Search Console | Not built | Search Console data in analytics card |
| `@aac/api-clients` Gmail | Not built | Email monitoring, lead detection, to-do auto-creation |
| Marketing Engine (Phase 4) | Not built | Campaign stats card |
| Attribution engine rebuild | Not built | Full-funnel attribution (source → job → payment) |

**Day-one without dependencies:** Business Pulse (QB + Pipedrive), Smart To-Do
(manual only until commitment detection ships), New Leads (Pipedrive), Middleware
Health (once middleware is deployed), Important Dates (manual or Pipedrive).

**Cards that light up later:** Website/SEO/Ads (needs Google client extraction),
Marketing Campaigns (needs Phase 4), Smart To-Do auto items (needs commitment
detection in Quo webhook).

---

## MVP Build Order

1. **Scaffold** — Next.js 15 app, auth, layout with sidebar, card grid
2. **Business Pulse card** — QB outstanding invoices + Pipedrive stale estimates
3. **Smart To-Do card** — Manual CRUD (add/edit/complete/dismiss), stored in Redis
4. **New Leads card** — Recent Pipedrive persons
5. **Middleware Health card** — Read from middleware `/api/health`
6. **Important Dates card** — Manual entry + Pipedrive pipeline for renewals
7. **Card configuration** — Show/hide, reorder, persist preference
8. **Commitment detection** — Expand Quo webhook Gemini prompt, auto-create to-dos
9. **Website/SEO/Ads card** — Requires Google client extraction (Phase 0.11-0.14)
10. **Email monitoring** — Gmail API integration, surface important emails as to-dos
11. **Full-funnel attribution** — Unify GA4 + Pipedrive + QuickBooks into source-to-payment journey
12. **Marketing Campaigns card** — Lights up when Phase 4 ships
