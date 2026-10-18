# Photo→Quote Training Layer — Deep Plan

**Status:** Phases 1–5 BUILT & EVALUATED 2026-10-16 (same day as plan).
**Holdout result: grounded pipeline 70% exact item-set / 77% family-level
vs ungrounded 49% / 67% (79 never-seen cases; fixed 17, broke 1).**
Self-reported confidence barely discriminates (71% vs 56%) — Phase 6's
composite trigger signal is required, as designed.
Corpus harvested (395/542 estimates, 1,854 photos), structured (blind
baseline 43% exact / 65% family-level), Section V drafted, 685-area
exemplar retrieval library embedded. **Awaiting owner review** (Section V
draft + 41-case packet at `analysis/photo-review-2026-10.html`) before
Phase 4 drafter integration. Findings:
`analysis/02-strategy/photo-corpus-phase2-findings.md`.
**Prerequisite:** Quote Drafter v1 (live, see `quote-drafter.md`).
**Code:** `tools/src/photo-corpus/{harvest,structure,embed,distill}.ts`,
retrieval + attribution in `@aac/quoting`, `GeminiClient.embedContent`.

## The lever

The drafter's photo analysis today is contextless — a fresh model look at
each new photo with no knowledge of how AAC reads photos. The visible
failure: Erin Tortorella's photos showed three completely separate areas
(three separate scopes) and the model merged them into two.

The fix is to ground photo analysis in AAC's own history: ~2 years of
customer photos (Quo MMS + email attachments) joined to how each of those
jobs was actually quoted — what the owner looks for, how he analyzes, how
he talks about cracks and resurfacing, how photo→quote works when done
manually.

**The prize is the trigger.** Once photo+text analysis is reliable enough
to carry a calibrated confidence score, high confidence becomes the
automatic trigger: the moment enough information exists in a thread to
generate an accurate quote, the bot creates the Pending draft on its own
(still bot-marked, still reviewed, never auto-sent). That converts the
drafter from a manually-run tool into standing infrastructure, and
speed-to-quote becomes near-instant for routine jobs.

## What already exists (validated 2026-10-16)

| Asset | State |
|---|---|
| Estimate corpus | 542 estimates, 2024-09 → 2026-10, full line detail + customer phone (`analysis/data/quoting-spike/estimates-full.jsonl`) |
| Photo attribution | Spike probe: 42/60 (70%) of estimates have inbound MMS within ±4 days |
| **Old-media retention** | **PROBED LIVE: 2024-09 MMS photos still download (HTTP 200, full-size JPEG)** from OpenPhone's `storage.googleapis.com/opstatics/` bucket — the historical corpus is intact. Only blocker is our client's host allowlist (needs a deliberate `opstatics` exception) |
| Quo plumbing | `QuoClient.listMessages` + `downloadMessageMedia` |
| Gmail plumbing | `GmailClient.listMessages` + `downloadAttachment` (gmail.readonly live); `email-photos.ts` already does sender+attachment sweeps |
| Pricing authority | `llm-ruleset.md` Section 0 (text side already codified) |
| Free labels | Quo threads contain the owner's own photo reactions ("that's a typical shrinkage crack…") — ground-truth analysis language, already attached to the photos it describes |

## Core design decision: how the model "learns"

Three candidate approaches:

1. **Fine-tune a vision model.** Rejected for v1: ~350–400 usable examples
   is small for vision tuning; the artifact is opaque, rots as pricing
   changes, and welds us to one model generation (Gemini churn is a known
   hazard). Revisit only if the hybrid below plateaus.
2. **Distilled visual ruleset ("Section V").** Derive from the corpus what
   the owner actually looks for, per category: crack-type indicators,
   water-evidence signs, bulkhead-injection indicators (seam sides / bolts
   / stair bottom — already rule 12), slab vs wall, resurfacing surface
   condition, **area segmentation** (when photos show distinct areas =
   distinct scopes). Auditable, cheap at runtime, same playbook that made
   Section 0 work.
