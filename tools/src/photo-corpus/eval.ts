#!/usr/bin/env npx tsx
/**
 * Holdout evaluation — Phase 5 of the photo→quote training layer.
 *
 * Runs the GROUNDED drafting pipeline (area pre-pass → train-split
 * exemplar retrieval → draft prompt with Section 0 + train-split Section V)
 * against the 80 holdout estimates nothing was distilled from, and
 * compares item-set accuracy to the same cases' ungrounded blind baseline
 * (Phase 2). Everything runs from local corpus data — no QBO/Quo calls.
 *
 * Usage (after distill.ts --exclude … --out section-v-train.md):
 *   npx tsx tools/src/photo-corpus/eval.ts            # full holdout (resumable)
 *   npx tsx tools/src/photo-corpus/eval.ts --limit 5
 */

import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';
import {
  buildAreaAnalysisPrompt,
  buildQuoteDraftPrompt,
  areaSituationText,
  formatPhotoContext,
  parseAreaAnalysis,
  parseQuoteDraftResponse,
  retrieveSimilar,
  type DraftThreadMessage,
  type ExemplarLibraryEntry,
} from '@aac/quoting';

const OUT_DIR = 'analysis/data/photo-corpus';
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.jsonl');
const EXEMPLARS_PATH = path.join(OUT_DIR, 'exemplars.jsonl');
const LIBRARY_PATH = path.join(OUT_DIR, 'exemplar-library.jsonl');
const HOLDOUT_PATH = path.join(OUT_DIR, 'holdout.json');
const SECTION_V_TRAIN_PATH = path.join(OUT_DIR, 'section-v-train.md');
const SECTION_0_PATH = 'analysis/data/quoting-spike/llm-ruleset.md';
const RESULTS_PATH = path.join(OUT_DIR, 'eval-results.jsonl');
const SMALL_DIR = path.join(OUT_DIR, 'photos-small');
const MODEL = 'gemini-3.6-flash';
const MAX_PHOTOS = 12;
const EXEMPLARS_PER_AREA = 3;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NON_SCOPE = /guarantee|discount|deposit|warranty/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const FAMILIES: Record<string, string[]> = {
  injection: ['crack repair', 'crack repair e', 'concrete floor crack', 'window injection', 'cold joint', 'sewer inlet', 'tie hole', 'bulkhead injection', 'spot injection', 'surface seal', 'carbon fiber', 'hydraulic cement', 'pipe penetration', 'decomissioned penetration', 'hole in foundation'],
  resurfacing: ['concrete resurfacing', 'pool deck', 'sidewalk', 'overlay', 'steps resurfacing', 'resurfacing'],
  masonry: ['masonry repair', 'mortar repointing', 'corner rebuilding', 'cinder block', 'parging', 'brick'],
  'bulkhead-mech': ['bulkhead door seal', 'bulkhead replacement'],
  prep: ['removing materials', 'sheetrock', 'excavation'],
};
function fam(item: string): string {
  for (const [f, keys] of Object.entries(FAMILIES)) {
    if (keys.some((k) => item.includes(k))) return f;
  }
  return 'other';
}

function smallPathFor(file: string): string {
  const stem = file.replace('photos/', '').replace('/', '__');
  return path.join(SMALL_DIR, stem.replace(/\.[a-zA-Z0-9]+$/, '') + '.jpg');
}

