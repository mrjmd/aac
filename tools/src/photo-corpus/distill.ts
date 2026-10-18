#!/usr/bin/env npx tsx
/**
 * Section V distillation — Phase 3 of the photo→quote training layer.
 *
 * Packs structured evidence from the exemplar corpus into four focused
 * synthesis prompts and drafts the visual-indicators ruleset:
 *   1. Variant selection (which item variant, from what visual/textual cues)
 *   2. Indication rules (what NOT to quote without specific evidence)
 *   3. Pairing rules (add-ons that ride along with main items)
 *   4. Exclusion behavior + owner customer-language
 *
 * Output is a DRAFT for owner review — analysis/data/photo-corpus/
 * section-v-draft.md. Nothing is canonical until Matt signs off (it then
 * moves into llm-ruleset.md as SECTION V).
 *
 * Usage:
 *   npx tsx tools/src/photo-corpus/distill.ts
 *   npx tsx tools/src/photo-corpus/distill.ts --exclude analysis/data/photo-corpus/holdout.json --out .../section-v-train.md
 * (--exclude drops the listed estimateIds from the evidence — used to
 *  build the leakage-free training variant for the Phase 5 holdout eval)
 */

import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';

const OUT_DIR = 'analysis/data/photo-corpus';
const LIBRARY_PATH = path.join(OUT_DIR, 'exemplar-library.jsonl');
const EXEMPLARS_PATH = path.join(OUT_DIR, 'exemplars.jsonl');
const OWNER_NOTES_PATH = path.join(OUT_DIR, 'owner-notes.jsonl');
const DRAFT_PATH = path.join(OUT_DIR, 'section-v-draft.md');
const MODEL = 'gemini-3.6-flash';
const SAMPLES_PER_ITEM = 12;

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.diagnostic');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

interface LibEntry {
  docNumber: string;
  txnDate: string;
  situation: string;
  quotedItems: Array<{ item: string; unitPrice: number; qty: number }>;
  unquoted?: string;
  ownerWords: string[];
  lesson?: string;
}

const PREAMBLE = `You are distilling quoting rules for Attack A Crack (AAC), a Massachusetts foundation-repair company (basement crack injection + concrete/masonry resurfacing), from structured evidence of ~400 historical quoted jobs. The rules teach an AI drafter to read customer photos + texts the way the owner does.

Write terse, operational rules. Format each rule as:
- **<rule name>** — WHEN <visual/textual indicators> → <item(s)>. (evidence: n≈<count>)
Flag uncertainty explicitly ("UNCLEAR — owner to confirm: ..."). Never invent indicators not supported by the evidence.

PRICING: the owner ADOPTED A NEW PRICING POLICY (Section 0 of llm-ruleset.md) that deliberately changed several historical practices — so historical prices and discount behavior in the evidence MUST NOT be restated as rules. Never write a dollar amount, discount size, or discount trigger in any rule. If pairing/bundling behavior matters to scope (e.g., an item counts as an injection line), say so and cite "per Section 0" — the drafter always receives Section 0 alongside these rules. Known changed examples you must not echo: multi-crack discounts (historically −$100/crack from the 2nd crack; NOW only at 3+ injection lines, fixed −$75/line) and the crack anchor (historically drifted to $1,025–1,075; NOW $1,175). Rules are about WHAT to quote, never what it costs.`;

/** Owner corrections from the 2026-10 packet review — highest-authority
 *  evidence, injected into every synthesis call. Set in main(). */
let OWNER_CORRECTIONS = '';

async function synthesize(gemini: GeminiClient, title: string, prompt: string): Promise<string> {
  const text = await gemini.generateContent(`${PREAMBLE}\n\n${OWNER_CORRECTIONS}${prompt}`, {
    temperature: 0,
    maxOutputTokens: 8192,
    thinkingBudget: 4096,
    timeoutMs: 300_000,
  });
  console.log(`  ${title}: ${text.length} chars`);
  return text.trim();
}

