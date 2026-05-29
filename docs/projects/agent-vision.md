# Project Spec — apps/agent Vision & Model Decisions

**Status:** Living doc — deliberation, not decision
**Owner:** Matt
**Created:** 2026-05-28
**Pillar:** 6 (apps/agent/)
**Companion to:** `docs/projects/apps-agent.md` (the tactical Crawl/Walk/Run spec)
**Decisions migrate to:** `docs/DECISIONS.md` once locked.

---

## What this doc is

`docs/projects/apps-agent.md` answers *what we're building right now and in
what order*. This doc answers *what we're building toward in the long run*
and *how that shapes the model and architectural choices we make along the
way*.

It exists because the LLM choice for Walk 3+ depends on a question bigger
than "which model classifies intents fastest." The agent's destination — a
voice-cloned, memory-rich strategic partner — sets capability requirements
that the tactical spec doesn't surface on its own. Lock model choices
against the destination, not against the immediate next step.

This is a **deliberation log**, not a decided plan. Sections may stay
open-ended. When a sub-question locks, the decision moves to
`docs/DECISIONS.md` with a one-line pointer left here.

---

## The destination — five capability layers

The most ambitious version of apps/agent that's actually buildable in our
profile (Matt's the sole developer, raw Vercel functions, no in-house ML
or fine-tuning infrastructure). Each layer is buildable today on frontier
LLM APIs; each compounds on the ones below it. None require an
architecture rewrite — they're all more sophisticated *uses* of the deal
spine + tool surface already shipped.

### Layer 1 — Voice fidelity

The agent's outbound drafts sound like Matt wrote them. Casual when
casual fits, professional when it doesn't, warm without being chirpy,
direct without being curt — the same register-mixing Matt does naturally
in his actual texts.

**Buildable mechanism:** behavioral cloning via in-context examples. Build a
semantic retrieval index over Matt's full year+ of Quo conversation history
(SMS, MMS, call transcripts when available). For any outbound draft, the
nudge-drafting prompt receives 5–15 of Matt's *actual past messages* from
the most similar situations (similar customer state, similar conversational
move). The model pattern-matches voice from real examples. No fine-tuning
needed.

**Concretely required:**
- Quo conversation history exported / indexed (Turso + embedding column, or
  a vector store; decision deferred)
- Embedding model choice (small + cheap; OpenAI ada or Gemini embeddings)
- Per-message metadata: deal stage at time of send, customer relationship
  age, conversational move (greeting / scheduling / quote follow-up /
  small talk / etc.)
- Retrieval pipeline: query → embedding → top-k from corpus → injected as
  few-shot examples in the drafting prompt

**Quality bar (LLM-judged + spot-checked):** Matt can read a draft and not
be able to tell whether he wrote it. Initial calibration: every draft for
the first ~50 sends gets Matt's review + a 0–5 voice-fidelity score; the
retrieval prompt iterates against those.

### Layer 2 — Deep business memory

The agent has working memory of every customer relationship, job, decision,
and conversation in the business. Queries like "remind me what happened
with the Booher job" return a *narrative summary* synthesized from the deal
record + estimate + invoice + Quo history + calendar events + middleware
audit log — not a raw transcript dump.

**Buildable mechanism:** the read-tool surface (Walk 2) is the substrate; this
layer adds (a) per-customer narrative summarization cached as deal metadata,
(b) cross-customer pattern retrieval ("how did we handle similar situations
in the past?"), (c) decision capture (when Matt makes a non-obvious call,
the agent prompts to capture the reasoning so the memory accrues meaning,
not just facts).

**Concretely required:**
- Narrative-summary background job — runs after deal-stage transitions,
  produces a 200-word summary stored as deal metadata; refreshed on
  significant new activity
- Cross-customer pattern retrieval — embed historical situations (e.g.
  "customer asks about scope mid-quote") for similarity lookup
- Decision capture loop — when Matt corrects a proposal, store the
  reasoning ("not this customer — they always want a phone call first")
  as a structured memory entry keyed to the situation type