async function callWithRetry(
  gemini: GeminiClient,
  prompt: string,
  opts: { systemPrompt?: string; imageParts?: Array<{ mimeType: string; base64: string }> },
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await gemini.generateContent(prompt, {
        systemPrompt: opts.systemPrompt,
        temperature: 0,
        maxOutputTokens: 8192,
        thinkingBudget: 4096,
        timeoutMs: 180_000,
        imageParts: opts.imageParts?.length ? opts.imageParts : undefined,
      });
    } catch (err) {
      lastErr = err as Error;
      if (attempt < 2 && /429|500|503|timeout|aborted/i.test(lastErr.message)) {
        await sleep(lastErr.message.includes('429') ? 65_000 : 5_000 * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('unreachable');
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;

  const holdout: string[] = JSON.parse(fs.readFileSync(HOLDOUT_PATH, 'utf8')).holdoutEstimateIds;
  const holdoutSet = new Set(holdout);
  const man = new Map(
    fs.readFileSync(MANIFEST_PATH, 'utf8').split('\n').filter(Boolean).map((l) => {
      const m = JSON.parse(l);
      return [m.estimateId as string, m] as const;
    }),
  );
  const exemplars = new Map(
    fs.readFileSync(EXEMPLARS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => {
      const e = JSON.parse(l);
      return [e.estimateId as string, e] as const;
    }),
  );
  const trainLibrary: ExemplarLibraryEntry[] = fs
    .readFileSync(LIBRARY_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e: { estimateId: string }) => !holdoutSet.has(e.estimateId));
  const sectionVTrain = fs.readFileSync(SECTION_V_TRAIN_PATH, 'utf8');
  const section0 = fs.readFileSync(SECTION_0_PATH, 'utf8');

  // Item vocabulary = the real corpus menu.
  const itemNames = [...new Set(
    [...man.values()].flatMap((m) => m.lines.map((l: { item: string }) => l.item)),
  )].sort();

  const done = new Set<string>(
    fs.existsSync(RESULTS_PATH)
      ? fs.readFileSync(RESULTS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).estimateId as string)
      : [],
  );
  const targets = holdout.filter((id) => !done.has(id)).slice(0, limit);
  console.log(
    `holdout ${holdout.length}, done ${done.size}, running ${targets.length} — train library ${trainLibrary.length} areas, Section V-train ${sectionVTrain.length} chars\n`,
  );

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing env: GEMINI_API_KEY');
  const gemini = new GeminiClient({ apiKey, textModel: MODEL });

  let n = 0;
  for (const id of targets) {
    const m = man.get(id);
    const ex = exemplars.get(id);
    if (!m || !ex) continue;
    const tag = `[${++n}/${targets.length}] #${m.docNumber} ${m.customerName}`;
    try {
      const thread: DraftThreadMessage[] = m.thread.map((t: { at: string; direction: string; text: string }) => ({
        at: t.at,
        direction: t.direction === 'outgoing' ? 'outgoing' : 'incoming',
        text: t.text,
      }));
      const photos = m.photos.slice(0, MAX_PHOTOS);
      const imageParts = photos.map((p: { file: string }) => ({
        mimeType: 'image/jpeg',
        base64: fs.readFileSync(smallPathFor(p.file)).toString('base64'),
      }));

      // ── pre-pass ──
      let photoContext: string | undefined;
      let areaCount = 0;
      const areaRaw = await callWithRetry(
        gemini,
        buildAreaAnalysisPrompt({ thread, photoCount: imageParts.length, itemNames }),
        { imageParts },
      );
      const analysis = parseAreaAnalysis(areaRaw);
      if (analysis) {
        areaCount = analysis.areas.length;
        const situations = analysis.areas.map((a) => areaSituationText(a, analysis.photoReads));
        const vectors = await gemini.embedContent(situations, { timeoutMs: 60_000 });
        photoContext = formatPhotoContext({
          analysis,
          retrieved: analysis.areas.map((area, i) => ({
            area,
            exemplars: retrieveSimilar(vectors[i], trainLibrary, EXEMPLARS_PER_AREA),
          })),
        });
      }

      // ── grounded draft ──
      const { systemPrompt, userPrompt } = buildQuoteDraftPrompt({
        customerName: m.customerName,
        phone: m.customerPhone ?? 'unknown',
        today: m.txnDate, // draft "as of" the real quote date
        rulesetText: section0,
        itemNames,
        thread,
        photoCount: imageParts.length,
        photoContext,
        visualRulesetText: sectionVTrain,
      });
      const raw = await callWithRetry(gemini, userPrompt, { systemPrompt, imageParts });
      const draft = parseQuoteDraftResponse(raw);
      if (!draft) throw new Error('unparseable draft');

      // ── metrics ──
      const actual = new Set(
        m.lines.filter((l: { item: string }) => !NON_SCOPE.test(l.item)).map((l: { item: string }) => norm(l.item)),
      );
      const grounded = new Set(
        draft.lines.filter((l) => !NON_SCOPE.test(l.item)).map((l) => norm(l.item)),
      );
      const blind = new Set(
        (ex.blind?.areas ?? []).flatMap((a: { predicted_items?: string[] }) => a.predicted_items ?? []).map(norm),
      );
      const setEq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
      const famSet = (s: Set<string>) => new Set([...s].map(fam));
      const groundedTotal = draft.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);

      const row = {
        estimateId: id,
        docNumber: m.docNumber,
        txnDate: m.txnDate,
        customerName: m.customerName,
        areaCount,
        actualItems: [...actual],
        groundedItems: [...grounded],
        blindItems: [...blind],
        groundedExact: setEq(grounded, actual),
        blindExact: setEq(blind, actual),
        groundedFamily: setEq(famSet(grounded), famSet(actual)),
        blindFamily: setEq(famSet(blind), famSet(actual)),
        actualTotal: m.totalAmt,
        groundedTotal,
        needsSiteVisit: draft.needsSiteVisit,
        confidence: draft.confidence,
      };
      fs.appendFileSync(RESULTS_PATH, JSON.stringify(row) + '\n');
      console.log(
        `${tag}: grounded ${row.groundedExact ? 'EXACT' : row.groundedFamily ? 'family' : 'MISS'} | blind ${row.blindExact ? 'EXACT' : row.blindFamily ? 'family' : 'MISS'} | $${groundedTotal} vs $${m.totalAmt}`,
      );
      await sleep(300);
    } catch (err) {
      console.log(`${tag}: ✗ FAILED — ${(err as Error).message.slice(0, 140)} (will retry on next run)`);
    }
  }

  // ── summary over everything evaluated so far ──
  const rows = fs.readFileSync(RESULTS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pct = (k: string) => `${rows.filter((r) => r[k]).length}/${rows.length} (${Math.round((rows.filter((r) => r[k]).length / rows.length) * 100)}%)`;
  console.log(`\n=== HOLDOUT SUMMARY (${rows.length} cases) ===`);
  console.log(`exact item-set:  grounded ${pct('groundedExact')}  vs blind ${pct('blindExact')}`);
  console.log(`family-level:    grounded ${pct('groundedFamily')} vs blind ${pct('blindFamily')}`);
  const errs = rows
    .filter((r) => r.actualTotal > 0 && r.groundedTotal > 0)
    .map((r) => Math.abs(r.groundedTotal - r.actualTotal) / r.actualTotal)
    .sort((a, b) => a - b);
  if (errs.length) {
    console.log(`price error (median abs, historical-price caveat): ${(errs[Math.floor(errs.length / 2)] * 100).toFixed(0)}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
