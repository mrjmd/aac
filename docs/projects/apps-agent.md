# Project Spec — apps/agent (Conversational Agent Platform)

**Status:** Spec — pre-build
**Owner:** Matt
**Created:** 2026-05-27
**Pillar:** 6 (apps/agent/)
**Supersedes:** `_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` — the original 44k-byte spec remains the most-detailed design source. Refer to it for nuanced design decisions not captured in this spec.
**Build dependency:** Foundational. Required by Calendar Scheduling and Quote Auto-Draft projects. apps/field v1 is independent; apps/field v2 depends on this.

---

## Goal

A separate Vercel app that provides the agent platform — conversational
operations runtime, LLM read-tool surface, diagnostic agent, and the
judgment-driven half of the deal spine — that the original Phase 2.5
deal-spine spec proposed as middleware extensions.

Split out per the 2026-05-27 architecture decision because middleware is
sacrosanct (minimal changes, stateless webhook processing) and the agent
platform has different change cadence, state model, and runtime profile.

### Load-bearing automations apps/agent unlocks

The Crawl infrastructure (deal spine, read-tool surface, diagnostic agent
plumbing) is the *means*; the value lands when these Walk-phase automations
go live on top of it. Listed here so the work isn't accidentally
deprioritized as "later."

- **Stale-deal nudging (Funnel A Phase 2)** — the dormant-quote
  reactivation engine. Detail in Walk §6; full design in
  `analysis/02-strategy/funnel-a-dormant-reactivation.md`. Single biggest
  revenue lever apps/agent unlocks (\\$97k aggregate value in the priority
  90+d Pending pool at the 2026-05-22 inventory).
- **Real-time intent classification + Matt-confirmed action proposals** —
  Walk §3–§4. Closes the loop from inbound customer signal to deal
  state transition without Matt having to be the dispatch layer.
- **Diagnostic agent for middleware errors** — Walk §8. Errors become
  proposals ("we noticed X, here's the fix, approve?") instead of
  silent stream entries.

## Deal model

The PD deal is the cross-system spine: it holds foreign keys to the PD
person, the QB estimate, and the QB invoice for one specific opportunity,
plus a stage. It becomes the single record of "where does this customer
relationship stand?" The `[deal:N]` marker in calendar event descriptions
and deal-ID stamps on QB estimates make cross-system linkage deterministic
instead of name-match brittle.

**Calendar events link to deals via the `[deal:N]` marker only — not via a
deal-side foreign key.** A deal can have many events: one assessment
(purple), one or more job events (green; multi-day repairs are common),
and callbacks. Each event belongs to at most one deal, so the many-to-one
relationship lives naturally on the event description side. The deal
doesn't need to mirror it.

This means "what events does deal N have?" is answered by a calendar
search for `[deal:N]` in the description; stage transitions like "all
green events for the deal have ended" follow naturally from filtering
those results.

### Stages

PD pipeline name: **"Deal Spine"** (created 2026-05-28).

| # | Stage | Trigger to enter |
|---|---|---|
| 1 | **Lead** | Customer signals interest (text / call / web form) — not yet triaged |
| 2 | **Qualified Lead** | Fit confirmed; we want to engage. Agent or Matt makes the call. |
| 3 | **Assessment Scheduled** | Purple (color 3) calendar event created |
| 4 | **Assessment Done** | Assessment event end time passed |
| 5 | **Quote Sent** | QB estimate created and emailed |
| 6 | **Quote Accepted** | QB estimate marked accepted (or customer confirms via text) |
| 7 | **Job Scheduled** | Green (color 10) calendar event created |
| 8 | **Job Done** | Field app marks complete (or green event end time passed). **Covers invoicing too** — Cron A / field app create the QB invoice immediately on completion, so the dwell time between "work done" and "invoice sent" is minutes, not a distinct state. Edge cases (warranty work, courtesy jobs with no invoice, invoice-send failure) tracked as a deal metadata field, not as a stage. |
| 9 | **Paid** | QB invoice marked paid — terminal success |
| 10 | **Lost** | Terminal failure — carries a `lost_reason` field |

`lost_reason` values: `out_of_scope` (fit miss — "we don't do that"),
`competitor`, `price`, `no_response`, `cancelled`,
`passed_after_assessment`, `other`.

The Lead → Qualified Lead split separates fit misses from sales losses. Fit
misses tell us about positioning / SEO / who's finding us. Sales losses
tell us about close motion. Conflating them under one "Lost" stage makes
both metrics noisy. See `DECISIONS.md` (2026-05-28 entry) for full
reasoning.