function sampleFor(lib: LibEntry[], itemName: string, n = SAMPLES_PER_ITEM): string {
  const hits = lib.filter((e) =>
    e.quotedItems.some((q) => q.item.toLowerCase() === itemName.toLowerCase()),
  );
  // Newest first — menu naming settled over time.
  hits.sort((a, b) => b.txnDate.localeCompare(a.txnDate));
  return hits
    .slice(0, n)
    .map((e) => `- [#${e.docNumber} ${e.txnDate}] ${e.situation}${e.lesson ? ` | lesson: ${e.lesson}` : ''}`)
    .join('\n');
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const excludePath = argv.includes('--exclude') ? argv[argv.indexOf('--exclude') + 1] : undefined;
  const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : DRAFT_PATH;
  const excluded = new Set<string>(
    excludePath ? (JSON.parse(fs.readFileSync(excludePath, 'utf8')).holdoutEstimateIds as string[]) : [],
  );

  const libArg = argv.indexOf('--library');
  const exArg = argv.indexOf('--exemplars');
  const libraryPath = libArg >= 0 ? argv[libArg + 1] : LIBRARY_PATH;
  const exemplarsPath = exArg >= 0 ? argv[exArg + 1] : EXEMPLARS_PATH;
  let lib: LibEntry[] = fs.readFileSync(libraryPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let exemplars = fs.readFileSync(exemplarsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // Owner review corrections (2026-10): verbatim notes outrank corpus
  // patterns; downweighted cases leave the evidence pool entirely.
  if (fs.existsSync(OWNER_NOTES_PATH)) {
    const notes = fs.readFileSync(OWNER_NOTES_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const downweighted = new Set(
      notes.filter((n) => (n.labels ?? []).includes('bad_quote_downweight')).map((n) => String(n.docNumber)),
    );
    lib = lib.filter((e) => !downweighted.has(String(e.docNumber)));
    exemplars = exemplars.filter((e) => !downweighted.has(String(e.docNumber)));
    OWNER_CORRECTIONS = `OWNER CORRECTIONS (from the owner's case-by-case review — these OUTRANK any pattern you find in the evidence; if evidence conflicts with a correction, the correction wins):\n` +
      notes.map((n) => `- ${n.docNumber ? `[#${n.docNumber}] ` : '[GLOBAL] '}${n.note}`).join('\n') + '\n\n';
    console.log(`owner corrections: ${notes.length} notes loaded, ${downweighted.size} cases downweighted out of evidence`);
  }

  if (excluded.size > 0) {
    lib = lib.filter((e: LibEntry & { estimateId?: string }) => !excluded.has((e as { estimateId?: string }).estimateId ?? ''));
    exemplars = exemplars.filter((e) => !excluded.has(e.estimateId));
    console.log(`excluding ${excluded.size} holdout estimates from evidence`);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing env: GEMINI_API_KEY');
  const gemini = new GeminiClient({ apiKey, textModel: MODEL });

  console.log(`${lib.length} library entries, ${exemplars.length} exemplars\n`);

  // ── 1. Variant selection ──
  const VARIANTS = [
    'Crack Repair', 'Crack Repair E', 'Concrete floor crack', 'Sewer Inlet Injection',
    'Tie hole injections', 'Cold Joint', 'Window injection', 'Spot injection',
    'Fieldstone Injection', 'Fieldstone Repointing', 'Water Line Injection', 'Conduit Injection',
    'Bulkhead Injection', 'Surface Seal',
    'Concrete Resurfacing', 'Concrete Stair Resurfacing', 'Pool Deck Resurfacing', 'Garage resurfacing',
    'Masonry repair', 'Mortar Repointing', 'Concrete Corner Rebuilding',
  ];
  const variantEvidence = VARIANTS.map((v) => {
    const s = sampleFor(lib, v);
    return s ? `### ${v} — situations actually quoted as this item:\n${s}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
  const variantRules = await synthesize(
    gemini,
    'variant selection',
    `For each item below, the situations (from photos+texts) that the company ACTUALLY quoted as that item. Distill: how do you tell WHICH variant applies? Especially separate: Crack Repair (urethane) vs Crack Repair E (epoxy) vs Concrete floor crack vs Cold Joint vs the penetration variants (sewer/water/conduit/tie hole) vs Window injection; and the resurfacing variants by surface type; and fieldstone vs poured concrete treatment.\n\n${variantEvidence}\n\nWrite the "VARIANT SELECTION" rules.`,
  );

  // ── 2. Indication rules (over-prediction evidence) ──
  const overCases: string[] = [];
  for (const ex of exemplars) {
    const extra: string[] = ex.match?.extra ?? [];
    if (!extra.length) continue;
    const areas = (ex.blind?.areas ?? [])
      .filter((a: { predicted_items?: string[] }) =>
        (a.predicted_items ?? []).some((p) => extra.includes(p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())),
      )
      .map((a: { description: string }) => a.description)
      .join(' / ');
    const unq = (ex.join?.unquoted_areas ?? [])
      .map((u: { likely_reason?: string }) => u.likely_reason)
      .filter(Boolean)
      .join('; ');
    overCases.push(
      `- [#${ex.docNumber}] naive model predicted [${extra.join(', ')}] but actual quote had none of them. Area(s): ${areas || 'n/a'}${unq ? ` | why skipped: ${unq}` : ''}`,
    );
  }
  const indicationRules = await synthesize(
    gemini,
    'indication rules',
    `Each case below: a naive model OVER-predicted items the company did not quote. Distill "do NOT quote X unless <specific indicator>" rules — the company's real indication thresholds. Known confirmed rule for calibration: bulkhead injection requires water evidence at the seam sides, the bolts into the basement, or the bottom of the stairs — mere presence of a bulkhead is NOT an indication. Find the analogous rules for the other over-predicted items (window injection, bulkhead door seal, masonry/cinder block repair, extra crack lines, etc.).\n\n${overCases.slice(0, 180).join('\n')}\n\nWrite the "INDICATION THRESHOLDS — do not quote unless" rules.`,
  );

  // ── 3. Pairing rules ──
  const ADDONS = ['Surface Seal', 'Removing materials', 'Hydraulic cement', 'Carbon Fiber Staple(s)', 'Sheetrock / Paneling Removal', 'Tie hole injections'];
  const pairEvidence = ADDONS.map((a) => {
    const s = sampleFor(lib, a, 10);
    return s ? `### ${a} — situations where this add-on was quoted:\n${s}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
  const pairingRules = await synthesize(
    gemini,
    'pairing rules',
    `These add-on items ride along with main repairs. Co-occurrence stats across all 542 estimates: Surface Seal 21× (13 with Crack Repair); Carbon Fiber Staples 43× (29 with Crack Repair, 8 with Concrete Resurfacing); Removing materials 9× (5 with Crack Repair); Hydraulic Cement 4×; Tie holes 23× (12 with Crack Repair). Distill "when quoting X, check for Y if <indicator>" rules.\n\n${pairEvidence}\n\nWrite the "PAIRING / ADD-ON CHECKS" rules.`,
  );

  // ── 4. Exclusion behavior + owner language ──
  const unquotedEvidence = lib
    .filter((e) => e.unquoted && e.unquoted !== 'no line mapped')
    .slice(0, 80)
    .map((e) => `- [#${e.docNumber}] ${e.situation.slice(0, 160)} | skipped because: ${e.unquoted}`)
    .join('\n');
  const ownerQuotes = [...new Set(exemplars.flatMap((ex) => ex.join?.owner_words ?? []))]
    .filter((w: string) => w.length > 40)
    .slice(0, 150)
    .map((w: string) => `- "${w}"`)
    .join('\n');
  const exclusionRules = await synthesize(
    gemini,
    'exclusions + voice',
    `Part 1 — situations the company PHOTOGRAPHED BUT DID NOT QUOTE, with likely reasons. Distill the exclusion patterns: what does this company decline or defer, and what should a drafter flag as out-of-scope (with a suggested customer reply) instead of quoting?\n\n${unquotedEvidence}\n\nPart 2 — the owner's verbatim messages. Distill a short "OWNER VOICE" guide: how he frames problems, sets expectations, handles things he won't quote remotely (site visit, engineer referral, etc.). Quote 5-8 of the most characteristic lines as examples.\n\n${ownerQuotes}\n\nWrite "EXCLUSIONS & DEFERRALS" rules, then the "OWNER VOICE" guide.`,
  );

  const draft = `# SECTION V — Visual Indicators & Scope Reading (DRAFT — owner review required)

> Distilled ${new Date().toISOString().slice(0, 10)} from ${exemplars.length} photo-attributed estimates
> (${lib.length} segmented areas, 2024-09 → 2026-10) by ${MODEL}.
> NOT canonical until reviewed. These rules carry NO pricing: the corpus
> predates the pricing policy adopted 2026-10-16, so historical prices and
> discounts were deliberately stripped. SECTION 0 of llm-ruleset.md is the
> only pricing authority (anchor \\$1,175/crack; multi-injection discount
> only at 3+ injection lines, fixed −\\$75/line — never on 1–2 crack jobs).

## V.1 Variant selection

${variantRules}

## V.2 Indication thresholds

${indicationRules}

## V.3 Pairing / add-on checks

${pairingRules}

## V.4 Exclusions, deferrals & owner voice

${exclusionRules}
`;
  fs.writeFileSync(outPath, draft);
  console.log(`\nWrote ${draft.length} chars → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
