# Project Spec — `@aac/scheduling` Pipeline

**Status (2026-05-29):** Walk pieces 1–3 shipped and deployed. Crawl pipeline live in prod with e2e verification. Duration heuristic codified in `@aac/quoting` and wired into `normalizeQbApproval` — directives carry full `durationPrediction` (variance + similar past cases). Command-center `/scheduling` view live — Matt has visibility on the queue. `@aac/scheduling/suggestSlot` v0 shipped — pure function, 16 tests; policies locked: soft 2 jobs/day with two-pass relaxation, no Saturdays default, 21-day lookahead, DST-correct. QB reconciliation cron `/api/cron/qb-reconcile` deployed 2026-05-29 — daily 15:00 UTC backstop; dedup via `scheduling:directive-by-qb-estimate:{id}` reverse index (populated by `writePendingDirective`); 8 tests. Middleware redeploy `dpl_3qKzhd8ZmfpbmV6zw9rQ5CTdqHa4` activated the cron schedule. **Walk piece #4 (Gemini classifier extension to wire the Quo-text trigger paths) is the next concrete build; Walk piece #6 (propose-dialogue endpoint) remains the customer-visible payoff.**
**Owner:** Matt
**Package home:** `packages/scheduling/`
**Related package:** `packages/quoting/` (duration estimation lives here)
**Supersedes:** the pre-2026-05-29 version of this file (when scheduling was a Walk step inside `apps/agent`)
**Position in plan:** Priority #2 in `docs/PLAN.md`

---

## Goal

Eliminate the manual "create the calendar event, update PD, text the customer" tedium that fires every time a quote gets approved (or an assessment gets requested, or a callback opens). The system listens passively to the same signals Matt already produces and either executes the schedule autonomously (high confidence) or proposes one slot for Matt to confirm (medium/low confidence).

This is high-blast-radius automation: it writes to real customer calendars, sends real customer SMS, and modifies real Pipedrive deals. Trust is earned in stages.

---

## Architecture in one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ TRIGGERS (six paths, all in middleware)                              │
│                                                                      │
│  ┌─────────────────────────┐    ┌──────────────────────────────┐     │
│  │ QB Estimate.Update      │    │ Quo inbound webhook          │     │
│  │ webhook (intuit-sig)    │    │ (existing Gemini classifier  │     │
│  │                         │    │  extended with 4 new labels) │     │
│  └────────────┬────────────┘    └──────────────┬───────────────┘     │
│               │                                │                     │
│         quote_approved              ┌──────────┴──────────┐          │
│         (QB-side)                   │                     │          │
│                                quote_approved      assessment_req,   │
│                                (text/call)         callback_opened,  │
│                                                    manual_schedule   │
│               │                                │                     │
│               ▼                                ▼                     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Daily QB reconciliation cron — webhook backstop              │    │
│  └──────────────────────────────────────────────────────────────┘    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
            ┌───────────────────────────────────────┐
            │  @aac/scheduling (pure functions)     │
            │                                       │
            │  normalize{QbApproval,                │
            │            ManualSchedule,            │
            │            TextApproval,              │
            │            CallApproval,              │
            │            AssessmentRequest,         │
            │            CallbackOpened}            │
            │      → SchedulingDirective            │
            │                                       │
            │  buildEventDescription                │
            │  suggestSlot                          │
            │  executeDirective                     │
            └───────────────────┬───────────────────┘
                                │
              ┌─────────────────┴────────────────┐
              │                                  │
              ▼                                  ▼
       Crawl: shadow queue            Walk/Run: writes
       (Redis +                       (Calendar event,
        command-center)                PD update, customer SMS,
                                       propose-dialogue to Matt
                                       via apps/agent)
```

Algorithm lives in `@aac/scheduling`. Transport (webhook reception, signature verification, Quo SMS send) lives in `apps/middleware`. Matt-facing dialogue lives in `apps/agent`.

---

## SchedulingDirective shape

The unified type every trigger path produces. Discriminated union by `intent`. Provisional; refine during Crawl.

```ts
type SchedulingDirective =
  | QuoteApprovedDirective
  | AssessmentRequestedDirective
  | CallbackOpenedDirective
  | ManualScheduleDirective;

