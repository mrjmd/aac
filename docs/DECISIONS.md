# Decisions Log

Running log of architectural and strategic decisions. Each entry: date, decision, why (context), and what alternatives were considered.

When a decision gets reversed, ADD a new entry with the reversal — don't delete the original. The history of changed minds is the value.

---

## 2026-05-27 — Cat 2 (subtractive) work precedes Cat 3 (additive) work

**Decision:** All operational/development work is classified as Category 2 (removes existing burden) or Category 3 (adds new revenue + new burden). Cat 2 ships before Cat 3 in the current sprint.

**Why:** Matt's deep-work time is the binding constraint on output. Cat 3 work — even when it succeeds — adds operational maintenance (campaign management, attribution wiring, ongoing optimization). Cat 2 work frees time without adding maintenance. Sequencing Cat 2 first means Cat 3 work can later be done without crushing the calendar.

**Alternatives considered:**
- Continue the historical 1/3 day-to-day / 1/3 demand-gen / 1/3 systems split — rejected because the three categories interpenetrate (most demand-gen work IS systems work).
- Demand-gen first because it's hot season — rejected because Funnel A (the highest-ROI demand work) is itself Cat 2, and most other demand channels are slow-ramp (won't catch this season anyway).

**How to apply:** When prioritizing a new project, ask "does this subtract from Matt's existing burden, or add to it?" If it adds, defer until the Cat 2 sprint demonstrates freed time.

---

## 2026-05-27 — Agent runtime lives in new `apps/agent/`, not in middleware

**Decision:** The conversational agent platform (intent classification, comms line, deal spine, read-tool surface, proposal state, trust ladder) is a separate Vercel app, not an extension of `apps/middleware/`.

