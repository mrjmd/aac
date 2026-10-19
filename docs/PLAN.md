# AAC Plan — Current State and Roadmap

**Last updated:** 2026-10-18 (full rewrite — the 2026-05-30 version predated the triage dashboard, the quoting go-live, and the scheduling queue closeout; see git history for the old text)
**Supersedes:** `_archive/2026-05-27/MASTER-PLAN.md` and `_archive/2026-05-27/middleware-phase-2.5-deal-spine.md`
**Entry point for:** anyone (Matt, future Claude sessions) trying to understand "what are we doing and why" without re-deriving from scratch.

---

## What this doc is

A short, current-state-only roadmap. It names the priority sequence, what's
actively deferred and why, and points at project specs where detail lives.
When this doc gets long, the answer is more project specs, not more sections here.

---

## Current state in one paragraph

AAC is a foundation repair business in Massachusetts (~26 months old). The
binding constraint is demand: calendar books 1–2 weeks out, needs 2–3. Close
rate ~60% (above industry). No debt. Edward (outside salesperson, hired Dec
2025) faces a final keep/cut decision at **end of November 2026** — attribution
instrumentation has been live since March. Matt is the sole technician-manager +
sole developer; Mike is the field tech. The operational frame remains
**maximally automate Matt's day-to-day so demand-gen work has room to
compound** — and as of October 2026 that automation has substantially landed:
morning triage dashboard, automatic stub/HOLD calendar events, quote-accepted
slot suggestions, and live event-triggered quote drafting. The next phase
shifts from building automation to (a) harvesting its feedback loops,
(b) making the Edward decision from data, and (c) re-opening demand-side work
(marketing automation) over the winter.

---

## The sequencing principle (the load-bearing rule)

**Category 2 (subtractive) work precedes Category 3 (additive) work.**
Reducing existing operational surface frees deep-work capacity; adding new
channels consumes it. See [DECISIONS.md](DECISIONS.md) entry #1.

As of October 2026 the Cat-2 program is largely shipped — which is precisely
the condition that unlocks the deferred Cat-3 items (marketing automation
first).

---

## The four pillars — where each actually stands

| # | Project | Status | Spec |
|---|---|---|---|
| 1 | **apps/field** | Shipped 2026-05-28; v2 photos/accountability live; field photos feed stub enrichment + quote drafting. Maintenance mode. | `projects/apps-field.md`, `projects/apps-field-v2-photos-and-accountability.md` |
| 2 | **`@aac/scheduling` pipeline** | **Queue closed out 2026-10-15.** Live in prod: intent classification on all Quo/QB trigger paths; STUB auto-creation on booked/confirmed slots (create-first/enrich-after, Matt-voice descriptions, multi-source photos); HOLD placeholders for offered slots (`SCHEDULING_HOLD_EVENTS=true`, offer-supersedes-hold semantics); quote-accepted slot suggestions with banded arrival + Quo note + graphite hold (`SCHEDULING_SUGGEST_NOTES=true`); Mike-OOO busy filter; triage D13/D14 backstops. **All four Walk-#7 dedup prereqs closed 2026-10-16.** Remaining: full `executeDirective` autonomy (now unblocked — an owner decision, not an engineering blocker) and route-aware day clustering in `suggestSlot` (longer-term). | `projects/scheduling.md` |
| 3 | **`@aac/quoting` pipeline** | **LIVE 2026-10-18 — event-triggered bot quote drafting in production.** Photo→quote training (6 phases) complete: Section V ruleset + exemplar retrieval, holdout 68% exact / 77% family (assessment population 80%; simple-injection stratum 86%/92%). Triggers: T1 photo-burst, T2 Mike-debrief transcript, T3 quote-promised (middleware enqueue → launchd runner, 10 min). Drafts are send-ready Pending QBO estimates; SyncToken ownership protects Matt's manual edits (one-way door); Quo conversation notes on create/update with line diffs. Flywheel live: owner edits/sends/deletes become training labels (`harvest-edits.ts` → triage "Bot quote drafts" section). **Now in observe/harvest mode.** Auto-send decision after weeks of gate-precision evidence. | `projects/photo-quote-training.md`, `projects/quote-drafter.md` |
| 4 | **apps/agent** | Paused at Walk 2. Matt's call (2026-10-18): conversational agent layer (#5) and customer/partner-facing intake (#6) come **much later**. Near-term precursor instead: **message-pattern analysis** — identify Matt's most-repeated outbound message types (first-touch intake asks, post-quote follow-ups) and scope narrow, low-risk Matt-voice automations with explicit triggers. Analysis: `analysis/02-strategy/message-automation-analysis-2026-10.md`. | `projects/apps-agent.md`, `projects/agent-vision.md` |