interface BaseDirective {
  id: string;                          // ulid
  createdAt: string;                   // ISO
  source: TriggerSource;               // 'qb_webhook' | 'quo_text' | 'quo_call' | 'quo_outbound' | 'qb_reconciliation'
  confidence: Confidence;              // { score: 0..1, signals: string[] }

  customerPhone: string;               // E.164, normalized
  pdPersonId?: number;
  pdDealId?: number;                   // for callbacks: parent_deal_id
  qbCustomerId?: string;
  qbEstimateId?: string;

  scopeSummary: string;                // LLM-generated, quality-gated
  estimatedDurationHours: number | null; // populated from durationPrediction.point on the QB-approval path
  durationPrediction: DurationPrediction | null; // full prediction (variance + similar cases) — see @aac/quoting
}

interface QuoteApprovedDirective extends BaseDirective {
  intent: 'quote_approved';
  eventClass: 'job';                   // calendar colorId 10 (green)
}

interface AssessmentRequestedDirective extends BaseDirective {
  intent: 'assessment_requested';
  eventClass: 'assessment';            // colorId 3 (purple)
}

interface CallbackOpenedDirective extends BaseDirective {
  intent: 'callback_opened';
  eventClass: 'callback';              // colorId 5 (yellow)
  parentDealId: number;                // links to original job's PD deal
  callbackSequence: number;            // 1 = first callback, 2 = second, etc.
  originalServiceType?: string;
  originalTechnician?: string;
}

