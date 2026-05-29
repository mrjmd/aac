# AAC Plan — Current State and Roadmap

**Last updated:** 2026-05-28
**Supersedes:** `_archive/2026-05-27/MASTER-PLAN.md` and `_archive/2026-05-27/middleware-phase-2.5-deal-spine.md`
**Entry point for:** anyone (Matt, future Claude sessions) trying to understand "what are we doing and why" without re-deriving from scratch.

---

## What this doc is

A short, current-state-only roadmap. It is intentionally LIGHTER than the old `MASTER-PLAN.md`, which tried to capture every detail in one place. This doc:

- Names the current four-priority sequence
- Names what's actively deferred and why
- Points at the project specs where detail lives
- Links to the durable strategic docs (charter, diagnostic, funnels) that remain valid

When this doc gets long, the answer is more project specs, not more sections here.

---

## Current state in one paragraph

AAC is a foundation repair business in Massachusetts (~21 months old). Spring 2026 revenue is 1.7–2.4× spring 2025 — the trajectory plausibly clears the May-2027 floor (\$50k/mo avg Mar–May 2027). The binding constraint is demand: calendar books 1–2 weeks out, needs 2–3. Close rate is ~60% (above industry). No debt; cash buffer \~\$40–125k. Edward (outside salesperson, hired Dec 2025) is the open bet — attribution instrumentation has been live since mid-March 2026, with a signal check at end of July 2026 and a final keep/cut decision at end of November 2026. Matt is the sole technician + sole developer; the operational frame for the next 6 months is **maximally automate Matt's day-to-day so that demand-gen work has room to compound.**

---

## The sequencing principle (the load-bearing rule)

**Category 2 (subtractive) work precedes Category 3 (additive) work.** Reducing existing operational surface frees deep-work capacity; adding new channels consumes it (even when they succeed). Don't take on new ops surface until you've reduced existing ops surface.

This is why automation of Matt-and-Mike's existing daily flow comes before opening new demand channels. See [DECISIONS.md](DECISIONS.md) entry #1 for the full reasoning.

---

## The four active priorities (in dependency order)

| # | Project | Goal | Status | Spec |
|---|---|---|---|---|
| 1 | **apps/field** | Tech-facing mobile web app for job completion (photos + payment status + auto-invoice) | Shipped to production 2026-05-28 | `projects/apps-field.md` |
| 2 | **apps/agent** | Agent platform (comms line, deal spine, read-tool surface, intent classification) | **Crawl complete (1–8) + Walk step 1 LIVE in prod 2026-05-28.** Shared: PD Deal CRUD + Quo conversation methods + `verifyOpenPhoneWebhookSignature` in `@aac/shared-utils`. Middleware: `[deal:N]` marker support, inbound-lead deal stamp, nightly QB→PD deal-reconcile cron, migrated to shared signature verifier. Tools: one-shot backfill script (`--apply` gated on Funnel A Phase 1 cleanup). Apps/agent: pillar scaffold with env/roles/clients/redis libs, `/api/health`, error-surface cron texting Matt middleware errors every 10 min, and agent comms inbound webhook (HMAC verify → dedup → role lookup → stub intent router → ack reply + audit log) — Matt's smoke test passed: text in, ack out. Walk phase next: read-tool surface (Walk 2) + intent classification (Walk 3, LLM choice still open) + Funnel A Phase 2 stale-deal nudges. | `projects/apps-agent.md` |
| 3 | **Calendar scheduling automation** | Stub event creation on estimate approval; full slot-suggestion later | Depends on #2 | `projects/calendar-scheduling.md` |
| 4 | **Estimate auto-drafting** | LLM drafts QB estimates from PD/Quo/calendar context; 3-day analysis spike first | Depends on #2 (tool surface) | `projects/estimate-auto-draft.md` |

**Opportunistic sidecar:** `projects/middleware-cleanup.md` — cleanup items surfaced during the apps/agent stack analysis. Do during apps/agent Crawl when middleware is already unfrozen for deal-aware webhook handlers; don't break SACROSANCT for janitorial work alone.

**Build order:** #1 in parallel with #2 (independent). #3 and #4 follow #2. Field-app v1 ships with Cron A heuristics; v2 uses the deal spine from #2.

App names (`apps/field`, `apps/agent`) are working names; subject to confirmation before pillar CLAUDE.md files are written.

---

## In-flight / shipped

