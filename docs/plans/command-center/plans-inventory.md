# Command Center: Plans Inventory (2026-11-02)

Read-only sweep of every planning doc in the repo, the gitignored `analysis/` tree, all CLAUDE.md files, the tools, the cron config, the `../aac-astro/docs` marketing plans, and Matt's memory index. Purpose: make sure the command center v2 plan (`README.md` + `round-2-funnel-queues-system.md` in this folder) accounts for every live or still-intended automation and plan. "Covered" cites the CC doc section. "GAP" means neither CC doc mentions it.

Status labels: **LIVE** (shipped and running), **ACTIVE** (being built or explicitly next), **PLANNED** (still intended, deferred), **SUPERSEDED** (replaced, named), **DEAD** (abandoned or moot), **unclear** (with the reason).

---

## 1. Summary

**Top gaps**
1. **Manual categorization is not modeled as a "Needs you" item.** The CC plan treats recon as "N txns to approve" in the confirm lane (README §3.2, §4.1). The recon plan's third layer is a judgment list (Venmo, ATM, restaurants, unknown payees, check deposits) where each answer becomes a rule. That needs its own item class, plus a one-time backlog project (66 Beacon items, Opex judgment items, the 690-item duplicate queue, Phillip James) and a "books trustworthy since" flag on every \$ number.
2. **The recon tie-out checks R1 to R7, the Thursday confirm-matches card, the Friday per-tech deposit summary, and commission "paid, awaiting deposit" are missing.** Only the Monday card and the undeposited queue made it into the CC docs.
3. **The Edward keep/cut decision is due end of November 2026** (PLAN.md, DECISIONS 2026-05-27). README §9 Phase 3 says "spring Ed decision", which is wrong. Edward's five KPI floors (salesperson-strategy) are not in the scorecard catalog.
4. **The stale-quote follow-up has never run live.** Memory says sends started around 10/26, but `analysis/data/stale-quotes/` has no `funnel-state.json` or `draft-queue.json` (everything there is dated 10/21) and `tools/src/stale-quotes/` is still untracked. About 88 Pending quotes (about \$250k) sit untouched. There is no "did it run" health check.
5. **System inventory misses several things:**
   - the outside-in watchdog (observability Layer A, still unbuilt)
   - T4 scope-change (uncommitted, shadow mode)
   - `quote-email-tick` and `sweep`, which write no heartbeat
   - the laptop `com.aac.message-drafts` backstop, still loaded about 12 days after its planned unload
   - webhook-registration integrity checks
   - the internal-number skip list
   - Relay Income bounced Intuit pulls
   - aac-astro's `/api/analytics-health` cron
6. **Admin misses the signing-anchored separation clock** (docs 18 and 22: 8822-B 60d, WCRIBMA 90d, HIC amendment 30d, final 1065, GBP access-request denial within 3 days), plus several other items: the GL prior-work backdate and its Sept 2028 sunset, the ZoomInfo non-renewal (ends 12/11), and recurring owner reviews.

**Top gold:** the per-automation confirm/override track record as the evidence base for every auto-send decision (agent-vision Layer 5); Important Dates/renewals (on every spec since March, never built); GA4 click to Quo call correlation (validated at 57% match with 0 false positives, never productionized); the capacity-hold quote list as tech #2 demand evidence; Ads "Stream A" lead disposition (needed before CAC can be trusted); GBP review ingestion plus negative-review flagging.

---

## 2. Every plan doc

CC relevance: **H** = generates items, queues or metrics the CC must show; **M** = some metrics or health checks; **L** = reference only; **none**.

### docs/ (core)