interface ManualScheduleDirective extends BaseDirective {
  intent: 'manual_schedule';
  eventClass: 'job' | 'assessment' | 'callback';
  knownSlot?: {                        // when Matt indicates time on a call
    startIso: string;
    endIso?: string;                   // optional; duration model fills in if absent
  };
}
```

The directive is the single hand-off contract. Everything before produces it; everything after consumes it.

---

## The six trigger paths

| Path | Source | Intent | Notes |
|---|---|---|---|
| 1 | QB Estimate.Update webhook | `quote_approved` | Highest-confidence, most structured. Verified via `intuit-signature` HMAC-SHA256. |
| 2 | Quo inbound text (customer) | `quote_approved` | Gemini classifier detects "approved/let's do it/sounds good"; corroborate against open Estimate. |
| 3 | Quo call transcript (customer) | `quote_approved` | Same classifier extension applied to call transcripts. |
| 4 | Quo inbound text (customer) | `assessment_requested` | "Can you come look at it?" / new-customer first contact. |
| 5 | Quo inbound text (customer) | `callback_opened` | "The repair you did is leaking again" — link to most recent completed job. |
| 6 | Quo outbound (Matt) | `manual_schedule` | Matt indicates time on a call/text: "let's get them scheduled Tue 10am." Optionally includes `knownSlot`. |

Daily QB reconciliation cron runs once a day to catch any QB approvals the webhook missed (network blip, signature failure, etc.) and produces a `quote_approved` directive with `source: 'qb_reconciliation'`.

---

## Crawl — Shadow mode, two trigger paths, no writes

**Goal:** prove we can correctly *detect* schedulable events and produce well-formed directives. No calendar writes. No customer SMS. No PD writes.

### Scope

| # | Deliverable | Home | Status |
|---|---|---|---|
| 1 | `SchedulingDirective` type + discriminator helpers + vitest fixtures | `@aac/scheduling/types` | ✅ shipped (10 tests) |
| 2 | QB webhook `/api/qb-webhook` (CloudEvents) with `intuit-signature` HMAC verification | `apps/middleware/api/qb-webhook.ts` | ✅ shipped (21 tests) |
| 3 | `normalizeQbApproval(deps, estimate) → directive` | `@aac/scheduling` | ✅ shipped (11 tests) |
| 4 | Gemini classifier extension (4 new labels: `quote_approved`, `assessment_requested`, `callback_opened`, `manual_schedule`) | `apps/middleware` | ⏳ pending |
| 5 | `normalizeManualSchedule(deps, classification, customer) → directive` | `@aac/scheduling` | ✅ shipped (13 tests) |
| 6 | Shadow queue: write directives to Redis `scheduling:pending:{id}` + `scheduling:pending:list` | `apps/middleware` (`writePendingDirective`) | ✅ shipped |
| 6b | Command-center pending-directives view | `apps/command-center` | ✅ shipped 2026-05-29 (`/scheduling` route — reads `scheduling:pending:list`, renders intent + event-class chip + customer + scope + full `durationPrediction` with similar-cases collapsible + confidence chips + raw JSON; sidebar entry between To-Do and Financials) |
| 7 | **Backtest harness** (90-day window) — replay past Quo + QB events through classifier+normalizer, diff against actual outcome | `tools/src/scheduling-backtest.ts` + `@aac/scheduling/replay` | ✅ scaffolded (8 tests, QB path live; manual-schedule path stub until #4 ships) |
| 8 | **Duration analysis** — join 180-day QB Estimates with calendar events, cluster by service-line + size, produce summary + reference data | `tools/src/scratch/spike-duration-analysis.ts` + `tools/src/scratch/reclassify-and-drill.ts` + `tools/src/scratch/spike-output/duration-analysis-<date>.{md,json}` | ✅ spike complete (n=54 reliable pairs at 180d, classifier refined per Matt's 2-category taxonomy with warranty-boilerplate stripper) |
| 8b | **Duration heuristic codification** — ship `@aac/quoting/estimate-duration` and wire into normalizer | `packages/quoting/src/{classify-scope,estimate-duration}.ts` + `packages/quoting/data/duration-reference-2026-05-29.json` + `packages/scheduling/src/normalize-qb-approval.ts` | ✅ complete 2026-05-29; 34 quoting tests + updated scheduling tests passing; directives now carry full `durationPrediction` blob |
| 9 | Daily QB reconciliation cron (backstop) | `apps/middleware` | ⏳ pending |

### Test gates

- Unit: vitest coverage of all normalizers + classifier labels
- Backtest gate: ≥95% agreement with Matt's actual past behavior on 90-day window; every disagreement either fixed or pinned as known limitation
- Shadow window: 2–4 weeks of live shadow operation. Daily reconciliation catches any missed webhooks.
- **Exit criterion:** during the shadow window, ≥95% of real QB approvals + Matt's real manual-schedule outbounds produce directives matching what he would have done. Zero false-positive directives written for non-scheduling events.

### What Crawl does NOT do

- No calendar writes
- No customer SMS
- No PD writes
- No agent-line propose dialogue (Matt can pull-check the command-center; agent stays silent per [[no-proactive-notifications]])
- No slot suggestion (directive now carries a duration prediction, but the suggestSlot algorithm reading Google Calendar is the next Walk task)

---

## Walk — Single-slot propose-dialogue, Matt in the loop, fixture phone first

**Goal:** prove the system can suggest the right slot, propose it cleanly, and execute writes when Matt approves.

### Build order

1. **Command-center `Scheduling` view** (`apps/command-center/app/(dashboard)/scheduling/page.tsx` + `lib/scheduling.ts`) — ✅ shipped 2026-05-29. Reads `scheduling:pending:list` from Redis, renders each directive with intent + event-class chip + customer + scope (line-clamped with show-more) + full `durationPrediction` (point/p25-p75/cv/confidence/rationale/up-to-5-similar-cases collapsible) + confidence bar with signal chips + raw-JSON disclosure for debugging. Sidebar entry between To-Do and Financials. Gracefully handles legacy directives that predate the heuristic wire-up by showing "No duration prediction" instead of failing.
2. **`@aac/scheduling/suggestSlot`** — ✅ shipped 2026-05-29. Pure function in `packages/scheduling/src/suggest-slot.ts`. Takes `{ directive, existingEvents, now, policy? }` and returns `{ slot, reasoning, daysConsidered, durationHours, durationSource, exceededSoftCap }`. Policies locked per [[project-scheduling-v0-policies]]: soft 2 jobs/day with two-pass relaxation (under-cap first, then ignore cap), no Saturdays by default, 21-day lookahead, 08:00–17:00 work hours in America/New_York. Duration source: `prediction` from directive when present, else `assessment_default` (1h) for assessment intent or `job_default` (2h) for jobs. Manual-schedule directives with a `knownSlot` short-circuit (no search). Multi-day predictions refused with reasoning. DST boundaries handled correctly via offset-resolved-against-instant. Ignores drive time + cross-customer optimization (v1 concerns). 16 tests including DST spring-forward (Mar 8 2026) and soft-cap relaxation paths.
3. **Daily QB reconciliation cron** — ✅ shipped 2026-05-29. `apps/middleware/api/cron/qb-reconcile.ts` scheduled daily 15:00 UTC. Calls `qb.listRecentEstimates(sinceISO)` with default 7-day window (overridable via `?windowDays=N`), filters client-side to `TxnStatus === 'Accepted'`, dedups against the new `scheduling:directive-by-qb-estimate:{id}` reverse index (set by `writePendingDirective` whenever a directive carries a `qbEstimateId`), and replays missing ones through `normalizeQbApproval` with `source: 'qb_reconciliation'`. Per-estimate errors are caught and reported via `logHealthError` so a single bad estimate doesn't kill the whole run. Returns `{ scanned, accepted, alreadyDirectived, directivesCreated, filtered, errors }`. 8 tests.
4. **Gemini classifier extension** — add 4 new labels (`quote_approved`, `assessment_requested`, `callback_opened`, `manual_schedule`) to middleware's existing entity-extraction call. Unblocks the text/call trigger paths #2–6.
5. **`@aac/scheduling/buildEventDescription`** — LLM-summarize scope + Quo conversation history into the calendar event body. Quality gates per [[ai-quality-gates]].
6. **Propose-dialogue endpoint** in `apps/agent` — middleware POSTs directive + suggested slot; agent texts Matt from agent line; Matt replies approve/edit; agent calls back to middleware.
7. **`@aac/scheduling/executeDirective`** — writes Calendar event + PD update + Quo SMS once approved. Idempotency via the directive's `id`.

Each piece is independently shippable and visible from the command-center view (#1) as it lands.

### Scope

- **Duration model v1** (`@aac/quoting/estimate-duration`) — codified from Crawl's duration-analysis findings
- **Slot suggestion algorithm** (`@aac/scheduling/suggestSlot`):
  - Read Google Calendar via `@aac/api-clients`
  - Single best slot, not three: next-available that respects job duration + drive-time + Mike's other commitments
  - Returns `{ startIso, endIso, reasoning: string }` — reasoning is 2-3 sentences that show up in the propose-dialogue SMS
- **Event description builder** (`@aac/scheduling/buildEventDescription`):
  - Inputs: customer name + address (PD), service type (QB Estimate line items), Quo conversation history, photos URL, extracted access notes
  - Output: structured event description for the calendar event body
  - Quality gates per [[ai-quality-gates]]: must include address, must reference at least one QB line item, must not introduce facts absent from source, length ≤ N chars
- **Propose-dialogue endpoint** in `apps/agent`:
  - Middleware POSTs directive + suggested slot + reasoning + draft event description
  - Agent texts Matt from agent line: one slot + reasoning, await approval/edit
  - On approval: agent calls back to middleware → `@aac/scheduling/executeDirective`
- **`executeDirective(deps, directive, slot)`**:
  - Creates Google Calendar event with appropriate colorId (10/3/5)
  - Adds Mike as invitee, photos URL, address, structured description
  - Updates PD deal stage / creates callback child deal (`parent_deal_id`, `callback_sequence`, `original_service_type`, `original_technician`)
  - Sends customer SMS via Quo — LLM-personalized using conversation history per [[llm-personalized-outbound]]
  - Customer-facing language uses "quote" per [[quote-over-estimate]]
- **Add second + third trigger path** beyond QB+manual: text-side `quote_approved` and `assessment_requested`. Callback-opened stays in Run.

### Test gates

- Vitest: full end-to-end coverage with mocked clients
- Fixture phone (`+18287724836`): 5+ successful runs covering each enabled trigger path; verified in browser before claiming success per [[verify-before-showing]]
- First real customer: I check Calendar + SMS + PD in browser before marking shipped
- 10 real customers run cleanly through propose-dialogue before unlocking Run
- **Exit criterion:** zero wrong-slot writes, zero misdirected SMS, customer SMS quality passes Matt's gut check 10/10. Duration model error within tolerance on ≥80% of jobs.

---

## Run — All six trigger paths, confidence-graduated autonomy

**Goal:** the full system. Inbound text + call quote-approvals, assessments, callbacks. High-confidence cases execute without asking Matt; medium/low-confidence cases route to propose-dialogue.

### Scope

- Remaining trigger paths: call-transcript `quote_approved`, `callback_opened` (with PD child-deal creation)
- **Confidence scoring** on directives:
  - Signal corroboration: do QB + PD + Quo agree?
  - Classifier confidence
  - Customer history (have we done jobs for this person before?)
  - Schedule clarity (clear slot vs. ambiguous "sometime next week")
- **Confidence-gated autonomy:**
  - **High** (QB webhook + matching PD deal + clear slot + duration in confident range): execute autonomously. After-action summary SMS to Matt.
  - **Medium**: propose-dialogue (single best slot + reasoning)
  - **Low / ambiguous**: hold in queue, surface in command-center, no Matt ping
- Observability dashboard in command-center: directive volume, confidence distribution, execution outcomes, manual-overrides, callback rate over time, callback rate by service type, callback rate by technician

### Graduation policy

Autonomy threshold starts conservative — probably only QB-webhook-path with strongest corroboration executes autonomously at first. Widens as calibration data accumulates. Each widening is its own [[no-proactive-notifications]]-respecting decision, captured in `docs/DECISIONS.md`.

---

## Backtest harness — Crawl's trust-building tool

`tools/src/scheduling-backtest.ts` — invokable in two modes:

```
# By customer
pnpm tsx tools/src/scheduling-backtest.ts --phone +1XXXYYYZZZZ

