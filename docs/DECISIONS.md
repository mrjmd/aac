# Decisions Log

Running log of architectural and strategic decisions. Each entry: date, decision, why (context), and what alternatives were considered.

When a decision gets reversed, ADD a new entry with the reversal — don't delete the original. The history of changed minds is the value.

---

## 2026-05-29 — Scheduling + quoting are packages; intent extraction stays in middleware; apps/agent paused at Walk 2

**Decision:** The 2026-05-27 "apps/agent owns intent classification, scheduling pipeline, and the read-tool surface" framing was wrong. Corrected division of labor:

- **`packages/agent-tools/`** (new) — the seven LLM read tools, migrated from `apps/agent/lib/tools/`. Pure deps-injected functions, importable from any LLM-calling code.
- **`packages/scheduling/`** (new, scaffolded; impl TBD) — SchedulingDirective normalization + slot suggestion + event creation + PD deal updates + callback child-deal logic. Pure algorithm.
- **`packages/quoting/`** (new, scaffolded; impl TBD) — photo analysis + quote drafting + QB Estimate creation. Pure algorithm. Hands off to `@aac/scheduling` on acceptance.
- **`apps/middleware/`** — extends its existing Gemini-based entity-extraction call with scheduling-intent labels. On detection, dispatches a `SchedulingDirective` to `@aac/scheduling`. Also gains a new QB Estimate webhook handler (replacing the originally-planned poll) and a daily QB reconciliation backstop cron.
- **`apps/agent/`** — paused at Walk 2. Scope shrinks to Matt-facing dialogue: the agent comms line listener (already shipped) + a future propose-dialogue endpoint that middleware POSTs to. Resumes when the agent-vision Layer 1/3/4 work begins (voice fidelity, strategic mode, self-reflection).