**Why:**
- Different change cadence. Middleware is sacrosanct (per CLAUDE.md), minimal changes only. Agent runtime is iterative (prompts tune, tools grow, autonomy levels adjust).
- Different state model. Middleware is stateless webhook processing. Agent is stateful: in-flight proposals, multi-turn conversation, standing rules.
- Different runtime profile. Agent calls are LLM-heavy (seconds to minutes for tool chains). Middleware handlers must return fast (Vercel's 30s ceiling already bit us in the Nick Puccio Pipedrive→Quo timeout).

**Alternatives considered:**
- Build the agent inside `apps/middleware/` — rejected for the reasons above.
- Build the agent inside `apps/command-center/` — rejected because command center is analytics/BI, different concern.

**How to apply:** Agent runtime, intent classification, comms line webhook, proposal state, trust-ladder config all go in `apps/agent/`. Middleware's `quo.ts` webhook routes agent-line traffic to apps/agent via HTTP or Redis stream. Both apps share `@aac/api-clients` and `@aac/shared-utils`.

---

## 2026-05-27 — Field-ops = new app `apps/field/`, fifth pillar

**Decision:** A new mobile web app for the technician (Mike) to use during/after each job. MVP: today's calendar, mark complete, upload before+after photos, set payment status. Triggers QB writes based on payment branch.

**Why:**
- Solves the cash/check payment-marking discipline problem at source (was acknowledged as unsolvable at code layer in `middleware-auto-invoicing.md`).
- Replaces unreliable text-thread photo capture with structured photo capture per job.
- Produces an explicit "job done" signal (currently inferred from calendar date passing).
- Feeds marketing photo pipeline with structured before/after pairs.

**Alternatives considered:**
- Add as routes to `apps/middleware/` — rejected (UI doesn't belong in middleware).
- Add as routes to `apps/command-center/` — rejected (different audience, different UX).

**How to apply:** New Vercel project. Mobile-first Next.js 15. Photos to Vercel Blob. Branded with AAC website styles. Start as single-tech (Mike); architect for multi-tech.

---

## 2026-05-27 — Cron B (invoice-send) killed; replaced by field app

**Decision:** Cron B is NOT shipped. The field app's "Not Yet Paid" payment branch triggers `qb.sendInvoice()` immediately at job completion, replacing the "wait 2 days then send if unpaid" pattern.

**Why:**
- Cron A spot-check showed Cron B would have done literally nothing in 8 days — Mike's payment-marking discipline was perfect. Building Cron B + retiring it next week = wasted motion.
- Cron B's worst failure mode (send "where's our money" email to someone who paid cash) is real (if low-prob). Field app captures payment at source, eliminates the failure mode.
- "Not Yet Paid → send now" is better signal than "wait 2 days then guess."

**Alternatives considered:**
- Ship Cron B as a 1-week bridge until field app is live — rejected because the test window showed Cron B would have been a no-op; no urgency.
- Keep both forever (belt-and-suspenders) — rejected because two systems doing similar things = ongoing complexity tax.

**How to apply:** Don't add invoice-send to `vercel.json`. The `invoice-send.ts` handler can stay deployed as a manual endpoint for emergency use, or be deleted when field app is steady-state.

---

## 2026-05-27 — Inbound phone triage = part-time human hire

**Decision:** Hire a part-time human (\~\$25/hr, 10–15 hr/wk ramping) to answer customer calls. Escalation-only to Matt for complex cases. Virtual receptionist services (Smith.ai, Ruby, AnswerForce) ruled out.

**Why:**
- AAC's brand value is "you speak to a human, you speak to an expert." Virtual receptionist sounds generic-call-center; erodes that value.
- Matt's interruption load is the single biggest unlock for all other work. Triage is the unlock.
- Human can be trained on AAC's actual flow; can grow into more responsibility over time.

**Alternatives considered:**
- Virtual receptionist (Smith.ai etc.) — rejected for brand reasons.
- Build an agent v1 to triage immediately — rejected because the walk-stage agent is 2–4 months away; can't bridge the gap.

**How to apply:** Matt sources via direct friend outreach + Facebook post. Comp model TBD (likely hourly, possibly with bonus structure). 10–15 hr/wk to start, ramp as patterns settle.

---

## 2026-05-27 — FHP back-end deferred; front-end only in current sprint

**Decision:** Foundation Health Plan ships the front-end (in-person pitch script + agreement document + add to job-close conversation) in current sprint. The back-end (recurring billing automation, winter clustering, photo report PDFs, retroactive enrollment outreach, year-2 cancellation tracking) is deferred until Cat 2 sprint has demonstrably freed Matt's time.

**Why:**
- Front-end captures this-season's job-close opportunities (high attach rate from "first year included" framing per FHP doc); deferring it = lost season.
- Back-end is real Cat 3 surface area (recurring billing, ops tracking, customer support for the new product).
- Adding all of FHP in current sprint = overflowing the Cat 2 sprint with Cat 3 work.

**Alternatives considered:**
- Ship full FHP now — rejected (too much Cat 3 surface for current capacity).
- Defer all of FHP — rejected (loses this-season's attach opportunities).

**How to apply:** Pitch + agreement live by end of June. Back-end systems begin design in Q3 after sprint deliverables are shipping.

---

## 2026-05-27 — Quote auto-drafting starts with a 3-day analysis spike

**Decision:** Before building the auto-drafting tool, run a 3-day analysis spike: pull \~50 estimates across all outcomes, throw at Gemini for pattern extraction, produce `quoting-patterns-spike.md` with a feasibility read. Commit to full pipeline only if the spike shows signal.

**Why:**
- Matt acknowledged current pricing has arbitrary elements; the data signal may be weaker than hoped.
- Photo-driven pricing is a big factor, and photos live partly in Mike-Matt text threads (hard to reconstruct which job they belong to).
- 3-day bounded spike is much smaller than committing to weeks of full pipeline work blind.

**Alternatives considered:**
- Build the full pipeline now — rejected (too much investment in unclear-signal territory).
- Skip the analysis entirely; build draft generator on heuristics — rejected (would be guessing without data).

**How to apply:** Spike output is an `analysis/02-strategy/quoting-patterns-spike.md` doc + honest assessment. Then go/no-go decision on the full pipeline + draft prototype.

---

## 2026-05-27 — Marketing rebuild (~\$4.7k/mo paid restart) deprioritized

**Decision:** The `marketing-strategy.md` plan to restart \$2.75k/mo Google Ads + \$1.2k/mo Meta + \$100/mo cold-email tooling + \$350/mo Authority Builders is deprioritized. Funnels A (dormant reactivation) and E (past customer re-engagement) carry the demand work for now.

**Why:**
- Demand is only off by \~1 week of book (per diagnostic). Funnel A's \~37 dormant-quote pool at \~\$97k probably gets most of the way there at zero CAC.
- Each new paid channel = ongoing Cat 3 maintenance (campaign tuning, learning budgets, attribution wiring). Don't take that on while still solving Cat 2.
- Revisit if end-of-July Edward signal is weak (would mean we need a second demand engine).

**Alternatives considered:**
- Run paid AND funnels — rejected (too much Cat 3 surface).
- Kill paid entirely (delete current Google Ads spend) — partial yes; \~\$600/mo Google Ads is sub-optimal anyway.

**How to apply:** Marketing-strategy.md archived (Phase 1 of doc reshuffle). Revisit if Edward bet weakens.

---

## 2026-05-27 — Edward signal check end-July; final decision end-November

**Decision:** Edward (outside salesperson hired Dec 2025) gets an instrumented signal check at end of July 2026 (60 days from the diagnostic) with a hard go/cut conversation at end of November 2026.

**Why:**
- Attribution infra has only been operational since mid-March 2026 — Edward has had \~60 days of measurable runway, not 6 months.
- Doing the keep/cut decision blind in November would be no better than today.
- 60-day check forces instrumentation discipline and provides early signal.

**Alternatives considered:**
- Cut now based on the thin signal — rejected (not enough measurable runway yet).
- Wait until November blind — rejected (no better data than today).

**How to apply:** Build the Salesperson KPI dashboard (net new partners, meetings logged, attributed leads, pipeline value, closed-won) before end of July. Conduct signal-check conversation then. If 3+ of 5 KPIs are at floor or below, trigger continue/cut discussion. Final decision end of November.

---

## 2026-05-27 — Deal-spine in `apps/agent/` is the prerequisite for field-app v2 + scheduling + quote auto-draft

**Decision:** Pipedrive deals as load-bearing infrastructure live in `apps/agent/`. Field app v1 uses Cron A's same single-customer-single-estimate heuristic. Field app v2 replaces heuristic with `getDeal(calendarEvent.dealId)` lookups. Calendar scheduling automation and quote auto-drafting also depend on the deal-spine existing.

**Why:**
- Multi-job-per-customer (builders, contractors) is the failure mode of heuristic-based invoice matching. Surfaces in field-app v2 if not solved.
- Deal-spine solves it once for all downstream consumers (field app, scheduling, quote drafting, attribution).

**Alternatives considered:**
- Skip deal-spine, push heuristics everywhere — rejected (would re-derive the same multi-job problem in every consumer).
- Build deal-spine in middleware — rejected (see "Agent runtime lives in new `apps/agent/`" decision above).

**How to apply:** `apps/agent/` crawl-stage includes PD deal CRUD methods, `[deal:N]` calendar marker support, deal-backfill script. Downstream apps (field v2, scheduling, quote draft) consume the deal API.

---

## Template for new entries

```
## YYYY-MM-DD — One-line decision

**Decision:** What was decided.

**Why:** The reasoning (constraint, deadline, stakeholder ask).

**Alternatives considered:**
- Option X — why rejected
- Option Y — why rejected

**How to apply:** Where this should shape future code / architecture / scope decisions.
```