3. **Retrieval-grounded exemplars.** At draft time, retrieve the 3–5 most
   similar historical cases (structured photo read + what was actually
   quoted + the owner's own words from that thread) and inject them into
   the prompt as worked examples.

**Recommendation: 2 + 3 hybrid, no fine-tune.** This matches the standing
"variance over hard rules" principle — surface similar cases for the model
to reason over rather than flattening to lookup tables — and both
artifacts (ruleset + exemplar library) survive model swaps unchanged.

A critical subtlety: **exemplars teach scope-reading, not prices.** The
2024–2025 corpus carries the old drifted anchors (the \$1,025 era). Every
exemplar carries its date, and the prompt states that Section 0 overrides
exemplar pricing unconditionally. The exemplars answer "what is this a
photo of, and what work does it imply" — Section 0 answers "what does that
cost."

## Target architecture

A **photo-analysis pre-pass** in `packages/quoting`, upstream of the
existing draft prompt:

```
photos + thread text
  │
  ├─ Stage A  per-photo structured read
  │           (surface, location, symptoms, water evidence, scale cues)
  ├─ Stage B  AREA SEGMENTATION — group photos into K distinct areas
  │           (the direct fix for the Erin merge failure)
  ├─ Stage C  area ↔ ask mapping (joins photo areas to text asks;
  │           feeds the existing mandatory scope_accounting)
  │           + per-area retrieval of similar historical exemplars
  ▼
existing draft prompt (Section 0 + Section V + exemplars + areas)
  → lines + scope_accounting → validator → Pending QBO estimate
```

Scope accounting upgrades from "every text ask accounted" to "every text
ask AND every photo area accounted" — a photo area with no quoted line and
no exclusion is a validator warning.

## Phases and level of effort

Sessions = working sessions of the current kind. Owner time called out
separately — it's the scarce resource.

### Phase 1 — Corpus assembly (2–3 sessions)

Sweep all 542 estimates: pull each customer's Quo thread (window around
the estimate date), download inbound MMS, sweep Gmail by customer email
(resolved from QBO/PD) for emailed photos — the known MMS-bounce fallback
path, which should push attribution above the MMS-only 70%.

- Output: `analysis/data/photo-corpus/` — photos on disk keyed by
  estimate, plus `manifest.jsonl` ({estimateId, photos, thread excerpt,
  lines, status/outcome}).
- Code: promote the spike's scratch join code; add the `opstatics`
  allowlist exception to `downloadMessageMedia` (or a corpus-only
  variant); reuse the `email-photos.ts` query pattern with a 2-year
  window.
- Expected yield: ~350–400 photo-attributed estimates, few thousand
  photos.
- Risk handled here: repeat customers → disambiguate photo→estimate joins
  by date window; ambiguous cases flagged, not guessed.

### Phase 2 — Structuring + labeling (2–3 sessions + ~2–4 hrs owner)

For each attributed case, an LLM pass produces: structured per-photo
reads, area segmentation, and a join hypothesis ("this line exists because
of these photos"). The owner's in-thread photo reactions are extracted as
ground-truth analysis language.

Then the key quality gate: **does the structured read predict the lines
actually quoted?** Cases where it doesn't are the "tricky pile" (owner
expects some — "some of the photos are tricky"). The tricky pile (est.
10–20%) goes to the owner as a batch review doc; his corrections are the
highest-value labels in the whole corpus.

- Output: `exemplars.jsonl` — {date, areaDescription, photoRefs, symptoms,
  quotedItems, prices, ownerWords, outcome}.

### Phase 3 — Distill Section V + build retrieval (2 sessions)

- Derive the visual-indicators ruleset from the labeled corpus, per
  category; owner reviews/edits it exactly like Section 0.
- Retrieval: embed the **structured area descriptions** (text embeddings,
  not raw image embeddings — simpler, auditable, model-agnostic). Corpus
  is small: precomputed embeddings in a JSONL + in-process cosine. No
  vector DB.

### Phase 4 — Drafter integration (1–2 sessions)

Wire the pre-pass into `packages/quoting` + `tools/src/drafter/run.ts`.
Regression gate: re-run Erin's thread — it must find three areas and
account for all three.

### Phase 5 — Evaluation (1 session + iteration)

Hold out 60–80 corpus cases untouched by Phases 2–3. Metrics:

- area-count accuracy (the Erin failure mode)
- line-item set match (precision/recall vs what was actually quoted)
- total-price median error (text-only spike baseline: ~16%)
- scope-accounting completeness

This is where we learn whether the grounding actually moved the needle,
and it defines the confidence threshold empirically rather than by feel.

### Phase 6 — Confidence gating + event-keyed trigger (REVISED 2026-10-18)

