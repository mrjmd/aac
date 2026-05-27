# Project Spec — Estimate Auto-Drafting (Analysis Spike First, Then Build)

**Status:** Spec — 3-day spike before any build commitment
**Owner:** Matt
**Created:** 2026-05-27
**Build dependency:** Spike is read-only and parallelizable with everything else. Full build depends on apps/agent tool surface.

---

## The two-stage approach

**Stage 1 — Analysis spike (3 days):** Pull \~50 estimates across all
outcomes, throw at Gemini for pattern extraction, produce
`analysis/02-strategy/quoting-patterns-spike.md` with feasibility read.
Go/no-go decision for Stage 2.

**Stage 2 — Build (1-3 weeks):** Data assembly pipeline + analysis + draft
generator wired into agent tool surface. Only if Stage 1 shows
strong-enough signal.

---

## Stage 1 — Spike scope

### Data assembly (sample)
For each of \~50 estimates (mix of Accepted / Converted / Rejected / Pending):
- QB metadata + line items + total
- PD person + linked activities / notes
- Quo conversation thread leading up to estimate
- Calendar events for any assessment visit
- Outcome (converted to invoice? invoice value matches estimate?)

Photos are the elephant — see "Honest difficulties" below.

### Analytical questions to answer
- **Pricing distributions per service code** — median, IQR, outliers. How tight or wide?
- **Approval rate cuts** — by price bucket within service, by job size, by source, by season, by geography
- **Approved vs rejected scope shapes** — line-item combos, total-size patterns
- **Quote-to-invoice 26% gap** — for Converted estimates, which line items disappeared between quote and invoice?
- **Conversation tells** — pre-quote signals (budget language, urgency, prior repair history)
- **Mike-vs-Matt as quoter** — if Mike writes estimates, are patterns different?

### LLM pattern surfacing
- Feed Gemini batches of (context, estimate, outcome) tuples
- Prompt: "what implicit rules can you detect in how prices are set?"
- Validate by holding out 5-10 estimates and asking the rules to generate them; compare to actual

### Output
`analysis/02-strategy/quoting-patterns-spike.md` with:
- First-read patterns (statistical + LLM-surfaced)
- Honest signal assessment: is the data strong enough to build a draft generator on?
- Recommended scope cut if signal is partial (e.g., "limit to crack injection only," "limit to text-context-rich estimates")
- Go/no-go for Stage 2 with rationale

## Honest difficulties to surface in the spike

- **Photos may be the missing 80%** of pricing signal. They live in Mike-Matt text threads and on calendar events. Reconstructing which photos belong to which job is complex and error-prone (Mike sometimes batches photos from 2-3 different jobs in one text). Spike should be explicit about whether photo-driven pricing is reconstructable.
- **"Arbitrary" pricing risk.** Matt acknowledged current pricing has gut-level adjustments. The model will learn whatever was in the data — including the arbitrariness.
- **Approved ≠ optimal.** Some approved estimates were probably too low (left money on table); some rejected ones were correctly priced but customer wasn't ready. Naive "approved-vs-rejected" frame conflates both.
- **Selection bias.** Customers who go all the way to a written estimate are already partially qualified. Patterns reflect the conversion funnel, not the population.

## Stage 1 scope decisions for Matt

1. **Photos:** include in scope, or text-context-only spike?
2. **Date window:** all-time (2024-09 onwards) or 2025-2026 only?
3. **Codify vs rationalize:** is the goal a draft generator that prices like Matt today, or analysis that suggests where Matt SHOULD change pricing? (Both fine; different output shape.)
4. **Mike's quotes:** include in analysis (separate from Matt's) or focus on Matt-authored only?

## Stage 2 — Build (only if spike says go)

| Phase | Scope | Time |
|---|---|---|
| 1 | Full data assembly pipeline (every estimate, not just sample) | 3-5 days |
| 2 | Rule articulation + held-out validation | 2-3 days |
| 3 | Draft generator prototype + agent tool integration (`draftEstimate(context)`) | 1-2 weeks |
| 4 | Approval queue in agent comms line (Matt reviews each draft) | 0.5 week |
| 5 | Trust-ladder promotion as Matt's edits decrease | ongoing |

## Related

- Spike output target: `analysis/02-strategy/quoting-patterns-spike.md`
- Architecture decisions: `docs/DECISIONS.md` (2026-05-27 spike-first decision)
- Plan position: priority #4; spike parallelizable with apps/agent build
- Depends on (eventually): apps/agent tool surface for the `draftEstimate` tool
- Current plan: `docs/PLAN.md`