**Why:**
- **One listener per channel.** Middleware already runs the Quo webhook for the business line with a Gemini classifier wired in; adding a second webhook listener in apps/agent doubled tokens for no architectural benefit. Adding scheduling-intent labels to the existing classifier is the smaller, cleaner change.
- **Multiple entry points.** Scheduling and quoting will get invoked from middleware (today's webhook handlers), apps/website (future instant-quote upload form), and apps/partner-app (future realtor/inspector entry). Trapping them inside one app forces every future consumer to call that app instead of importing the algorithm directly.
- **Apps/agent's actual purpose is Matt-facing dialogue.** Conflating "the place where LLM tools live" with "the place where customer comms listening happens" mixed a packaging concern with a runtime concern. The packaging concern is now a shared package.
- **QB webhook over poll.** Cron-polling QB for estimate-acceptance is high-latency (8–18hr) for the most time-sensitive scheduling trigger. QB's Estimate.Update webhook fires in seconds. Daily reconciliation cron remains as backstop for the rare dropped webhook.

**Alternatives considered:**
- **Keep scheduling/quoting in apps/middleware modules** (not packages) — rejected because the work is reusable across future entry points (website, partner-app). Middleware would become the chokepoint.
- **Keep building Walk 3+ inside apps/agent** with a second webhook target on the business line — rejected (duplicate listener; wrong architectural shape).
- **Move the existing Gemini entity-extraction call out of middleware to apps/agent** — rejected; that's a separate migration without independent justification. Per existing project memory the boundary is already clean at the client layer; leave it.
- **Build a dedicated `apps/scheduling` app for the algorithm** — rejected; algorithm-as-app would have no UI and would just be an HTTP wrapper around the package. The package itself is sufficient until external (non-monorepo) consumers exist.

**Apps/middleware SACROSANCT note:** Rule 4 of root CLAUDE.md says "minimal changes only, every change unit tested." Extending the existing Gemini classifier label set and adding scheduling-pipeline dispatch is the *same kind* of work middleware already does (webhook handling → classification → dispatch). Each addition ships with tests. Not a new architectural concept; an extension of an existing one.

**How to apply:**
- New LLM tools go in `packages/agent-tools/`, not apps/agent.
- New scheduling-algorithm code goes in `packages/scheduling/`, not apps/middleware.
- New quote-drafting code goes in `packages/quoting/`, not apps/middleware.
- Middleware owns transport (webhook reception, signature verification, classifier dispatch) but *not* the algorithms it dispatches to.
- Apps/agent stays paused. Do not extend Walk 3+ in apps/agent. When the user prompts work on intent classification, scheduling pipeline, stale-deal nudges, or the diagnostic agent, route to middleware + the relevant package.
- Apps/agent resumes when Layer 1 (voice), Layer 3 (strategic mode), or Layer 4 (self-reflection) work begins — see `docs/projects/agent-vision.md`.

**Related memories / docs:**
- `docs/projects/agent-vision.md` — long-term apps/agent destination (governs when it resumes)
- `docs/projects/apps-agent.md` — pre-realignment Walk plan; the status table at the top of that doc is authoritative for current scope
- `packages/agent-tools/CLAUDE.md`, `packages/scheduling/CLAUDE.md`, `packages/quoting/CLAUDE.md` — per-package rules

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

## 2026-05-28 — Apps/agent deal-spine refinements: Qualified Lead stage + writes split by trigger

**Decision:** Two refinements to `docs/projects/apps-agent.md`:

1. **Insert a "Qualified Lead" stage** between Lead and Assessment Scheduled. Lost stage carries a `lost_reason` field (`out_of_scope`, `competitor`, `price`, `no_response`, `cancelled`, `passed_after_assessment`, `other`). Final list = 10 stages (originally drafted as 11; "Job Done" and "Invoiced" collapsed into "Job Done" later same day — Cron A and the field app auto-invoice immediately on completion, so the dwell time is minutes, not a distinct state; edge cases like warranty work tracked via a deal metadata field). Locked in the spec's "Deal model" section.
2. **Split deal writes by trigger nature.** Deterministic webhook-driven and cron-scheduled writes live in `apps/middleware/` (where the triggers already land). LLM / judgment / dialogue-driven writes live in `apps/agent/`. CRUD methods themselves live in `@aac/api-clients`, called by both.

Also confirmed in the same conversation:
- Comms line locked at `(617) 766-0151` (no new number provisioned)
- No web UI in apps/agent — observation/config surfaces fold into command-center

**Why:**

- **Qualified Lead:** There are two qualitatively different "this didn't go anywhere" outcomes — fit miss ("we don't do that") and sales loss (to competitor / price / inaction). Conflating them under one Lost stage makes both metrics noisy. Fit-miss rates inform positioning / SEO / inbound mix; sales-loss rates inform close motion. Qualified Lead is also where the agent's stalled-deal-nudge behavior earns its keep — these are real prospects working toward an assessment slot.

- **Writes split:** The original spec implied "all deal logic in apps/agent." That's imprecise — middleware already owns webhook ingestion and existing crons, and the deterministic deal transitions (estimate created → Quote Sent, invoice paid → Paid) fit those existing patterns exactly. Routing those writes through apps/agent would mean middleware's existing webhook handler makes an HTTP RPC to apps/agent for what's a function call's worth of work. Keeping deterministic writes in middleware honors its sacrosanct principle (small, deterministic, no LLM) while still putting the judgment-driven LLM work in apps/agent.

**Alternatives considered:**

- **Single "Lost" stage with reason field only** (no Qualified Lead) — rejected because stage separation matters for dwell-time analytics, nudge-behavior targeting, and dashboard treatment. Reason granularity alone doesn't carry that.
- **Qualified Lead between Assessment Done and Quote Sent** (Matt's alternate placement) — rejected because that's a different concern (opportunity qualification, not fit qualification). The "we assessed and decided not to quote" case is rare and fits cleanly as `lost_reason: passed_after_assessment`.
- **All deal writes in apps/agent** (per original spec wording) — rejected because deterministic webhook transitions don't need LLM judgment; routing them through apps/agent adds latency + a cross-app dependency for work middleware is already shaped to do.
- **All deal writes in middleware** — rejected for the LLM / dialogue / state-coupling reasons captured in the 2026-05-27 "Agent runtime lives in `apps/agent/`" decision.

**How to apply:**

- New deal write: classify by trigger. Webhook from PD/QB/Quo or scheduled cron? → middleware. LLM-classified intent, Matt's confirmation of an action proposal, diagnostic-agent remediation? → apps/agent.
- Deal CRUD methods (`createDeal`, `updateDeal`, etc.) belong in `@aac/api-clients` regardless of caller.
- Use the 11-stage list in `docs/projects/apps-agent.md` → "Deal model." Don't add stages without a metric-signal justification.
- Lost deals always carry a `lost_reason`. If a new failure mode appears that doesn't fit existing values, add the value to the list before using it.

---

## 2026-05-28 — Apps/agent stack: raw Vercel functions (not Next.js, not Hono)

**Decision:** `apps/agent/` uses raw Vercel functions (`@vercel/node`), matching `apps/middleware/`. No Next.js, no Hono, no router framework.

**Why:** A deep read of `apps/middleware/` on 2026-05-28 corrected a wrong premise that had been driving this thread — middleware is NOT on Next.js. It has 4 dependencies (`@aac/api-clients`, `@aac/shared-utils`, `@upstash/redis`, `@vercel/node`) and uses `(req: VercelRequest, res: VercelResponse)` handlers throughout. The monorepo's actual pattern is **UI apps on Next.js (field, command-center, marketing), API-only apps on raw Vercel functions (middleware, agent)**. Building apps/agent on raw Vercel functions IS the consistent choice.

Hono was considered briefly but its value (routing, middleware chains, validation helpers) doesn't pay off at apps/agent's actual HTTP surface size (3–5 routes — the LLM read-tool surface is in-process TypeScript functions invoked by the Anthropic SDK, not HTTP endpoints).

**Alternatives considered:**

- **Next.js 15** (matches `apps/field` and `apps/command-center`) — rejected. Those are UI apps; apps/agent has no UI. Picking Next.js would mean carrying forward a sub-optimal default rather than matching the actual API-app pattern.
- **Hono on Vercel** — rejected. Useful for projects with many endpoints sharing middleware chains; apps/agent has neither.
- **Migrate middleware to Next.js for symmetry** — rejected because middleware is already on the lighter pattern; the symmetry already exists.

**How to apply:**

- `apps/agent/` package.json deps mirror middleware's: `@aac/api-clients`, `@aac/shared-utils`, `@upstash/redis`, `@vercel/node`.
- Template handler shape: `apps/middleware/api/webhooks/google-ads.ts` (266 LOC, cleanest in the codebase). Full lifecycle: validate → dedupe → process → fail-safe-200.
- Web Standard `Request/Response` shape is acceptable for handlers that need raw bytes (HMAC signature verification) — see `apps/middleware/api/webhooks/quo.ts` for the pattern.
- Vercel crons configured via `vercel.json` at app root.

---

## 2026-05-28 — Apps/agent is multi-user, role-scoped, internal-only

**Decision:** Apps/agent's purpose expanded from "Matt's ops assistant" to "company-wide context engine with role-scoped access." Three load-bearing principles locked:

1. **Multi-user with role-scoped tool surface.** Identity by phone number; phone → role mapping in env (`AGENT_USER_ROLES` JSON) at first, migrate to a Redis `users` hash at 10+ users. Roles: `owner`, `technician`, `salesperson`, `triage`. Only `owner` (Matt) has a concrete tool scope at Crawl + Walk start; the others are placeholders fleshed out when the people actually start using the agent.

2. **Tool-surface scoping at the data-fetching layer, not the response layer.** Every read tool takes a caller identity and filters internally. The tool *registry* is per-role: the LLM session for a given caller is only registered with tools that caller is allowed to use. The model never sees tool definitions for actions/data outside its role.

3. **Internal-only.** Apps/agent is never exposed to customers as a conversational interface. Customer-facing automation (intent classification, scripted/templated responses to inbound signals) can use the agent's intelligence but must always feel like an automated message from a human — never like a chatbot. Customers are not "users" in the role model; they have no identity in the permission system.

**Why:**

- **Role-scoping at the tool layer (not response layer):** LLM responses are non-deterministic. Even with a system prompt saying "don't mention X," if the tool returned X, the model can reference it in a summary, citation, or follow-up. The only safe pattern is: don't return out-of-scope data in the first place. Tool registry per-role removes the temptation entirely — the model can't reference what it doesn't know exists.
- **Multi-user matters from day one** because retrofitting a permission model onto a single-user system is painful — tool signatures change, audit logging gets added everywhere, role lookups thread through every handler. Easier to design the request-handler shape as `(callerIdentity, ...) => ...` from the start, even if the only role with concrete scope at start is `owner`.
- **Internal-only as a brand decision:** AAC's positioning is "humans, experts, real people." Exposing a conversational AI to customers erodes that. The intelligence can still flow to customer-facing communication, but the *interface* stays human-authored or template-shaped.

**Alternatives considered:**

- **Single-user, Matt-only** (the original spec) — rejected because Mike, Edward, and the future triage hire are real users with real needs, and Matt explicitly wants the agent to serve them too. Retrofitting later is painful.
- **Design full tool scopes for technician/salesperson/triage roles now** — rejected as YAGNI. Concrete scopes for those roles are aspirational until the people actually use the agent.
- **Customer-facing conversational AI surface in Run** — rejected. Brand value of "you talk to a human." The agent's intelligence can drive customer-facing automation, but never as a conversation interface.
- **Database-backed user table from day one** — rejected as YAGNI at current scale; env JSON migrates cleanly when needed.

**How to apply:**

- All read tools have the signature `tool(callerIdentity, ...args)`. Scoping at the tool layer; never trust the LLM to filter responses.
- LLM session construction is per-caller: build the tool definitions array from the caller's role before invoking the model.
- Standing rules per-user keyed by phone (`agent:rules:{phoneE164}`).
- Audit log = Redis stream, every Q&A captured (caller identity + question + tool calls + response).
- Customer-facing automation must remain tonally indistinguishable from human-authored automated messages. No "I'm an AI" framing, no freeform conversational tone.

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