# By date range (default 90 days)
pnpm tsx tools/src/scheduling-backtest.ts --from 2026-02-28 --to 2026-05-28
```

For each replayed event the harness produces a row:

| When | Source | Classifier output | Directive (mine) | Actual outcome (Matt's) | Match? |
|---|---|---|---|---|---|
| 2026-04-12 10:31 | text inbound | `quote_approved` (0.91) | suggest Wed 4/13 9am, 4hr, Smith waterproof | scheduled Wed 4/13 9am | slot+intent |
| 2026-04-12 14:02 | text inbound | `none` (0.62) | (no directive) | (no scheduling action) | negative match |
| 2026-04-15 08:50 | text inbound | `manual_schedule` (0.45) | (would have skipped — too low confidence) | scheduled Thu 4/16 1pm | missed intent |

Every disagreement gets categorized: classifier miss, normalizer bug, slot algorithm wrong, duration wrong, edge case worth pinning, or known limitation. Failures get pinned as vitest fixtures so we can't regress.

---

## Duration analysis — completed 2026-05-29

Built as a 2-stage scratch pipeline:
- `tools/src/scratch/spike-duration-analysis.ts` — fetches QB Estimates + Calendar Job events for an N-day window (default 90, used 180), matches events ↔ estimates by address/name/date (event-driven loop, top-match wins), classifies + clusters, writes `spike-output/duration-analysis-<date>.{md,json}`.
- `tools/src/scratch/reclassify-and-drill.ts` — reads the JSON dump, applies Matt's refined classifier (warranty-stripping + 2-category taxonomy + Dillon-pattern filter), regenerates the clustered stats. Faster iteration than re-fetching from QB/Calendar.

**Key findings (2026-05-29):**
- 180-day window: 54 reliable matched pairs after data-quality filter
- Service taxonomy (Matt's, post-lunch correction): two categories only — **crack injection** (urethane / injection / membrane / carbon-fiber-add-on) and **concrete resurfacing** (resurfac / overlay / spall / driveway / stairway / garage / walkway / patio / step / floor cracks even when epoxy / repoint / fieldstone / masonry / brick repair / skim coat). Default-to-resurfacing when no signal but real scope present.
- Carbon fiber stapling is "almost always an add-on to injection" (Matt) — sub-feature, not its own category.
- Distribution: 37 crack injection (68%), 11 concrete resurfacing (20%), 5 genuine mixed (9%), 1 other (Patty's discount-only line).
- Duration medians: crack injection 4h (cv=0.26), concrete resurfacing 5h (cv=0.42), mixed 4h (cv=0.31). No multi-day jobs in 180d (they're scheduled as separate single-day events per Matt).
- **Rate ratio: crack injection earns 1.37× more per crew-hour** ($360/hr vs $263/hr).
- The "warranty boilerplate strip" was the key classifier improvement — AAC's estimates include a templated guarantee line that mentions both services and was causing 33 jobs to misclassify as "mixed."

**Data-quality rule (Dillon-pattern):** matched events under 1.5h are flagged `unreliableDuration` because they're either (a) same-day assessment-to-job conversions where the calendar wasn't updated (per Matt: Michael Dillon, \$2050 crack injection done on the spot during a 30-min assessment slot), (b) multi-day partials, or (c) miscolored. None are legitimate sub-1.5h foundation repair jobs. Filtered from cluster stats but kept in the dataset for reference.

**Reference data ready to ship into `@aac/quoting`:** `spike-output/duration-analysis-2026-05-29.json` will become `packages/quoting/data/duration-reference-<date>.json` once codification starts.

(Original v0 spec preserved below for historical context.)

`tools/src/scheduling-duration-analysis.ts` (v0 plan, superseded by the scratch pipeline above):

1. Pull every QB Estimate accepted in the last 90 days
2. Join each to its actual calendar event(s) — measure end-time minus start-time per job
3. Cluster by service-line (waterproofing, foundation crack repair, epoxy, sump pump, etc.) + size (line-item quantities, dollar bucket, etc.)
4. Output:
   - **Chat summary**: high-level findings — "waterproofing >25 LF = full day in 18/19 cases; epoxy crack <3 cracks = 2hr in 9/11 cases; …"
   - **Detail file**: `docs/analysis/scheduling-duration-analysis.md` — per-cluster breakdown with sample jobs, outliers, confidence intervals

Matt reviews the summary, redirects as needed, signs off. I codify the approved clusters into `@aac/quoting/estimate-duration` v1 (rule-based, with confidence). Future refinement is data-driven as new completed jobs accumulate.

---

## Open design questions

**Block suggestSlot v0** (need answers before/during build):
- **Max jobs per day** — hard cap (e.g., 2 jobs)? Soft target with revenue-maximizing override? Per-tech?
- **Weekday-only or include Saturdays for callbacks** — and for assessments? regular jobs?
- **Salesperson-vs-tech allocation** — when Edward is in the loop, does suggestSlot need a `crewType: 'tech' | 'salesperson'` input, or does it always assume Mike+Matt-tech?
- **Lookahead window** — how far out does suggestSlot look (2 wks? 4 wks?)? The current calendar is booking 1–2 weeks out per the [[aac-operating-model]] memory.

**Defer to v1+**:
- **Drive-time matrix source** (Google Maps Routes API? cached pairwise lookup?) — v0 ignores drive time, picks slots by duration + clear calendar window.
- **Callback parent-deal linkage** — when callback opens via inbound text, how does the classifier identify which past job? Most-recent-completed-for-this-customer is the v0 heuristic; multi-job customers will sometimes mis-link.
- **Quote scope changes** — Estimate revised after directive fired but before event created. Detect via QB SyncToken or re-fetch at executeDirective time.
- **Multi-day jobs** — slot suggestion produces a span vs. a sequence of contiguous events? Dataset has none in 180d; v1 returns `isMultiDay: false` and the heuristic flag is dormant.
- **Customer SMS tone** — LLM-personalized but how much personality? Matt-voice or neutral? See [[agent-vision]] Layer 1 (voice fidelity) for the long-term answer.

---

## Related

- Package CLAUDE: `packages/scheduling/CLAUDE.md`
- Duration estimation home: `packages/quoting/` + `docs/projects/estimate-auto-draft.md`
- Agent's role: `docs/projects/apps-agent.md` (propose-dialogue endpoint only)
- Architecture decisions: `docs/DECISIONS.md` — 2026-05-29 realignment entry
- Plan position: `docs/PLAN.md` priority #2
- Historical: `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` §5 + §9 (the original phase-2.5 slot algorithm sketch — useful prior art for Walk's slot suggestion)
