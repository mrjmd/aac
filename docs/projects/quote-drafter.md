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
- Canonical line descriptions are reused from the most recent real
  estimates (so drafts read in Matt's voice); the Guarantee line is
  appended automatically.
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

## History

- 2026-10-16 — built (same day as the quoting Stage-1 spike GO verdict);
  decision log: skip v0 (triage-markdown drafts) entirely, owner wants
  real QBO Pending estimates. First live draft #1554 (Erin Tortorella,
  bulkhead + masonry, $3,550, site-visit flagged).