- **Cron A (invoice-create)** — live since 2026-05-19. Auto-creates QB invoices from accepted estimates for jobs scheduled today. Working as designed (4 invoices in 8 days, all matched correct estimates).
- **Existing crons:** `job-reminders`, `job-followups`. Both stable.
- **Funnel A (dormant quote reactivation)** — Phase 1 cleanup pending; **now also gating apps/agent Crawl step 6** (deal backfill). Cleanup categorizes 77 Pending estimates (37 are 90+d) into keep / dead / forgot-to-mark-won / multi-quote orphan; only the keep set backfills as live deals. Phase 2 LLM agent build is the load-bearing stale-nudge automation downstream of `apps/agent`, designed in `analysis/02-strategy/funnel-a-dormant-reactivation.md`.
- **Foundation Health Plan front-end** — pitch script + agreement doc to ship alongside current jobs. Back-end deferred.
- **Part-time human inbound triage hire** — \~\$25/hr, 10–15 hr/wk ramp. Matt sources via friends + Facebook post.

---

## Actively deferred (and why)

| Item | Why deferred |
|---|---|
| **Cron B (invoice-send)** | Killed. Field app's "Not Yet Paid" branch replaces it at source. |
| **FHP back-end** (recurring billing, winter clustering, photo reports) | Cat 3 — adds ops surface. Front-end pitch in current sprint; back-end after Cat 2 sprint demonstrates freed time. |
| **Paid marketing rebuild** (~\$4.7k/mo Google Ads + Meta) | Funnels A + E (mostly Cat 2-leaning) carry the demand work. Revisit if Edward signal at end of July is weak. |
| **Funnel B (neighborhood blitz)** | Cat 3. Held until Cat 2 sprint deliverables are shipping. |
| **Funnel C (cold email via ZoomInfo)** | Cat 3. Highest setup cost; defer until inbound triage is solved. |
| **Funnel D (website lead magnet)** | Cat 3. Lower priority. |
| **Funnel F (partner portal)** | Cat 3. Amplifier on Edward's existing work — only useful if Edward's bet is renewed in November. |
| **Virtual receptionist** | Brand value: humans answer. Part-time human hire instead. |
| **2nd technician hire** | Downstream of demand consistently filling 2–3 weeks out. |

---

## Architecture (current + planned)

```
apps/
  middleware/        Pillar 1: Operations Brain (Next.js 14) [SACROSANCT — minimal changes]
  website/           Pillar 2: Public Website (Astro 5)
  marketing/         Pillar 3: Marketing Engine (Content Production)
  command-center/    Pillar 4: Analytics/BI Dashboard (Next.js 15)
  field/             Pillar 5: Tech-facing job-completion app (NEW — apps/field)
  agent/             Pillar 6: Conversational agent platform + deal spine (NEW — apps/agent)
packages/
  api-clients/       @aac/api-clients — Shared API clients
  shared-utils/      @aac/shared-utils — Phone, Redis, Logger, Types
  tsconfig/          @aac/tsconfig — Shared TypeScript configs
tools/               Operational scripts (thin wrappers)
docs/                This directory — architecture specs and current plan
analysis/            Strategic analysis (gitignored — see analysis/00-charter.md)
```

Two new pillars (`apps/field`, `apps/agent`) reflect the 2026-05-27 architecture decisions.

---

## Surviving strategic docs (no changes needed)

These remain valid; don't re-derive:

- `analysis/00-charter.md` — objective function, kill criteria, decision date
- `analysis/01-diagnostic/financials.md` — May 2026 financial baseline
- `analysis/02-strategy/funnel-a-dormant-reactivation.md` — Phase 1 design complete
- `analysis/02-strategy/funnel-b-neighborhood-blitz.md` — LettrLabs decided, deferred
- `analysis/02-strategy/direct-mail-service-research.md` — service comparison memo
- `analysis/02-strategy/salesperson-strategy.md` — Edward instrumentation + decision window
- `analysis/02-strategy/foundation-health-plan.md` — full design (with header note: front-end only in current sprint)
- `analysis/02-strategy/new-funnels.md` — portfolio index

---

## Updated strategic docs (Phase 3 of doc rewrite, pending)

- `analysis/02-strategy/levers.md` — to be updated with Cat 2 vs Cat 3 framing and the new sequence
- `analysis/02-strategy/foundation-health-plan.md` — header note: front-end only in current sprint
- `docs/middleware.md` — prune Future State (items moving to `apps/agent` and `apps/field`)
- `CLAUDE.md` — add `apps/field/` and `apps/agent/` to architecture diagram; point to this doc

---

## Archived (history, not active reference)

- `docs/_archive/2026-05-27/MASTER-PLAN.md` — superseded by this doc
- `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` — decomposed into `apps/agent` + project specs
- `docs/_archive/2026-05-27/middleware-auto-invoicing.md` — Cron A documented in code; Cron B killed
- `analysis/_archive/2026-05-27/marketing-strategy.md` — deprioritized in favor of funnel portfolio

---

## When to update this doc

- New decision shifts a priority → update the priority table + add entry to `DECISIONS.md`
- Project ships or gets killed → move from "active" to "in-flight" or "deferred"
- New pillar added → update Architecture section
- Quarterly retro → check that the "current state" paragraph is still accurate

When this doc grows past \~5 pages, refactor into project specs, not more sections.