Some leads skip Assessment Scheduled / Assessment Done (small repairs Matt
quotes from photos). One pipeline; stages are optional, not strict.

FHP customers don't fit this pipeline at all (recurring billing, no quote
cycle). When the FHP back-end ships, a second pipeline will be added.

### Custom fields on the PD Deal

Four custom fields, all created via the setup script in `tools/src/setup/pd-deal-fields.ts` (so the field hashes are captured deterministically and the setup is reproducible):

| Field | Type | Purpose |
|---|---|---|
| `qb_estimate_id` | text | QB Estimate.Id for this deal (typically 1:1) |
| `qb_invoice_id` | text | QB Invoice.Id for this deal (typically 1:1) |
| `external_id` | text | Generic dedup key for backfill / idempotency (e.g. `"qb-est-1234"` so re-runs don't duplicate deals) |
| `lost_reason` | enum | One of: `out_of_scope`, `competitor`, `price`, `no_response`, `cancelled`, `passed_after_assessment`, `other` |

PD Person ↔ QB Customer linkage already exists at the person level (the `quickbooks_id` field on PD Person, maintained by middleware). That link is **not** duplicated on the deal — the deal carries QB IDs for the specific estimate and invoice tied to *this* opportunity, not the customer. Multi-job customers (a builder who books repeat work) get one deal per opportunity, each linked to its own estimate.

`calendar_event_id` is intentionally **not** a deal field — calendar events link to deals via the `[deal:N]` marker in their description (see above). One assessment, one or more job events, and any callbacks all belong to the same deal without needing a deal-side foreign key.

## Roles & identity

Apps/agent is an **internal-only** tool. Identity is by phone number; whoever texts the comms line is identified by which phone they texted from, looked up in a role map.

| Role | Who (today) | Read scope |
|---|---|---|
| `owner` | Matt | Everything |
| `technician` | Mike (future: other techs) | Own calendar, own jobs, customers tied to own jobs, escalation contacts. **Aspirational at start — concrete tool scope is added when the role is actually used.** |
| `salesperson` | Edward (future: other salespeople) | Own pipeline, own deals, customers tied to own deals, own attribution. **Aspirational at start.** |
| `triage` | (future inbound triage hire, no concrete timing) | Customer scheduling context, calendar availability, no employee data, no financials. **Not designed until the hire is real.** |

Only `owner` has a concretely defined tool scope at Crawl + Walk start. The other roles are placeholders — the role map can route them, but their tool surfaces get fleshed out when the people actually start using the agent. Designing aspirational scopes now is YAGNI.

**Identity binding:**

- Phone → role mapping in env (`AGENT_USER_ROLES` as JSON). Migrate to a `users` Redis hash when there are 10+ users. The current scale doesn't justify a DB.
- Standing rules per-user, keyed in Redis by phone (`agent:rules:{phoneE164}`).
- Audit log: every Q&A captured with caller identity, question, tool calls made, response. **Redis stream** (queryable, expires naturally).

**Tool-surface scoping rule (load-bearing):**

Every read tool takes a caller identity and filters at the data-fetching layer — never at the response layer. The tool *registry* itself is per-role: the LLM session for a given caller is only registered with tools that caller is allowed to use. The model never sees tool definitions for actions it can't take or data it can't read. This is non-negotiable — LLM responses are non-deterministic; even with a system prompt saying "don't mention X," if the tool returned X, the model might reference it.

## Customer-facing boundary

Apps/agent is **never** exposed to customers as a conversational interface. Customers may interact with the agent's intelligence (intent classification of their inbound texts, automated responses to specific signals like quote-approvals or scheduling negotiations), but those interactions must always feel like an automated message from a human — never like talking to a chatbot.

Concrete implications:
- No "talk to our AI" surface, ever
- Autonomous customer-text behaviors (Walk → Run) use templated or LLM-composed copy, but tonally constrained to feel human-authored
- Customer recipients are NOT users in the role-model sense; they have no identity in the agent's permission system
- All conversational dialogue surface is internal: Matt, technicians, salespeople, triage

## Writes are split by trigger nature

The deal table is shared infrastructure. Both middleware and apps/agent
write to it; the split is by what triggers the write:

| Trigger | Writer |
|---|---|
| PD/QB/Quo webhook with deterministic implication (estimate created → Quote Sent, invoice paid → Paid, calendar event with marker → link to deal) | **Middleware** |
| Nightly reconciliation cron (QB estimate/invoice state into deal stages) | **Middleware** |
| `[deal:N]` marker stamping on cron-created calendar events | **Middleware** |
| LLM intent classification of inbound message → stage transition | **Apps/agent** |
| Matt confirms an action proposal → deal create / update | **Apps/agent** |
| Diagnostic agent decides a remediation | **Apps/agent** |

Middleware grows *deal-aware* (reads markers, writes deterministic
transitions) but doesn't grow LLM judgment, dialogue state, or proposal
lifecycle. Apps/agent owns the LLM/judgment side. CRUD methods themselves
live in `@aac/api-clients`, called by both. See `DECISIONS.md`
(2026-05-28 entry) for the full split rationale.

## Crawl / Walk / Run rollout (compressed from original Phase 2.5 spec)

### Crawl (2-4 weeks — foundation)

Goal: build the deal spine, marker plumbing, and apps/agent scaffold without
any LLM logic. By end of Crawl, every job has a deal, every estimate has a
deal, marker-based cross-system linkage works, and middleware errors land
on the agent line (raw, no diagnosis yet).

**Shared (`@aac/api-clients`):**

1. ✅ **PD Deal CRUD methods** — *Shipped 2026-05-28.* `createDeal`, `getDeal`, `updateDeal`, `getDealsByPerson`, `setDealStage`, `markDealLost`, `findDealByExternalId` in `PipedriveClient`. Constructor-injected `dealSpine` config holds pipeline/stage IDs + custom-field hashes. 16 tests + live PD round-trip on the Matt Davis fixture. Setup tooling: `tools/src/setup/pd-deal-fields.ts` (idempotent). PD pipeline ID = 1; stage IDs 1–10 in spec order; field hashes captured in `DEAL_FIELD_HASHES` constant.
2. ✅ **Quo conversation methods** — *Shipped 2026-05-28.* `listPhoneNumbers`, `getDefaultPhoneNumberId` (cached, dedupes concurrent callers), `listMessages`, `listCalls`, `listConversations`, and the bundled `getRecentActivityForContact(phoneE164, { since? })` that powers the Walk-phase customer-context tool. Types: `QuoPhoneNumber`, `QuoMessage`, `QuoCall`, `QuoConversation`, `QuoPaginated<T>`, `QuoActivityWindow`. 12 new tests; 208 total green in `@aac/api-clients`.

**Middleware (deterministic deal work — fits existing patterns):**

3. ✅ **`[deal:N]` marker read support** — *Shipped 2026-05-28.* `parseDealMarker` helper in `lib/cron.ts` + new `matchEventToDealAndPerson(event, pipedrive)` in `lib/job-customer-match.ts` that prefers `deal.personId` from a marker, falls back through the existing `PipedriveID:` marker + name search + compound-name expansion. `matchEventToPerson` becomes a thin wrapper so all three crons (job-reminders, job-followups, invoice-create) get the marker fast-path automatically. `invoice-create` additionally uses `deal.qbEstimateId` to skip the customer-wide estimate search entirely when the marker is present — bypasses both the no-accepted-estimate and multi-estimate-ambiguity branches. Added `QuickBooksClient.getEstimate(id)` for the direct lookup. Marker emit on cron-created events is N/A (these crons read but don't create events); emit happens in step 4 (webhook handlers) + apps/agent scheduling. Also bundled in: middleware-cleanup item #1 (cron scaffolding consolidated into `lib/cron.ts`). 118 middleware tests + 13 monorepo packages green.
4. ✅ **Inbound-lead deal stamp** — *Shipped 2026-05-28.* `ensureInboundLeadDeal(pipedrive, personId, phone)` helper in `lib/inbound-deal.ts` + call site in `api/webhooks/quo.ts` right after the new-person `pd.createPerson` branch. Creates a Lead-stage deal with `external_id = pd-person-{personId}`; idempotent (returns existing on re-run via `findDealByExternalId`). Failures are surfaced to `/api/health` via `logHealthError` but never break the webhook. 4 helper tests; 122 middleware tests + 208 api-clients tests green. **Scope note:** the original spec line bundled three webhook handlers (PD-inbound + QB-estimate-created + QB-invoice-paid). The two QB pieces are absorbed into step 5 (nightly reconcile cron) because (a) QB webhooks would require fresh Intuit Developer Console subscription + ~300 LOC of net-new signature-verifying handler infrastructure, (b) the nightly cron is the durable mechanism that catches the same transitions, and (c) during Crawl nothing reads deals in real time anyway. Webhook-based QB triggers can be revisited as an optimization once apps/agent starts depending on near-real-time deal state.
5. ✅ **Nightly deal-reconcile cron** — *Shipped 2026-05-28.* `apps/middleware/api/cron/deal-reconcile.ts` runs daily at 9am ET, replays the last 7 days of QB activity (configurable via `?windowDays=N`), and converges PD deal state. Phase 1 walks `qb.listRecentEstimates`: for each Pending/Accepted estimate it finds-or-creates a deal (dedup via `external_id = qb-est-{id}`), advances stage when QB shows it further along — but only via `isStageAdvance` so we never demote. Rejected/Closed estimates are skipped. Phase 2 walks `qb.listRecentInvoices`: finds the deal directly (`qb-inv-{id}`) or via the linked estimate (`qb-est-{id}`), stamps `qb_invoice_id` when missing, advances to Paid when `Balance === 0`. Orphan invoices (no estimate, no deal) get their own deal at Paid/Job Done. Lost deals are off-limits via `dealStageRank('lost') === Infinity`. Reconcile logic lives in `lib/deal-reconcile.ts` (testable in isolation); stage ranking helpers (`dealStageRank`, `isStageAdvance`) live in `lib/cron.ts` for shared use. New `QuickBooksClient.listRecentEstimates(sinceISODate?)` + `listRecentInvoices(sinceISODate?)` methods; `getPipedriveIdFromQb` resolver injected. 146 middleware tests + 214 api-clients tests green. **This subsumes the QB-deterministic-transition pieces originally bundled into step 4** — QB webhooks remain unnecessary infrastructure for Crawl.

**Tools (one-shot script):**

6. ✅ **Backfill script** — *Shipped 2026-05-28 (script only; production run still gated).* `tools/src/scratch/backfill-deal-spine.ts` — one-shot script that walks two sources: (a) all currently-open QB estimates → finds-or-creates PD deal at `quote_sent`/`quote_accepted` dedup'd by `external_id = qb-est-{id}`; (b) recent green (color 10, job) + purple (color 3, assessment) calendar events → matches event → person via the same sequence as `matchEventToDealAndPerson` (PD marker → name → compound-name), then either attaches to an existing single open deal for that person (preferred — keeps the spine consolidated) or creates a new deal at `job_scheduled`/`assessment_scheduled` (or `_done` for past events), dedup'd by `external_id = gcal-{eventId}`. Stamps `[deal:N]` marker back on event description. Flags: `--apply` (writes; default is dry-run), `--phase=estimates|events|all`, `--event-lookback-days=N`, `--limit-{estimates,events}=N`. Per-record JSON report at `tools/src/scratch/spike-output/backfill-deal-spine-<date>-{dryrun,apply}.json`. Dry-run end-to-end-verified on 2 estimates + 3 events from the live calendar. **Production run remains gated on [Funnel A Phase 1 cleanup](../../analysis/02-strategy/funnel-a-dormant-reactivation.md#phase-1--pipeline-cleanup-1-2-days-pre-build).** Funnel A's inventory shows 77 Pending estimates (script saw ~295 open including Accepted/Converted), 37 of which are 90+ days old; running with `--apply` before cleanup would mint dozens of stale deals. Cleanup categorizes each open estimate as: keep-in-funnel / dead (close) / forgot-to-mark-won (close as Converted) / multi-quote orphan (close). Only the keep-in-funnel subset backfills as live deals.

**Apps/agent (new app scaffold):**

7. ✅ **App scaffold** — *Shipped 2026-05-28.* New `apps/agent/` Vercel app, raw `@vercel/node` functions matching middleware. `package.json` with deploy scripts (project ID placeholder — Matt creates the Vercel project before first deploy), `vercel.json` with cron entries, `tsconfig.json`, pillar `CLAUDE.md`. Lib layer: `env.ts` (typed config with `QUO_AGENT_PHONE_NUMBER` default `+16177660151`, `MATT_PERSONAL_PHONE_NUMBER` required, `AGENT_USER_ROLES` JSON parsed leniently, shared Redis + cron secret), `roles.ts` (E.164→role lookup, four canonical roles, invalid entries skipped not thrown), `redis.ts` (heartbeat + cron-cursor ops + read-only `health:errors` access), `clients.ts` (Pipedrive + Quo, Quo configured to send from the agent phone line), `cron.ts` (auth verifier). `api/health.ts` endpoint writes the agent heartbeat. New keys in `@aac/shared-utils/redis`: `agentCronCursor(job)`, `agentRules(phoneE164)`, `agentAuditStream`. 20 new tests; full monorepo green (146 middleware + 214 api-clients + 44 shared-utils + 28 agent).
8. ✅ **Error-surfacing tick** — *Shipped 2026-05-28.* `apps/agent/api/cron/error-surface.ts` runs every 10 minutes (vercel.json `*/10 * * * *`), reads middleware's `health:errors` list head, and texts Matt raw failure context from `+16177660151` to `MATT_PERSONAL_PHONE_NUMBER`. Logic lives in `lib/error-surface.ts` (testable in isolation). Cursor at `agent:cron:error-surface:cursor` tracks the timestamp of the most-recently-surfaced entry. **First-run policy:** on cold boot (no cursor), stamps cursor at the newest entry and exits — does NOT page-flood Matt with the last 100 errors. Steady state: forwards every entry with `timestamp > cursor` in chronological order, capped at 5 SMS per tick (older overflow surfaces on subsequent ticks naturally since the cursor advances to the newest *forwarded* entry, not the newest *seen*). SMS send failures are counted and logged but don't fail the tick. Crawl version: raw paste of error JSON, no diagnosis — Walk-phase diagnostic agent wraps this same flow with LLM-judged diagnosis + proposed fix. 8 tests cover first-run/steady-state/cap/failure/no-op paths.

### Walk (1-2 months after crawl)

1. **Agent comms inbound handler** — routes messages on `(617) 766-0151` to the intent router that parses Matt's directives.
2. **Agent read-access tool surface** — LLM-callable functions for cross-system queries:
   - `getCustomerContext(personIdOrPhone)`
   - `searchCalendar({dateRange, locationKeyword?, color?})`
   - `listDeals({stage?, personId?, dateRange?})`
   - `getDeal(dealId)`
   - `findJobsMissingInvoices({dateRange})`
   - `getInvoiceSummary({dateRange})`
   - `searchConversation(personId, searchText?)`
   The LLM chains these to answer arbitrary Matt questions ("any jobs today without invoices?", "how much did we invoice in April?", "summarize Smith deal").
3. **Real-time intent classification** — every inbound customer signal (text, call transcript) classified into: quote-approval, assessment-request, scheduling-negotiation, callback, pricing-question, complaint, unclassified.
4. **Action proposals via agent comms** — for each classified intent, agent texts Matt the proposed next action with reasoning; Matt confirms via dialogue (not button).
5. **Stub event creation on confirm** — agent creates calendar events with `[deal:N]` marker after Matt confirms intent classification. Two flavors: job (green/10), assessment (purple/3).
6. **Stale-deal nudges (load-bearing automation)** — agent monitors deals stalled in any stage and proposes nudge text. Two flavors per stage:
   - **Quote stage (Funnel A Phase 2):** the dormant-quote reactivation engine — fully designed in `analysis/02-strategy/funnel-a-dormant-reactivation.md`. Daily cron scans Pending QB estimates per a context-driven cadence (default ~3d → ~2w → exponential backoff, adjusted to anything the customer stated like "decide by Friday"). LLM reads the Quo conversation history, drafts a follow-up SMS, routes to Matt's approval queue. Auto-closes at 9 months OR 2–3 unanswered touches; inbound signal immediately suspends the funnel and routes to a human. This is the single biggest revenue lever apps/agent unlocks (\\$97k aggregate value in the priority 90+d Pending pool alone at the 2026-05-22 inventory).
   - **Assessment / job / invoice stages:** same shape — LLM-judged staleness, drafted nudge, Matt-approved send. Lower volume than the quote-stage flow but the same mechanism.
   "Stale" is LLM-judged across all flavors, not threshold-based. See [Funnel A doc](../../analysis/02-strategy/funnel-a-dormant-reactivation.md) for the quality-gate framework + autonomy graduation criteria.
7. **Agent comms outbound from Matt** — directive surface: status queries, schedule overrides, standing rules ("stop sending review prompts to commercial customers").
8. **Diagnostic agent for middleware errors** — every new entry in middleware's error stream → diagnostic agent runs diagnosis using read-tool surface → proposes idempotent ops fix OR code-level fix → texts Matt structured writeup ("we noticed X, looked into it, here's the fix, approve?").

### Run (multi-quarter, long-term)

1. Customer-facing slot suggestions (agent texts customers directly with 2-3 proposed slots)
2. Expanded directive surface ("draft response to Davis's last text", "summarize Smith deal")
3. Standing-rule memory (persistent constraints from Matt's corrections)
4. Geo-clustering algorithm matured (proximity scoring in slot suggestions, including salesperson schedule)
5. Project staging integration (completed jobs auto-stage assets for marketing)
6. Multi-channel signal integration (QB events, calendar changes, GBP reviews as first-class signals)
7. Auto-application of well-worn ops fixes — level 2 (act-and-notify) for diagnostic patterns Matt has approved N times

## Autonomy ladder

Each action class has its own autonomy level. No global flag.

| Level | Behavior |
|---|---|
| 0 — disabled | Agent never takes this action |
| 1 — propose | Agent opens conversation with Matt; acts only after dialogue resolution |
| 2 — act-and-notify | Agent acts, summarizes after; Matt can reverse via comms line |
| 3 — act-silently | Agent acts, logs internally only |

**`propose` is a dialogue, not a button.** Matt's response can be: yes / no / "yes but X" / clarifying question / counter-proposal / "explain your reasoning." Especially in Run state, every proposal should feel like texting a competent assistant.

**Promotion mechanism:** Matt explicitly tells the agent ("you can stop asking about invoice creation, just do it"). Not automated.

See the original Phase 2.5 doc (`_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` §6) for the full per-action-type autonomy table covering deal lifecycle, intent classification, Matt-directed writes, diagnostic ops, and read queries.

## Architecture decisions locked

- Separate Vercel app, not middleware extension (2026-05-27, see `DECISIONS.md`)
- Comms line: `(617) 766-0151` (dedicated Quo number, currently unused — confirmed 2026-05-28)
- Whitelist on Matt's personal number (env: `MATT_PERSONAL_PHONE_NUMBER`)
- Deal as cross-system spine: PD deals are load-bearing infrastructure; Matt never touches deals manually
- **Deal writes split by trigger nature** (2026-05-28, see `DECISIONS.md`) — deterministic webhook + cron writes live in middleware; LLM / judgment / dialogue-driven writes live in apps/agent. CRUD methods themselves live in `@aac/api-clients`.
- Deal stages: 10-stage pipeline locked (see "Deal model" above) — Lead, Qualified Lead, Assessment Scheduled, Assessment Done, Quote Sent, Quote Accepted, Job Scheduled, Job Done (covers invoicing), Paid, Lost (with `lost_reason`). PD pipeline name: "Deal Spine."
- No web UI in apps/agent. All observation / configuration surfaces live in command-center. Comms-line dialogue is the only interface. (Confirmed 2026-05-28.)
- **Stack: raw Vercel functions** (`@vercel/node`), not Next.js, not Hono. Confirmed 2026-05-28. Matches `apps/middleware/`. The monorepo's pattern is UI apps on Next.js (`apps/field`, `apps/command-center`, `apps/marketing`), API-only apps on raw Vercel functions (`apps/middleware`, `apps/agent`). Template handler shape: `apps/middleware/api/webhooks/google-ads.ts` is the cleanest reference.
- **Internal-only**, never customer-facing as a conversational interface (2026-05-28, see "Customer-facing boundary" above)
- **Multi-user with role-scoped tool surface** (2026-05-28, see "Roles & identity" above); only `owner` (Matt) has a concrete tool scope at start, others are placeholders
- LLM-first, hard rules second (per original Phase 2.5 principle 2.1)

## Open questions

1. **Standing-rule storage:** Redis with structured schema, or a small Postgres / Turso? (Original spec was vague.) Decision can wait until Walk.
2. **Backfill scope:** how far back to create deals retroactively? All open estimates + green calendar events? Past 6 months? (Original spec said "open QB estimates + every recent green calendar event.") Decide right before running the backfill.
3. **Diagnostic agent — code-fix output format?** If a code-level fix is proposed, does the agent draft a PR, output a diff, or just text Matt the fix description? Walk-phase decision.

## Related

- Original detailed spec: `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` (44k bytes — refer for nuance on autonomy table, deal stages, association rules, slot algorithm)
- Architecture decisions: `docs/DECISIONS.md` (2026-05-27 entries on apps/agent split + deal-spine prerequisite)
- Plan position: priority #2 of four; foundational for #3 and #4
- Pillar CLAUDE.md: `apps/agent/CLAUDE.md`
- Current plan: `docs/PLAN.md`