| Path | Purpose | Status | Superseded by | CC relevance |
|---|---|---|---|---|
| docs/PLAN.md | Current roadmap | LIVE (stale in spots: lists `com.aac.quote-shadow` as live, though it was unloaded 10/21; omits T4; calls marketing 4.1 unbuilt and "Puppeteer", though `apps/marketing` has Buffer, Satori and scheduling) | | H, the source of priorities |
| docs/DECISIONS.md | Decision log | LIVE | | M (Edward end-Nov, FHP deferral, Cron B kill) |
| docs/meta-architecture.md | Pillars, Redis topology | LIVE for rules, partly stale | PLAN.md architecture section | M (heartbeat, `logs:webhooks` key never written, "Business Admin" renewals board never built) |
| docs/alt-architecture-multi-repo.md | Rejected multi-repo option | DEAD | monorepo decision | none |
| docs/command-center-spec.md | March 7-card spec | SUPERSEDED | this folder's README.md | M (status thresholds worth reusing) |
| docs/middleware.md | Middleware endpoints | LIVE, endpoint list stale | | M (smoke endpoint, dead-letter, send-safety DNC: all unbuilt) |
| docs/middleware-cutover-rollback.md | aac-slim cutover runbook | DEAD (historical); whether aac-slim is decommissioned is unclear | | M (webhook-registration integrity check) |
| docs/spike-4.0-findings.md | Image pipeline spike | SUPERSEDED (Puppeteer replaced by Satori, 2026-04-04) | apps/marketing | L |
| docs/visual-brand-identity.md | Brand tokens, post templates | LIVE reference | | L (CC tokens already in `@aac/ui`) |
| docs/social-post-dj/DIGITAL-JOURNAL-ARTICLE.md | Sponsored article plan | unclear (no record it was placed) | | L (90-day readout pattern) |
| docs/candidate-review-foundation-repair-tech.md | Indeed applicant ranking, Mar 2026 | DEAD for that hire (gitignored, holds PII) | | L (tech #2 pipeline later; keep PII out of CC) |

### docs/_archive/2026-05-27

| Path | Purpose | Status | Superseded by | CC relevance |
|---|---|---|---|---|
| MASTER-PLAN.md | Old granular plan, phases 0-4 | SUPERSEDED | docs/PLAN.md | H for gold: recurring owner tasks, Important Dates, attribution page, GCLID import, Lighthouse, GBP reviews, marketing batch-ready item |
| middleware-auto-invoicing.md | Cron A + Cron B spec | Cron A LIVE; Cron B DEAD (field app) | apps/field | M (Cron A skip reasons should become items) |
| middleware-phase-2.5-deal-spine.md | Deal spine + comms-line vision | SUPERSEDED | projects/apps-agent.md, projects/scheduling.md | M (11-stage funnel, zero-output cron anomaly, standing rules) |

### docs/projects

| Path | Purpose | Status | Superseded by | CC relevance |
|---|---|---|---|---|
| triage-dashboard.md | Morning triage, D1-D15, L1/L2 | LIVE (header stale; code has D15 and `scope_flag`) | to be absorbed by CC Phase 1 | H, the item seed |
| middleware-observability.md | P1/P2/P3 alerts, watchdog, ack-fast | ACTIVE, partly shipped (ack-fast and D15 yes; watchdog no) | | H for System |
| scheduling.md | `@aac/scheduling` | LIVE (Walk #7 autonomy deferred) | | H (stubs, holds, directives, callback metrics) |
| quote-drafter.md | Drafter v1, manual runs | SUPERSEDED as an operating model | photo-quote-training Phase 6 + `packages/quote-drafter` in the worker | M (open: wrong guarantee variant on masonry/resurfacing drafts) |
| photo-quote-training.md | Photo to quote grounding, triggers T1-T3 | LIVE (observe/harvest mode) | | H (bot draft lane, edit-rate metric) |
| audit-2026-07-remediation.md | Five-track audit | ACTIVE, many items open (P0-5, P0-10, P3-1, P3-2, P3-7 and more; PLAN.md understates this) | | H for System |
| middleware-cleanup.md | Janitorial list | SUPERSEDED | audit P5-5 | none |
| apps-agent.md | Agent + 10-stage deal spine | PAUSED at Walk 2; deal spine backfill never run | | H (funnel stages, `lost_reason`) |
| agent-vision.md | 5-layer agent destination | PLANNED long-horizon | | M (per-action track record = gold) |
| apps-field.md | Field app MVP | LIVE (header stale) | | M (card-paid mismatch, ambiguous match items) |
| apps-field-v2-photos-and-accountability.md | Photos, late logging, owed photos | Partly LIVE (Phase A yes; Phase E owed-photos view not built) | | M (tech accountability metrics) |
| duration-heuristic-design.md | `estimateDuration` | LIVE (reference data about 5 months stale) | | M (estimate accuracy, data freshness) |
| ed-commission-report.md | Ed 20% commission tool | LIVE (manual) | | H (pay-cycle item; Edward channel numbers) |
| estimate-auto-draft.md | Original spike + drafter plan | SUPERSEDED | quoting spike + photo-quote-training | L (approval rate by source/season never computed) |
| invoice-gap-audit-2026-08.md | One-off audit, about \$25k uninvoiced | SUPERSEDED as design by D1/D2/D3; action checklist never ticked | triage D1-D3 | M (confirm Fairweather, Milliken were collected) |
| multiday-jobs.md | Continuation detection | LIVE (step 5 invoice-create guard not built) | | L |

### docs/plans

| Path | Purpose | Status | Superseded by | CC relevance |
|---|---|---|---|---|
| command-center/README.md | CC v2 master plan | ACTIVE draft | | the target |
| command-center/round-2-funnel-queues-system.md | Queues, funnel, scorecard, System | ACTIVE draft | | the target |
| command-center/research-compliance.md | Obligations inventory, COI model | ACTIVE input | | H (Admin) |
| command-center/research-commercial-bids.md | Bid sources, gates | ACTIVE input | | H (Commercial) |
| command-center/research-dashboard-ux.md | UX patterns | ACTIVE input | | design rules |
| weekly-recon-and-deposit-reminders.md | Monday recon + Friday tech deposit texts | PLANNED, not started (no `tools/src/recon/`; file is untracked) | | H (Money core) |
| launchd-to-server-workers.md | Laptop to `apps/worker` migration | LIVE (P0-P2 shipped 10/21); laptop backstop unload overdue | | M (System) |
| t4-scope-change-trigger.md | Scope-change trigger on open quotes | ACTIVE: built 10/29, uncommitted, shadow mode, email channel unverified | | H (Sales queue, System) |

### docs/aac-future (Luc separation and rebrand)

| Path | Purpose | Status | Superseded by | CC relevance |
|---|---|---|---|---|
| README.md | Binder index | Stale (stops at doc 18) | doc 22 + context-preface | none |
| 00-one-pager.md | A vs B summary | SUPERSEDED | docs 14, 19, 22 | none |
| 01-the-decision-compass.md | Gut check | DEAD (fork resolved 10/20) | | none |
| 02-the-core-problem.md | Why 50/50 is a trap | Background | | none |
| 03-psychology-and-persuasion.md | First-conversation script | DEAD (held 10/20) | | none |
| 04-option-a-walk-away.md | Option A playbook | Reference; \$50k parts SUPERSEDED | doc 19 | L |
| 05-option-b-full-succession.md | Buyout path | DEAD unless Luc offers to sell | | L (price limits) |
| 06-action-plan.md | Protect, diagnose, branch | SUPERSEDED | docs 14, 16, 19 | none |
| 07-history-and-current-structure.md | History | Reference | | none |
| 08-connecticut-analysis.md | CT P&L | Reference | | none |
| 09-massachusetts-analysis.md | MA capital | Partly wrong ("never profitable" retired) | doc 20 | none |
| 10-valuation-data-needed.md | Valuation data list | Mostly DEAD | | none |
| 11-legal-and-walkaway-analysis.md | Clause analysis | Reference | | none |
| 12-questions-for-ma-counsel.md | Counsel questions | Mostly absorbed | docs 16, 17 | L (annual-report manager question open) |
| 13-rebrand-name-candidates.md | Name shortlist | LIVE, no name picked | | M (name-pick day triggers filings) |
| 14-exit-execution-plan.md | Post-10/20 phases, asset inventory | Partly LIVE (asset inventory, rebrand list) | doc 22 for terms | H (asset-control checklist) |
| 15-value-provided-to-ct.md | Value evidence | LIVE, held in reserve | | M (data-retention archiving) |
| 16-entity-transition-and-money-mechanics.md | Keep-entity mechanics, conduct rules | LIVE | | H (cutover rule; signer change urgent) |
| 17-counsel-briefing-2026-10-24.md | Briefing to counsel | Used (call 10/27) | | none |
| 18-rebrand-notification-ledger.md | Everything the rebrand touches | LIVE, the main item source (§3.2 "remove Luc now" overridden by doc 19) | | H (Admin obligations) |
| 19-release-strategy.md | 10/27 decisions, calendar | Partly LIVE | docs 20, 22 for package/terms | H (forcing-step calendar) |
| 20-written-package-cover-and-term-sheet.md | Written package | Partly LIVE (package gaps list) | doc 22 for terms | M |
| 21-hardball-line-analysis.md | Tougher sequencing | Not adopted; partly folded into doc 22 | doc 22 | L |
| 22-opening-position-and-concession-ladder.md | Current offer + send order | ACTIVE, source of truth | | H (deal-term clocks at signing) |
| adversarial-vetting-prompt.md | Reviewer prompt | DEAD (June facts) | | none |
| agent-prompts/* (4 files) | Review prompts, context preface | Historical; prompt 2 useful as a risk register | | none |

### analysis/ (gitignored)

| Path | Purpose | Status | Superseded by | CC relevance |
|---|---|---|---|---|
| 00-charter.md | Objective, kill criteria, May 2027 | LIVE | | H (This month tracker, scoreboard) |
| README.md | analysis/ index | Stale (calls dashboard.html the cockpit) | CC | none |
| 01-diagnostic/financials.md | Financial baseline v2 | Partly SUPERSEDED (2026 numbers unreliable; "26% quote-to-invoice gap" refuted) | QBO fix + quoting spike | M (gross margin, customer concentration) |
| 02-strategy/direct-mail-service-research.md | Funnel B vendors | Dormant reference | | none |
| 02-strategy/foundation-health-plan.md | \$199/yr plan | unclear: front-end may never have launched (no QBO item, PD fields or memory trace); back-end PLANNED/deferred | | M (member queues, renewals) |
| 02-strategy/funnel-a-dormant-reactivation.md | Dormant quote reactivation | SUPERSEDED | stale-quote-followup-plan | L (offer matrix) |
| 02-strategy/funnel-b-neighborhood-blitz.md | Neighbor mailers on acceptance | PLANNED, deferred | | L |
| 02-strategy/gl-insurance-review-2026-09.md | Kinsale exclusions | LIVE reference | | H (Admin items) |
| 02-strategy/levers.md | Ranked levers | Partly stale | | M ("top 3 weekly questions") |
| 02-strategy/marketing-strategy.md | Paid restart plan | SUPERSEDED (exact copy of the archived file; leftover) | DECISIONS 2026-05-27 | none |
| 02-strategy/message-automation-analysis-2026-10.md | Outbound automation | LIVE (draft mode) | | H |
| 02-strategy/mike-call-field-app-test-plan-2026-06-04.md | Field test + review button | Done; review-ask button and gallery link not built | | M |
| 02-strategy/mike-raise-conversation-2026-06-04.md | Raise + expectations | Delivered; expectations untracked | | M (People) |
| 02-strategy/new-funnels.md | Funnels A-F | A absorbed; B/D/E/F deferred; C effectively DEAD (ZoomInfo cancelled) | | L |
| 02-strategy/photo-corpus-phase2-findings.md | Blind baseline | SUPERSEDED | v3 holdout, live drafter | none |
| 02-strategy/quoting-patterns-spike.md | Pricing forensics | LIVE | | M (pricing tripwire) |
| 02-strategy/realtor-outreach-plan-2026-09.md | Realtor DB for Edward | PLANNED, gated on Edward decision | | M |
| 02-strategy/salesperson-strategy.md | Edward KPIs | LIVE; decision due now | | H |
| 02-strategy/stale-quote-followup-plan-2026-10.md | Stale-quote automation | ACTIVE: Phase 1 built, live run apparently never happened | | H |
| 02-strategy/tech2-hiring-plan-2026-08.md | Tech #2 gates | LIVE (Nov 1 reserve deadline passed, status unknown) | | H |
| _archive/2026-05-27/marketing-strategy.md | Archived copy | SUPERSEDED | | none |
| google-ads-review-2026-08-18.md, -checkin-2026-08-27.md, -rain-push-2026-09-25.md | Ads audit and changes | Executed, open leftovers (LSA \$0, wet-basement 404, Stream A, extensions) | | M (Marketing items, Ads drift check) |
| handoff-worker-migration-for-stale-quotes-2026-10-21.md | Worker integration notes | LIVE reference; "unload ~Oct 28" not done | | M |
| quo-draft-api-capabilities-2026-10.md | Quo has no drafts API | LIVE reference | | L (deep-link pilot undone) |
| quo-mms-support-ticket.md | Inbound MMS failures | unclear (no record it was filed) | | M (MMS failure detector) |
| scheduling-two-job-policy-2026-10-16.md | Two-job day policy | LIVE | | M (lateness monitor) |
| session-log-2026-10-16.md | Changeset log | Historical with loose ends | | L |
| zoominfo-cancellation-email-2026-10-16.md | Non-renewal notice | unclear outcome (term ends 12/11, \$450.29/mo) | | M (Admin item) |
| qbo-2026-recon/*.csv | 757 bank txns missing from QBO (Jan to Oct) | ACTIVE workpapers for the books fix | | H (Money backlog) |
| data/bank-reconciled/summary.md | Bank categorization 2024-08 to 2026-06 | Stale (ends June) | QBO after Phillip's fix | M (don't build tiles on it) |

### CLAUDE.md files and tools (descriptive, not plans, but with planned work)

| Path | Planned or unbuilt work found | CC relevance |
|---|---|---|
| apps/command-center/CLAUDE.md | "Read-only, no data of its own"; Day-One list included Business Renewals from Pipedrive | Rule must change (README §8 already says so) |
| apps/agent/CLAUDE.md | propose-dialogue endpoint, Layers 1/3/4 | L |
| apps/field/CLAUDE.md | v2 match via `getDeal` | M |
| apps/marketing/CLAUDE.md | SMS campaigns, `stats:campaign:*` | L (dormant) |
| apps/worker/CLAUDE.md | Endpoints and modes | H for System |
| packages/quote-drafter/CLAUDE.md | T4 rules, ownership one-way door | H |
| packages/quoting/CLAUDE.md | Stale ("empty at scaffold") | none |
| packages/scheduling, shared-utils, agent-tools, api-clients CLAUDE.md | Agent read tools usable as Customer page fetchers | M |
| tools/src/triage | 15 detector families, pulse tiles, `dismissals.json` | H (Phase 1 parity list) |
| tools/src/stale-quotes | Phase 2 (worker + auto-close) unbuilt | H |
| tools/src/commissions | Pay cycle, ledger | H |
| tools/src/analysis | `ingest-bank.ts` finds uncategorized spend | M |
| tools/src/setup/backfill-deal-spine.ts | Never applied (gated on Funnel A cleanup) | H (funnel data) |

### ../aac-astro/docs (skimmed; spend cut about 80% in 2026, so mostly dormant)

| Path | Status | CC relevance |
|---|---|---|
| ANALYTICS-PLAN.md (3/26) | Phases 1-2 done, Phase 7 "unified dashboard" unbuilt | M (anomaly playbook, weekly/monthly KPIs) |
| MARKETING-PLAN-2026.md (Mar) | Dormant | L (monthly KPI list) |
| GOOGLE-ADS-STRATEGY.md (6/4) | Partly dormant | M (spend, CPL, impression share) |
| REVIEW-MAXIMIZATION-PLAYBOOK.md (5/11) | unclear (Birdeye fix-or-kill open) | H (review velocity, 24h response) |
| LOCAL-MAP-PACK-OPTIMIZATION.md, SERP-DOMINATION-PLAN.md, SEO-STRATEGY-2026.md (May) | Dormant | M (rank tracking, GBP post cadence) |
| CONTENT-CALENDAR-2026.md, VIDEO-STRATEGY-2026.md | Dormant | L |
| BACKLINK-* and vendor docs (Apr-May) | Dormant, last order May | L (pending order verification) |
| DRAFT-LINK-TRACKING.md | Dormant | none |
| `api/analytics-health.ts` cron (09:00 daily) | LIVE | M (fold into System) |

---

## 3. Gaps by area page

Format per entry: what it is, source system, lane, and whether the CC docs cover it.

### Money (first, as asked)

**A. Weekly reconciliation** (`docs/plans/weekly-recon-and-deposit-reminders.md`, PLANNED)

| What the CC must surface | Kind | Source | Lane | Covered? |
|---|---|---|---|---|
| Monday "run the weekly recon" card with last week's result; one line "Books tie, 0 exceptions" on clean weeks | Item | Recon report `analysis/recon/YYYY-MM-DD.md` + Redis | Today (Mon) | Covered (README §3.2 This week, §9 Phase 1 step 6) |
| Obvious categorizations batch (count + sum per account) to approve | Item, confirm lane | QBO For Review via Chrome session | Today (Mon) | Covered (README §4.1 "recon categorizations") |
| **Judgment items needing manual categorization**, each with a best guess, where Matt's answer becomes a QBO rule or a `category-map.ts` entry (Venmo, ATM cash, restaurants/Topgolf as possible draws, unknown payees, check deposits that must be MATCHED, not posted) | Item, Needs you | QBO Banking + category map | This week, → Today Monday | **GAP.** The CC treats categorization as confirm-only. It needs its own item class with a "make this a rule" verb, and a metric for "judgment items per week" (should trend down). |
| Recon exceptions | Queue | Recon | This week | Covered (round-2 §2 "Recon exceptions") |
| R1 each Relay sub-account feed has a txn < 3 business days old (dead-feed check, the January failure) | System check | QBO Banking UI (Phase 1) or Plaid (Phase 2) | P1 to Today | **GAP** (round-2 §5 lists "weekly recon" only as planned) |
| R2 QBO posted balance = Relay balance per sub-account | System check + Money tile | QBO + Relay | This week | **GAP** |
| R3 For Review count + oldest item per account | Metric (backlog) | QBO Banking | This week scorecard | **GAP** |
| R4 cash/check Payment > 5 business days still in Undeposited Funds | Item + queue | QBO API | Today on Friday noon | Covered (README §4.2 auto-promotion, round-2 §2 Undeposited queue) |
| R5 every QB Deposit (incl. field app) matches a real Relay deposit within 5 business days (`Clr` flag) | Item | QBO API (`Clr` column) | This week | **GAP** (only "undeposited" is covered; "marked deposited but never landed" is a different, worse class) |
| R6 each QB Payments payout has exactly one Relay Income (0867) match | System check | QBO API | This week | **GAP** |
| R7 any new activity on Beacon 1082 (should be dormant, balance \$93.71) | System check | QBO feed | This week | **GAP** |
| Noon Monday fallback text if no recon report exists | Alert | Worker | text | Covered (README §4.2 last bullet) |

**B. Friday technician deposit reminders** (same plan, Part 2)

| What | Kind | Source | Lane | Covered? |
|---|---|---|---|---|
| Thursday card "N flagged deposits still uncleared in QBO, confirm suggested matches before Friday 8am" (only on problem weeks) | Item | QBO `Clr` + Redis recon list | Today (Thu) | **GAP** |
| Friday per-tech summary of what the text said (Matt sees it, no text to Matt) | Confirm-lane item | Worker deposit-reminder run | Today (Fri) | **GAP** (README mentions "deposit-reminder dry runs" only) |
| Items held back from a tech's text because matches weren't confirmed | Item | Worker | Today (Fri) | **GAP** |
| Payments with no field-app record (mailed checks, Matt-entered) routed to Matt, never a tech | Item | QBO + `keys.fieldCompletion` | This week | **GAP** |
| Deposit reminder ran / sent / dry-run state, `DEPOSIT_REMINDERS_ENABLED` flag | System check | Worker | System | Partly (round-2 §5 "Planned: Friday deposit reminders") |
| `Clr` negative-control verification on the first real deposit (one-time) | Item | QBO | This week, one-time | **GAP** |
| Mike's written deposit expectations doc delivered (one-time; rollout precondition) | Item | Manual | This week | **GAP** (see People question) |

**C. "Paid is not banked"** (same plan, Part 3)

| What | Kind | Source | Lane | Covered? |
|---|---|---|---|---|
| Ed commission counted only when every Payment is banked; "paid, awaiting deposit" bucket | Metric + Money detail | `tools/src/commissions` + shared `isBanked()` | This month (pay cycle) | **GAP** (README §2 notes the bug, but the CC Money page doesn't define the state) |
| Daily aging line "paid, not banked" (not just Mondays) | Metric | Undeposited Funds | Today strip / Money tile | Covered (round-2 §4a "Paid to deposited, days", "Undeposited \$") |
| Undeposited Funds balance shown next to revenue | Metric | QBO | This month | **GAP** (small) |

**D. 2026 books repair (one-time project, analysis/qbo-2026-recon + memory)**
- Remaining backlog as tracked items with evidence, not a spreadsheet: 66 Beacon "1082 - 1" judgment items (7 to 8 check deposits about \$19.6k to \$24.3k to MATCH, about 21 Venmo, 6 ATM \$1,720, round trips, checks #9007/#9008, small unknown vendors), Relay Opex judgment items (Dependable Depot \$3,222.60, check #001002 \$1,375, Venmo, PSI Testing, etc.), Webster Bank \$1,396.21, the 690-item "1082 - 2 - 1" duplicate queue to EXCLUDE only after 1082-1 ties, the account merge, and the Phillip James engagement. **GAP.** The CC assumes the books get fixed but has no place to track the fix.
- **"Books trustworthy through" date** shown on every \$ metric and blocking the auto-generated `03-scoreboard` files until set. Round-2 §3 "Data reality" mentions the caveat for the funnel only. **Partial GAP.**
- The 11 undeposited customer payments (\$18,650, Jun 19 to Oct) plus the Ed Spooner \$5,975 check: clear before the first Friday send. Covered as the undeposited queue, but the one-time backlog needs to be seeded as items.
- Payroll run-rate looks high (about \$10k/mo; verify whether it's Ed's W-2 commissions). **GAP**, Money question.

**E. Other Money items found**

| What | Source doc | Kind / lane | Covered? |
|---|---|---|---|
| Lost-mail AR (Quincy mailbox failing since Jan): Burke/Markis \$7,800, Champion \$2,050, plus items that are probably in the mail; remit-to fix (ACH first, Pembroke c/o Edward) | memory quincy-mail-failure | Items + an AR "lost mail" tag; This week | **GAP** (AR aging covered; the "mailed but never arrived" class isn't) |
| Relay Income sweeps leaving \$0 so Intuit ACH pulls bounce (QB Payments suspension risk). Fixed 10/29 by switching to daily sweeps, but needs a check | memory qbo-2026-books-broken | System dependency check | **GAP** |
| Cron A (invoice-create) skip reasons (no PD match, no QB customer, multiple accepted estimates, no email) as items instead of logs | _archive/middleware-auto-invoicing.md | Item, Today | **GAP** (D1 catches the result later; the cause is lost) |
| Invoice-create marks done before creating the invoice (audit P3-1, at-most-once) | audit-2026-07 | System correctness check | **GAP** (round-2 §5 has "every completed job has an invoice within 24h", which catches the symptom) |
| Ed commission pay cycle: run, email payroll, `--commit` ledger | ed-commission-report.md | Item, This month | **GAP** (README lists commissions on Money, no cycle item) |
| Year-end annual-renewal cash cluster (\$12-15k Dec-Jan) | tech2-hiring-plan | Metric/forecast on This month | **GAP** |
| Tech #2 vaults (reserve \$25-30k by Nov 1, truck \$10-12k by Feb, carry \$23-28k by Jan 31) with the "only counts if Profit First allocations weren't shorted" rule | tech2-hiring-plan | Metric + dated items | Covered as "vault tracker" (README §3.2, §5); **GAP** for the dated deadlines (Nov 1 passed, Dec 31 checkpoint, Jan 31 go/no-go) |
| Customer concentration (top 10 = 18.9%) | financials.md | Monthly metric | **GAP** (minor) |
| GL audit exposure vs rating basis (about \$985 per extra \$50k) | gl-insurance-review | Monthly metric | **GAP** (minor) |
| Invoice-gap audit leftovers (Fairweather \$10,300/\$2,800, Milliken \$5,375) never ticked | invoice-gap-audit-2026-08 | One-time items | **GAP** (verify) |
| Lorraine Sheehan \$675, Ellen #1210 \$875 unpaid since April | memory, session log | AR items | Covered by D3, if not dismissed |

### Sales

| What | Source | Kind / lane | Covered? |
|---|---|---|---|
| **Edward keep/cut decision, end of November 2026**, with the forensic readout (channel revenue vs fully loaded cost) | PLAN.md near-term #2, DECISIONS 2026-05-27, salesperson-strategy | Item (This week now) + Marketing channel row | **GAP / conflict:** README §9 Phase 3 says "spring Ed decision" |
| Edward KPI floors: net new partners (+5 / +30), meetings logged (+15 / +100), attributed leads (+10 / +40), attributed pipeline (\$10k / \$60k), closed-won (2-3 / 12+); early-kill rule "miss 3 of 4" | salesperson-strategy | Scorecard rows (monthly) | **GAP** (round-2 §4a has no partner/meeting rows) |
| Stale-quote follow-up: run status, drafts to send, awaiting-human list (red at 14d), needs-call quotes, flip-to-accepted, recommend-close | stale-quote-followup-plan, `run.ts` | Queue + items | Covered as a queue (round-2 §2 "Quotes awaiting decision"); **GAP** for "has the runner run in N days" (it hasn't) |
| **Capacity-hold queue** (15 large quotes about \$60k+ parked until tech #2) | stale-quote plan §6.3 | Queue + tech #2 evidence metric | **GAP** |
| T4 scope changes on open quotes (`quote-drafter:scope-flags`), human-owned → item, bot-owned → regenerated (confirm lane) | t4-scope-change-trigger.md | Item, Today; queue | **GAP** (not in round-2 queue catalog) |
| Open-quote index `quote-draft:open` as the canonical "quotes awaiting decision" population | T4 code | Queue source | **GAP** (worth reusing) |
| Price check when a customer accepts an old quote priced off the current policy | stale-quote plan §4.6 | Item, Today | **GAP** |
| Deal spine 10 stages + `lost_reason` (fit miss vs sales loss) | apps-agent.md, DECISIONS 2026-05-28 | Funnel stages + loss-reason metric | Partial: round-2 §3 defines its own stages and a lifecycle ledger. Reconcile with the PD deal spine (backfill never applied) and add `lost_reason` capture. |
| Pricing elasticity tripwire: \$1,000-2,500 win rate 71%, act below about 63% over two quarters; pricing-change markers 10/16, 10/27 | quoting spike, session log | Scorecard row with threshold | Partial (round-2 §3 change log; close rate by size bucket in §4a); threshold is a **GAP** |
| Bot draft wrong guarantee variant on masonry/resurfacing | quote-drafter.md | AI quality check | **GAP** |
| Inbound MMS failures ("can't send pictures") | quo-mms-support-ticket | Item + System check | **GAP** |
| Approval rate by price bucket / source / season | estimate-auto-draft.md | Metric | Covered (round-2 §4a close rate cuts) |
| Realtor outreach: tiers, conversations/week, referring realtors | realtor-outreach-plan | Queue + metrics, gated on Edward | **GAP** (park until the decision) |
| FHP enrollments/attach rate | foundation-health-plan | Metrics | **GAP**, but only if FHP is live (see questions) |

### Jobs

| What | Source | Kind / lane | Covered? |
|---|---|---|---|
| Tech accountability: % jobs logged same-day vs late, owed photos (Phase E unbuilt) | apps-field-v2 | Scorecard + queue | **GAP** (relevant to tech #2) |
| Scheduling observability: directive volume, confidence distribution, manual overrides, callback rate by service and tech | scheduling.md Run | Metrics | Callback rate covered (§4a); the rest is a **GAP** |
| Two-job day lateness on suggested afternoon slots | scheduling-two-job-policy | Metric/check | **GAP** |
| Duration reference data age (regenerate every 30-60 days; now about 5 months old) | duration-heuristic-design | System/data freshness | **GAP** |
| Card-paid-but-QB-unpaid mismatch; ambiguous job-to-invoice match | apps/field CLAUDE.md | Items, Today (Money) | **GAP** |
| Review-ask button in the field app, gallery deep link (promised 6/4) | mike-call test plan | Build items | not CC scope; note for Marketing |
| Multi-day invoice-create guard (step 5) | multiday-jobs | System correctness | **GAP** (minor) |

### Marketing

| What | Source | Kind / lane | Covered? |
|---|---|---|---|
| Reviews: velocity (3.3/mo now, target 7-10), review conversion (reviews ÷ jobs), respond within 24h, 1-2 star flag to Today | REVIEW-MAXIMIZATION-PLAYBOOK, MASTER-PLAN §4.11 | Metrics + items | Partial (round-2 §2 "Reviews to answer", §4a reviews); velocity target and negative-review → Today are a **GAP** |
| Skip the review-prompt SMS if the customer already reviewed | MASTER-PLAN §2.5D | Correctness check | **GAP** |
| Ads drift check: bidding strategy, tCPA, auto-apply recommendations off, never more than 30 days unreviewed (change history only goes back 30 days) | google-ads docs, memory | System dependency + monthly item | **GAP** |
| LSA enabled but \$0 spend for months; wet-basement landing page 404; no ad extensions | google-ads docs | Items (one-time) | **GAP** |
| Stream A lead disposition (real cost per booked job), the stated gate on every Ads budget decision | google-ads-review | Prerequisite for CAC | **GAP** (README §5 says CAC depends on recon; it also depends on this) |
| aac-astro `/api/analytics-health` (GA4 events flowing), Lighthouse, content decay, position tracking | aac-astro, MASTER-PLAN T.1 | System checks + monthly metrics | **GAP** (README §5 says "website/ads health" with no definition) |
| Marketing batch ready for review; publish failures | MASTER-PLAN §4.2B/§4.3E, apps/marketing | Items | Covered loosely (README §9 Phase 3 step 3) |
| Search Console 16-month and GBP report 18-month retention: archive on a schedule | aac-future doc 15 | Recurring item / job | **GAP** |
| Post-rebrand: review count survives, crack-repair ranks, LSA/10DLC/CNAM done | doc 18 | Metrics for 30-90 days after cutover | **GAP** |

### Admin

| What | Source | Kind / lane | Covered? |
|---|---|---|---|
| Separation clock anchored to the signing date (not fixed dates): 8822-B within 60 days, WCRIBMA Form 2020 within 90, final 1065 + K-1, bank signer cards + beneficial ownership, notify carriers; at cutover HIC d/b/a amendment within 30 days, EPA RRP within 90 if certified | aac-future docs 18, 22 | Obligation instances computed from a "signing" anchor | Partial: README §6 "per entity" and doc 18 import. **GAP:** the registry needs event anchors (signing, cutover, name-picked), not just dates. |
| Deal-term clocks after signing: name exit 90 days, domain handover at most 90 days (after building Luc's CT site), 60-day transition support, 301s for 18 months, transition notices 6 months, non-competes about 2 years, CT lead routing end date | doc 22 | Obligations + items | **GAP** |
| Now, before signing: deny any GBP access request within 3 days; check Maps suggested edits weekly; review snapshot; 2FA | doc 18 §3, doc 19 | Recurring item (weekly) + urgent item | **GAP** |
| Negotiation calendar: Zach review (call Thu 11/5 if silent), forcing step about 11/20, offer open to 12/15, target 12/31 | docs 19, 22 | Items | **GAP** (sensitivity: see questions) |
| Asset-control inventory: registrar, Quo owner, Workspace admin, Ads/LSA/GA4/GSC owners, bank signers (urgent), subscriptions in Luc's name | doc 14, 16 | Checklist items | **GAP** |
| GL: ask Kinsale to backdate prior-work date; the 9/6-10/13/2025 gap; get loss runs; report any 2024-25 claim before Sept 2028; shop renewal from Aug 2027; keep expired policy PDFs | gl-insurance-review | Obligations + documents vault | Partial (README §6 GL renewals and audits); the prior-work fix and Sept 2028 sunset are a **GAP** |
| ZoomInfo non-renewal: watch for \$450.29 charges, term ends 12/11, escalation ladder | zoominfo email | Money/legal item | **GAP** |
| Recurring owner reviews (quarterly budget, monthly cost/inventory, review follow-up check), seasonal prep, equipment maintenance | MASTER-PLAN §1C, command-center-spec card 7 | Recurring items | **GAP** |
| Diagnostic backlog the charter still lists: owner-hours log, CAC by source, job profitability variance, utilization; the never-written `six-month-plan.md` | 00-charter | This month items | Partial (owner hours in README §11 Q4) |
| Monthly `03-scoreboard` file generated | 00-charter | Auto-artifact | Covered (README §3.2 This month) |
| Mike's CSL test date, Matt's CSL | mike-raise, research-compliance | Obligations | Covered (README §6) |
| Mike expectations (deposits by Friday, no cash withdrawals, >\$200 purchase text, callbacks, reviews) | weekly-recon plan, mike-raise, memory | People | **GAP** (README §11 Q1 asks whether People is an area) |

### Commercial

Covered by README §7 and `research-commercial-bids.md`. Nothing new found in older docs beyond levers.md Tier 3 "move upmarket to commercial" (same idea).

### System

Round-2 §5 is strong. Additions:

| What | Source | Covered? |
|---|---|---|
| Outside-in watchdog (pipe freshness vs Quo truth at 15 min, PD at 60 min, cron cadence, heartbeats, `/api/health` reachability, watchdog's own heartbeat) and the §6 four-injected-failure acceptance test | middleware-observability §3, §6 | Partially implied (round-2 §5 layers 1, 6). **GAP:** name the watchdog as the build, since it's unbuilt two weeks after being made ACTIVE |
| `quote-email-tick` and `sweep` write no heartbeat; T4 mode; Gmail scope probe; open-index age (`open-synced-at`); gate yes-rate | T4 code, worker | **GAP** |
| Laptop `com.aac.message-drafts` still loaded; per the sweep its log is 27MB of Quo 429s, competing with the worker for rate limit | launchd plan, handoff doc | **GAP** (also an action: unload it) |
| Stale-quote runner "last live run" | stale-quotes | **GAP** |
| Quote-drafter assets manifest present and fresh (`quote-draft` returns 409 without it) | quote-trigger/sync-assets | **GAP** |
| Webhook registration integrity (Quo/PD/Google Ads webhooks still enabled and pointed at the right project); `/api/smoke` per-API connectivity | middleware.md, cutover doc, Quo incident | Partial (round-2 §5 layer 5 "Quo webhook still enabled"); PD/Ads and smoke are a **GAP** |
| Internal-number skip list correctness (Ed's cell, tech cells, agent line must not flow through customer pipelines) | PLAN.md deferred | **GAP** (outcome check) |
| Send-safety DNC check, dead-letter queue (P3-7), `logs:webhooks` stream never written | middleware.md, audit, meta-architecture | **GAP** |
| Audit P0-5 (CC auth) | audit | Covered (README §8 "fix first") |
| Audit P0-10 `/api/health` PII leak, P3-2 inbound leads without PD deals (attribution gap right before the Edward decision), P4-5 QB pagination truncation, P4-6 429/timeouts | audit | **GAP** |
| Zero-output cron anomaly ("ran but matched nothing when N expected") | deal-spine doc §1.4 | Covered in spirit (round-2 §5 layer 6) |
| Per-automation confirm/override rate as the auto-send evidence surface | agent-vision Layer 5, photo-quote harvest | Partial (round-2 §5 layer 4 "quality"); see Gold #1 |
| aac-astro analytics-health cron, Gemini Prepay balance, Google token scopes | aac-astro, memory | Gemini/OAuth covered (round-2 §5 layer 5); aac-astro is a **GAP** |
| Relay Income \$0 / bounced Intuit pulls | memory | **GAP** (also under Money) |

---

## 4. Gold to revive

1. **Per-automation confirm/override track record** (agent-vision Layer 5; scheduling "manual overrides"; `harvest-edits.ts`). Every confirm-lane click is a label. A per-automation "accepted unedited %" over time is exactly the evidence PLAN.md keeps saying it needs before quote auto-send, message auto-send and Walk #7 autonomy.
2. **Important Dates / renewals** (MASTER-PLAN §1.7, command-center-spec card 7, meta-architecture "Business Admin" board, command-center CLAUDE.md Day-One list). On every spec since March and never built. The compliance research now supplies the content.
3. **GA4 click to Quo call correlation** (MASTER-PLAN §1.11A, `tools/src/scratch/test-call-correlation.ts`). Validated at 57% match with 0 false positives. It fills the top of the funnel by source and strengthens the Edward and CAC readouts.
4. **Capacity-hold quote list as tech #2 evidence** (stale-quote plan §6.3). About \$60k+ of large-resurfacing demand parked "until tech #2" is the demand gate the hiring plan asks for, already computed.
5. **Stream A lead disposition** (Google Ads review, three times). Without it, CAC by channel on the Marketing page is guesswork.
6. **GBP review ingestion, AI-suggested replies, negative-review flag** (MASTER-PLAN §4.11). `apps/marketing/reviews` is still "Coming soon"; reviews are the most cited local-ranking lever in the aac-astro playbooks.
7. **levers.md "top 3 weekly questions"** (booked 2-3 weeks or 1-2? FHP attach? Edward pipeline trend?). A ready-made This week header.
8. **Tech accountability metrics** (late logging, owed photos; field v2 Phase E). Cheap, and it becomes the onboarding scorecard for tech #2.
9. **Dropped-lead counter** (message-automation analysis: about 35 real leads never answered over 26 months). A weekly red row, not just a p75 reply time.
10. **Data-retention archiving** (doc 15). GSC and GBP history expire at 16 to 18 months; a scheduled export protects the funnel and seasonality baselines the CC depends on.
11. **Field photos to website SEO and project discovery** (field v2, MASTER-PLAN §2.5G). Real before/after content for the 4.1 pipeline that AI can't generate.
12. **Standing rules list** ("stop sending review prompts to commercial customers"; deal-spine doc §7.3.3). Fits CC Settings next to mute rules.
13. **Cron A skip reasons as items** (auto-invoicing doc). Turns silent log lines into actionable exceptions at the source.

---

## 5. Open questions for Matt

1. **Edward timing:** PLAN.md and DECISIONS say the keep/cut decision is end of November 2026; README §9 says spring. Which is it? If November, the readout is needed this month, before the CC exists.
2. **Stale-quote follow-ups:** did the live sends ever start? The data folder shows no live run since 10/21 and the code is uncommitted.
3. **Manual categorization:** OK to model judgment items as "Needs you" items with a "make this a rule" action, separate from the confirm-lane batch?
4. **Books trust date:** should every \$ number, and the scoreboard files, be held back (or watermarked) until Phillip's fix lands?
5. **Separation/rebrand in the CC:** should the Luc negotiation calendar and deal terms live in Admin (visible on the phone), or only the post-signing obligations? Who else could ever see the CC?
6. **FHP:** did the front-end (pitch + agreement at job close) ever launch? If not, drop the FHP rows.
7. **People area:** Mike's expectations (deposits, cash, purchases, photos, reviews), CSL, the tech #2 pipeline. Its own area, or inside Jobs?
8. **Laptop backstop:** OK to unload `com.aac.message-drafts` now? It appears to be failing on Quo rate limits.
9. **ZoomInfo:** did they confirm non-renewal? Any charges since?
10. **Invoice-gap leftovers:** were Fairweather and Milliken (August audit) collected?
11. **Wind-down vs name exit:** doc 18's 120-180-day trademark wind-down vs doc 22's 90-day name exit; which goes in the registry?

**Could not classify with confidence:** `docs/social-post-dj/DIGITAL-JOURNAL-ARTICLE.md` (placement unknown), `analysis/quo-mms-support-ticket.md` (filed?), `analysis/02-strategy/foundation-health-plan.md` (front-end launched?), `analysis/zoominfo-cancellation-email-2026-10-16.md` (outcome), `docs/middleware-cutover-rollback.md` (aac-slim decommissioned?), `../aac-astro/docs/REVIEW-MAXIMIZATION-PLAYBOOK.md` (Birdeye fix-or-kill).