**Operational backbone (not a pillar, but load-bearing):** the **triage
dashboard** (`analysis/triage.html`, launchd 08:15) — detectors D1–D14 + L1/L2
across calendar, Quo, QBO, Gmail; solicitation check-off; bot-draft ownership
states. This is the de-facto morning briefing and the proto–command-center.
Spec: `projects/triage-dashboard.md`.

---

## Near-term sequence (October–December 2026)

1. **Quoting flywheel: observe, don't build.** Watch the trigger log + edit
   labels; fold owner corrections into the next Section V re-distill; make the
   auto-send call when the simple-injection gate shows sustained precision.
2. **Edward attribution readout — early November.** The keep/cut decision is
   end of November; build the forensic readout (channel-attributed revenue vs
   fully-loaded cost) so the decision is made from a document. The realtor
   outreach program (`analysis/02-strategy/realtor-outreach-plan-2026-09.md`)
   is an amplifier on this channel and hangs on the same decision.
3. **Message automation — ACTIVE (Matt's go 2026-10-18, straight to draft
   mode).** Analysis complete:
   `analysis/02-strategy/message-automation-analysis-2026-10.md` (full-corpus,
   11,006 threads). Tier-1 trio: post-quote follow-up (~40/mo, trigger =
   estimate emailed), first-touch intake ask (~17/mo, trigger = real-lead
   inbound + no manual reply in 15 min), CT→Luc routing (~3–5/mo). Key
   evidence: median first reply 36 min but p75 9.2h/p90 28.7h; ~35 real leads
   over 26 months never answered — first-touch latency + drops are the prize.
   **Build steps:** (1) draft-mode runner for post-quote follow-up + intake
   ask — generates Matt-voice drafts (few-shot from his own 572/198 real
   exemplars + quality gates) and posts them as Quo contact notes for
   copy/paste send (Quo has no draft API; the note IS the delivery). SKIPPING
   shadow per Matt — notes are human-gated by design. (2) CT routing +
   triage-dashboard drafts section. (3) Auto-send decision later, per-type,
   with the same evidence discipline as quoting. Never automated: pricing,
   complaints, tone-sensitive moments.
4. **Marketing automation 4.1 — the winter build.** Spike 4.0 validated the
   hybrid image pipeline (Puppeteer + Imagen). 4.1 prerequisites: BufferClient,
   GeminiClient integration, image storage. Social post automation is the #1
   marketing ROI item; building it over the winter means it's producing when
   spring demand season opens. This is the first Cat-3 item unlocked by the
   Cat-2 program landing.
5. **Security: P4-1 QB OAuth lock** — the remaining big item from the audit
   (see below). Close before more systems depend on QB writes.

---

## Audit status (2026-07 five-track audit)

`projects/audit-2026-07-remediation.md`. As of the 2026-10-16 sweep: Pipedrive
webhook auth live, the leaked Gemini key was auto-disabled by Google, PD API v1
has no announced removal date (migration still queued, not urgent). **Open:
P4-1 QB token-refresh race (OAuth lock)** — the big one; plus P4-5 QB
pagination, P4-6 429/timeout handling. The legacy QB webhook payload format
dies 2026-07-31 — already handled (`/api/qb-webhook` is CloudEvents-only).

---

## In-flight / shipped (stable systems)

- **Crons:** `job-reminders`, `job-followups` (3 review-prompt variants),
  invoice-create (Cron A), daily `qb-reconcile`, nightly Gemini canary. Stable.
- **Ed commission report** (`tools/src/commissions/`) — 20% of paid invoices,
  PD-closure attribution.