**The trigger is event-keyed, not cron-keyed** (owner directive). The
daily cron analyzes everything long after the moment has passed; the
right design fires one analysis for one customer at the moment enough
information exists. Four trigger moments, mapped to systems AAC already
has:

| Moment | Signal source | Timing |
|---|---|---|
| T1 Photo burst settles | Quo inbound webhook (middleware already ingests) | 15-min debounce after the last inbound message in a thread with ≥1 photo or a concrete ask |
| T2 Assessment debrief completes | Field-app flow completion, or first Matt↔Mike call/text ending after an assessment event's end time (transcript lands minutes later) | fire immediately — THE moment for post-assessment quotes, with runtime field context |
| T3 Quote promised | Outbound "I'll get that quote to you" (today caught next-morning by triage L1 — moves to webhook-time) | immediate |
| T4 Emailed photos | Gmail ingest | same debounce as T1 |

**Execution architecture** (middleware stays sacrosanct-thin): webhook
handlers only *enqueue* trigger events (Redis, key builder); a thin
runner — natural home `apps/agent` — drains the queue, runs the full
grounded pipeline (pre-pass → retrieval → runtime field context → draft
→ validator), and applies the gate. A frequent drainer schedule is an
implementation detail (executor), not the trigger (signal).

**The gate is composite and population-aware** (holdout-calibrated
2026-10-18): auto-create only when ALL hold — predicted scope is
injection-family only AND ≤2 scope lines (that stratum runs 86% exact /
92% family; its misses are small-dollar line edits); k=3 self-consistency
agreement on the item set; no `needs_site_visit`; no open questions;
every ask and photo area accounted; validator clean. Complex scope
(resurfacing/masonry, 3+ lines, $4k+ — measured ~50-60% exact) NEVER
auto-drafts: it routes to triage with the analysis attached as prepared
context (the high-touch path).

- **Shadow mode first:** the runner goes live on real triggers but
  dry-run — logs trigger moment, gate verdict, and the would-be draft to
  a triage dashboard section. 2–3 weeks; the owner's accept/reject per
  shadow draft becomes the next label set.
- **Flip:** gate-passing triggers auto-create Pending bot drafts.
  Review in QBO remains; nothing is ever auto-sent. Auto-send is a
  separate, later, owner-only decision.

## Total level of effort

| | |
|---|---|
| Build sessions | **~9–13** across the six phases |
| Calendar | **~4–6 weeks** (the shadow period dominates the tail) |
| Owner time | **~3–5 hours total**: tricky-pile review, Section V sign-off, shadow-week spot checks |
| One-time API cost | A few thousand photos through flash vision + text embeddings ≈ **tens of dollars** on the prepay account |
| Runtime cost delta | Negligible (pre-pass adds 1–2 flash calls per draft) |

Natural checkpoints: after Phase 2 (is the corpus as good as hoped?) and
after Phase 5 (do the holdout numbers justify the trigger?). Either is a
cheap place to stop or re-aim.

## Risks and open questions

1. ~~Old Quo media expired~~ — **eliminated** (probed live: 2024-09 media
   downloads fine).
2. **Attribution noise** — repeat customers / photos sent long before the
   estimate. Mitigation: date-window joins, flag-don't-guess, tricky pile.
3. **Pricing drift contamination** — handled by dated exemplars +
   Section 0 supremacy (see design decision above).
4. **Tricky photos** — owner-flagged; the Phase 2 review loop exists
   precisely for these, and persistent tricky categories simply gate to
   `needs_site_visit` rather than low-quality auto-drafts.
5. **Gmail sweep scale** — 2-year attachment sweep across all customers
   is the slowest harvest step; rate-limit pacing, resumable manifest.
6. **Model churn** — mitigated by design: ruleset + exemplars are
   prompt-side assets; nothing is tuned to a model generation.

## Explicitly out of scope (v1 of this layer)

- Fine-tuning any model (revisit criterion: hybrid plateaus on holdout).
- Auto-sending quotes — the trigger creates Pending drafts only.
- Field-app job photos as training input (they're post-sale work photos,
  different distribution; the corpus is *customer-sent pre-quote* photos).

## History

- 2026-10-16 — plan written per owner directive (same day as drafter v1).
  Retention probe run live: oldest corpus MMS (2024-09) still
  downloadable. Probe scripts: `tools/src/scratch/probe-old-quo-media*.ts`.
