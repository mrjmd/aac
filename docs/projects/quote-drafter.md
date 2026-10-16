# Quote Drafter v1 — Bot-Marked Pending Estimates

**Status:** LIVE (manual runs) as of 2026-10-16. First draft: estimate #1554.

## What it does

For each `quote_promised` finding in the latest triage run (a customer Matt
told he'd send a quote, with no matching estimate in QBO), the drafter:

1. Pulls the full Quo SMS thread + up to 6 inbound MMS photos.
2. Resolves the QBO customer (triage snapshot phone join → DisplayName
   search → create).
3. Drafts estimate lines with Gemini (`gemini-3.6-flash`, photos attached
   as multimodal input) against the canonical pricing ruleset — SECTION 0
   of `analysis/data/quoting-spike/llm-ruleset.md` is the pricing
   authority.
4. Validates deterministically (unknown items hard-fail; the
   multi-injection discount is enforced as a formula: only at 3+ injection
   units, exactly −$75/unit; cash discounts stripped — payment method is
   unknown at draft time).
5. Creates a **Pending** estimate in QBO. Never sent, never emailed.

Every draft is unmistakably bot-marked:

- Top line (DescriptionOnly): `⚠️ BOT DRAFT — REVIEW BEFORE SENDING ⚠️ …`
- PrivateNote: `BOT DRAFT — quote drafter v1 (date)` + scope, total,
  confidence, Section-0 reasoning, up to 3 recent comparable estimates
  ("your last similar jobs ran $X"), open questions, and any
  auto-corrections the validator applied.
- Line descriptions are the **standard QBO item templates verbatim**
  (owner rule, 2026-10-16): `QBItem.Description` first, most recent real
  estimate's wording second, model text only when neither exists. The
  model is told its descriptions are discarded. Specificity goes in a
  **bracketed scope note** prepended to the template (owner convention,
  e.g. `[bulkhead corner crack]`). The Guarantee line is appended
  automatically.
- **Scope accounting is mandatory** (owner rule, 2026-10-16): every
  distinct customer ask must be mapped to the line that covers it or
  explicitly excluded with a reason + a one-sentence suggested customer
  reply. The mapping renders in the PrivateNote ("every customer ask →
  coverage"); the validator warns on missing/dangling/reason-less
  entries. Silent omissions are the one unforgivable drafting error.
- **Scope must be evidenced** (ruleset Section 0 rule 12 + prompt hard
  rule): never infer a repair from the mere presence of a structure.
  Bulkhead injection requires water signs at the seam sides, the bolts,
  or the bottom of the stairs.
- Doc numbers continue the estimate sequence (custom transaction numbers
  are ON in AAC's QBO — the API assigns nothing if omitted).

## Running it

```bash
# after a triage refresh (findings.json must be current):
npx tsx tools/src/drafter/run.ts              # draft all quote_promised findings
npx tsx tools/src/drafter/run.ts --dry-run    # print drafts, create nothing
npx tsx tools/src/drafter/run.ts --phone +1617…   # one thread only
```

Run log appends to `analysis/data/triage/drafts.json`.

## Idempotency

Two layers: the `quote_promised` detector stops firing once any estimate
matches the customer (the bot draft counts), and the runner skips any
customer who already has a Pending bot draft (detected via the
`BOT DRAFT` marker in PrivateNote or top line — `isBotDraft()`).

## Where the code lives

- `packages/quoting/src/draft-quote.ts` — all drafting logic, pure
  functions (prompt build, parse, validate, assemble, comparables,
  private note). Fully unit tested.
- `packages/api-clients` — `QuickBooksClient.createEstimate/updateEstimate/listItems`,
  `GeminiClient.generateContent({ imageParts })`.
- `tools/src/drafter/run.ts` — orchestration + I/O only.

## Scope guards (v1)

- Email-only `quote_promised` findings are skipped (logged) — no phone,
  no Quo thread.
- Low-confidence scope → the model is instructed to still draft but set
  `needs_site_visit` + open questions rather than invent prices.
- NOT wired into the 08:15 triage cron yet — manual runs until Matt
  trusts the output. Known LLM caveat: run-to-run line variance on
  ambiguous scope (observed on the first live draft: $3,850 vs $3,550 for
  the same thread); the ruleset pins crack pricing but masonry/odd work
  moves. The bot marker + review step is the control for this.

## Photo layer (Phase 4 of photo-quote-training, 2026-10-16)

When `analysis/data/photo-corpus/exemplar-library.jsonl` exists, a photo
**pre-pass** runs before the draft prompt: the photos are segmented into
distinct physical AREAS (same crack from two angles = one area; different
structures = separate areas), each area's situation text is embedded and
the 3 most similar historical areas are retrieved from the exemplar
library (what was actually quoted — or deliberately NOT quoted — in that
situation), and the result is injected into the draft prompt. Section V
(`section-v-draft.md`, DRAFT until owner sign-off) rides along as the
visual ruleset. scope_accounting must then cover every photo area as well
as every textual ask. Exemplars teach scope reading only — Section 0
remains the sole pricing authority. Everything degrades gracefully to v1
behavior when the assets are absent or the pre-pass fails.

Regression gate: Erin Tortorella's thread must segment into 3 areas
(breezeway step / bulkhead door rim / flagstone front step) — passed
2026-10-16 on the first grounded run, including a Best Bulkheads referral
in the exclusion reply.

## Known gaps / next

- **Guarantee variant selection**: the QBO Guarantee item template is the
  lifetime transferable crack-injection guarantee; masonry/resurfacing
  jobs historically carry a 2-year warranty variant instead. The drafter
  currently always appends the item template — wrong variant on
  masonry-only drafts. Needs scope-category-aware selection
  (classifyScope already distinguishes these).
- Template placeholder filling (sqft/LF blanks) not yet implemented —
  templates go in verbatim; measurements live in the PrivateNote.
- No automatic trigger — manual runs only (see "Running it"). Wiring it
  into the 08:15 triage cron is the deliberate next step once the owner
  trusts the output.

## History

- 2026-10-16 — built (same day as the quoting Stage-1 spike GO verdict);
  decision log: skip v0 (triage-markdown drafts) entirely, owner wants
  real QBO Pending estimates. First live draft #1554 (Erin Tortorella,
  bulkhead + masonry, $3,550, site-visit flagged).
- 2026-10-16 (rev 2, owner review of #1554) — two corrections folded in:
  (1) descriptions must be the standard QBO item templates verbatim,
  never model-rewritten; (2) the model had inferred Bulkhead Injection
  from the mere presence of a bulkhead — evidence rule added to ruleset
  (Section 0 rule 12) and prompt. #1554 deleted + recreated (masonry
  only, $1,650). `deleteEstimate` added to QuickBooksClient for draft
  cleanup.