- **Stub enrichment** — Matt-voice descriptions + multi-source photos (field
  app + Quo MMS + email) live 2026-10-15.
- **Quote drafter v1→v2** — see pillar #3; manual runs replaced by triggers.
- **Pricing policy 2026-10** — canonical in
  `analysis/data/quoting-spike/llm-ruleset.md` Section 0 (anchor \$1,175,
  3+ cracks −\$75, slab LF equation).

---

## Actively deferred (and why)

| Item | Why deferred |
|---|---|
| **Full `executeDirective` autonomy (Walk #7)** | Prereqs closed 2026-10-16; stubs/holds/notes cover most of the value. Widen autonomy deliberately, one decision at a time, as calibration data accumulates. |
| **Quote auto-send** | Gate precision must be demonstrated on live triggers first (weeks, not days). |
| **Agent layers 5–6** (conversational agent, customer/partner intake) | Matt, 2026-10-18: "come much later." Message-pattern automation is the near-term slice. |
| **FHP back-end** (recurring billing, winter clustering) | Cat 3. Front-end pitch exists; back-end after marketing automation. |
| **Funnel B (neighborhood blitz) / C (cold email) / D (lead magnet)** | Cat 3, held. Marketing automation (social) outranks all three. |
| **Funnel F (partner portal)** | Only useful if Edward's bet is renewed in November. |
| **Paid marketing rebuild** | 2026 spend cut ~80%; revisit after the Edward decision + social automation. |
| **Virtual receptionist** | Brand value: humans answer. |
| **2nd technician hire** | Planned Mar 1 2027, gated on winter 1.5× multiplier + \$60–70k vaulted (see `analysis/02-strategy/tech2-hiring-plan-2026-08.md`). |
| **PD API v1→v2 migration** | No announced removal date; queued. |

---

## Architecture (current)

```
apps/
  middleware/        Pillar 1: Operations Brain (Next.js 14) [SACROSANCT — minimal changes]
  website/           Pillar 2: Public Website (Astro 5)
  marketing/         Pillar 3: Marketing Engine (Spike 4.0 validated; 4.1 is the winter build)
  command-center/    Pillar 4: Analytics/BI Dashboard (scheduling queues UI)
  field/             Pillar 5: Tech-facing job-completion app (shipped)
  agent/             Pillar 6: Conversational agent platform (paused at Walk 2)
packages/
  api-clients/       @aac/api-clients — Shared API clients (Quo, QB, PD, Google, Gemini, SearchBug)
  agent-tools/       @aac/agent-tools — LLM read-tool surface
  scheduling/        @aac/scheduling — directive pipeline, stubs/holds, suggestSlot
  quoting/           @aac/quoting — scope classification, duration, draft-quote, field-context
  shared-utils/      @aac/shared-utils — Phone, Redis keys, Logger, Types
  tsconfig/          @aac/tsconfig — Shared TypeScript configs
tools/               Operational scripts (triage, quote-trigger runner, commissions, drafter)
docs/                Architecture specs + project specs + this plan
analysis/            Strategic analysis + generated dashboards/data (gitignored)
```

Local automation (launchd): `com.aac.triage` 08:15 (dashboard refresh +
auto-open), `com.aac.quote-shadow` every 10 min (quote-trigger runner, LIVE).

---

## Surviving strategic docs (no changes needed)

- `analysis/00-charter.md` — objective function, kill criteria, decision date (May 2027)
- `analysis/02-strategy/salesperson-strategy.md` — Edward instrumentation + decision window
- `analysis/02-strategy/quoting-patterns-spike.md` — pricing forensics (GO verdict)
- `analysis/02-strategy/tech2-hiring-plan-2026-08.md` — 2nd tech gates
- `analysis/02-strategy/realtor-outreach-plan-2026-09.md` — Edward-channel amplifier
- `analysis/02-strategy/funnel-a-dormant-reactivation.md` — design complete, Phase 1 cleanup pending

---

## When to update this doc

- New decision shifts a priority → update the pillar table + add entry to `DECISIONS.md`
- Project ships or gets killed → move between sections
- Quarterly retro → check the "current state" paragraph is still accurate

When this doc grows past ~5 pages, refactor into project specs, not more sections.