**Quality bar:** Matt can ask any customer-context question and get a
response with the same level of recall and nuance he'd give if asked
verbally. Working memory is the agent's distinguishing feature; without
it, every interaction is a fresh stranger conversation.

### Layer 3 — Strategic partner mode

Same tool surface, but invoked differently. The agent reasons *about* the
operational data, not just retrieves it. Questions like "what should I work
on this week?" return: "Funnel A Phase 2 saves ~2h/wk on quote follow-ups
based on your last 8 weeks; stale pool shows \\$31k of priority value.
Worth pulling over Walk 5?" — backed by tool calls that quantify both
sides.

**Buildable mechanism:** a separate prompt + tool subset wrapped around the
read tools. Strategic mode runs at a longer time budget (60s+), with the
model authorized to chain 10–20 tool calls and synthesize across them.
Probably warrants a stronger model (Opus or equivalent) reserved for these
queries — they're rare (once a week, maybe) and high-leverage.

**Concretely required:**
- Strategic-mode entry point in the comms interface (a recognized command
  pattern or topic classifier flag)
- Extended tool surface: portfolio-level views, time-allocation summaries,
  ROI estimates per active automation
- Longer Vercel function timeout (or queue-backed async with progress
  updates via SMS)
- Decision capture loop hooks in here too — strategic suggestions become
  context for future strategic queries

**Quality bar:** Matt asks the agent "what's the next highest-leverage
system to build?" and the answer is good enough that he doesn't have to
re-derive it from scratch. Not "the agent decides for him"; the agent does
the legwork so the decision is faster + better-informed.

### Layer 4 — Self-reflective improvement

The agent reads its own audit log, notices when its proposals were wrong
(Matt corrected, said no, or said yes-but-different), and surfaces patterns:
"you've corrected my classification of pricing-questions 4 times in 2
weeks; here's how I'd revise the prompt." Proposes its own prompt and
standing-rule revisions through the same propose-dialogue loop everything
else uses.

**Buildable mechanism:** a weekly reflection cron that walks the recent
audit log + Matt's responses, clusters errors, and drafts revision
proposals. Reflection runs at strategic-mode model tier (it's the same
type of reasoning task).

**Concretely required:**
- Audit log enrichment: capture not just the decision but the outcome (was
  the reply accepted? did Matt correct? did the customer respond well?)
- Cluster-mining over corrections (themes recur or are one-offs)
- Prompt + standing-rule revision proposals routed through the normal
  propose-dialogue loop

**Quality bar:** the agent gets observably better over time without Matt
having to push prompt edits manually. The system improves itself.

### Layer 5 — Behavior-graduated autonomy

The current spec graduates autonomy via Matt's explicit promotion ("you can
just do this now, stop asking"). The ambitious layer: the agent tracks its
own track record per action class and surfaces graduation proposals
proactively: "I've been right 14/14 on invoice-creation proposals over the
last 6 weeks — promote me to act-and-notify? Same rollback if you ever say
'no, don't do that anymore.'"

**Buildable mechanism:** per-action-class accuracy tracking in the audit
log, threshold-triggered proposals, easy rollback. The mechanism is
straightforward; the *judgment* about thresholds and risk profile per
action class is where the work is.

**Quality bar:** Matt feels the agent earning the trust, not asserting it.
The graduation is itself a dialogue.

---

## Why these layers reframe the model question

Initial framing was "cost vs latency vs vendor count for intent
classification + nudge drafting." That's a question about Layer 0 (the
Walk-phase baseline). For Layers 1–5, the capability axes that matter are
different:

| Axis | What it means in our system | Where it matters most |
|---|---|---|
| **Register-matching from few-shot** | Picks up Matt's voice from a handful of his actual messages | Layer 1 (voice fidelity) |
| **Long-context reasoning** | Holds 50k–200k tokens of customer history + similar-situation examples in one prompt and *uses* them | Layers 1, 2 |
| **Chained tool use** | 5–20 tool calls deep, deciding what to call next based on previous results | Layers 2, 3 |
| **Multi-turn dialogue continuity** | Maintains a position across turns, defends it, updates on new info | All layers (propose-dialogue) |
| **Meta-reasoning** | Reasons about its own reasoning — what went wrong, what to change | Layers 3, 4 |
| **Cost / latency at high volume** | Per-call cost + ms-to-first-token for high-frequency tasks | Walk-phase classifier only |

The early-layer choice (Walk 3 classifier) optimizes for cost/latency.
Every layer above it optimizes for capability. Treating them as a single
model decision misses the point.

---

## Current model options

### A — Single model: Sonnet across the board

Strong on voice/judgment/tool-use; cost trivial at our volume. Loses on
high-frequency latency (Walk-phase classifier).

### B — Single model: Gemini Flash across the board

Already wired (entity extraction in middleware). Loses meaningfully on
register-matching and chain-of-tool reasoning — the regimes Layers 1–4
depend on.

### C — Cross-vendor fan-out: Flash classifier + Sonnet/Opus reasoning

Right-sizes per task. Adds vendor count, billing surfaces, rate-limit
budgets, debugging complexity.

### D — Anthropic-family fan-out: Haiku classifier + Sonnet daily + Opus strategic

The variant the initial framing missed. One vendor, one SDK, one billing
page — but right-sized within the family. Haiku handles the high-frequency
classifier; Sonnet handles daily ops + nudge drafts; Opus reserved for
strategic-mode (Layer 3) and reflective (Layer 4) queries where the
premium pays off.

---

## Open questions

These resolve before locking. Each is its own sub-deliberation.

1. **Voice corpus prep.** What does the export pipeline look like? Where
   does the corpus live (Turso? S3 + on-disk vector index in a separate
   embedding service?). Who has access? How do we handle PII / future
   customers asking us to "forget" them?
2. **Evaluation harness.** How do we measure voice fidelity beyond "Matt
   reads it"? Capture the first ~50 send-pairs (draft vs. final-edited),
   score by hand, build a regression set for prompt iterations.
3. **What "good enough" looks like per layer.** Layer 1 (voice) has the
   highest bar — outbound text touches customers. Layer 3 (strategic) has
   the loosest — wrong-but-thoughtful is still useful. Per-layer SLAs
   inform model choice and the propose-dialogue threshold.
4. **Strategic-mode trigger.** Implicit (intent classifier flags it) or
   explicit (`/strategy` command pattern)? Probably both, but the
   classifier path is more in keeping with the "feels like texting an
   assistant" spec principle.
5. **Decision capture mechanism.** Layer 2 + Layer 4 both depend on
   capturing *why* Matt decided what he did. Without that, the memory
   accrues facts but not judgment. How does the prompt-for-reasoning loop
   feel — annoying interrupt or natural conversation move?
6. **Reflective-improvement cadence.** Weekly cron? On-demand? Triggered
   by N corrections in a rolling window?
7. **The Gemini-in-middleware question.** Entity extraction in middleware
   currently uses Gemini. Migrate to Anthropic for consistency, or keep
   per "if it ain't broke"? Probably keep until there's a concrete reason
   to migrate; the architecture is already vendor-agnostic at the client
   layer.

---

## Decisions log

| Date | Decision | Why | Pointer |
|---|---|---|---|
| — | (none yet — the LLM choice for Walk 3+ is the next deliberation) | | |

When decisions lock, they migrate here with one line + a pointer to the
full reasoning in `docs/DECISIONS.md`.

---

## How this doc evolves

- Capability layers can be refined or extended as the vision sharpens.
- New open questions get added; resolved ones move to Decisions log.
- When the LLM choice is locked, the full reasoning lives in
  `DECISIONS.md`; the row above gets one line.
- Tactical implementation steps stay in `apps-agent.md`; this doc is the
  destination, that doc is the route.

When this doc grows past ~10 pages, split the layers into their own files
under `docs/projects/agent-layers/` and keep this as the index.
