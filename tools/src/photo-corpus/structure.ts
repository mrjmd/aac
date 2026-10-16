#!/usr/bin/env npx tsx
/**
 * Photo-corpus structuring — Phase 2 of the photo→quote training layer
 * (docs/projects/photo-quote-training.md).
 *
 * For every photo-attributed estimate in the manifest, two Gemini passes:
 *
 *   A. BLIND — photos + thread excerpt only (actual quote hidden):
 *      per-photo structured reads, area segmentation, predicted items.
 *   B. JOIN — actual quoted lines revealed: line→area mapping, evidence
 *      quality per line, the owner's verbatim analysis language.
 *
 * A deterministic blind-vs-actual item comparison flags mismatches as the
 * "tricky pile" for owner review. Output: exemplars.jsonl (append,
 * resumable — one row per estimate).
 *
 * Usage (from repo root, after harvest.ts):
 *   npx tsx tools/src/photo-corpus/structure.ts              # full run (resumable)
 *   npx tsx tools/src/photo-corpus/structure.ts --limit 10   # pilot
 *   npx tsx tools/src/photo-corpus/structure.ts --estimate 123
 *
 * This is corpus tooling; the runtime drafter pre-pass (Phase 4) gets its
 * own @aac/quoting module informed by what this pass learns.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';

const OUT_DIR = 'analysis/data/photo-corpus';
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.jsonl');
const EXEMPLARS_PATH = path.join(OUT_DIR, 'exemplars.jsonl');
const SMALL_DIR = path.join(OUT_DIR, 'photos-small');
const MAX_PHOTOS_PER_CALL = 12;
const MODEL = 'gemini-3.6-flash';
const PACE_MS = 400;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 65_000;

// Items that say nothing about scope reading.
const NON_SCOPE_ITEMS = /guarantee|discount|deposit|warranty/i;

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

interface ManifestRow {
  estimateId: string;
  docNumber: string;
  txnDate: string;
  status: string;
  outcome?: string;
  totalAmt: number;
  customerId: string;
  customerName: string;
  lines: Array<{ item: string; description: string; unitPrice: number; qty: number; amount: number }>;
  thread: Array<{ at: string; direction: string; text: string; hadMedia?: boolean }>;
  photos: Array<{ file: string; source: string; at: string; withText?: string; daysBeforeEstimate: number | null }>;
}

function smallPathFor(file: string): string {
  const stem = file.replace('photos/', '').replace('/', '__');
  return path.join(SMALL_DIR, stem.replace(/\.[a-zA-Z0-9]+$/, '') + '.jpg');
}

function threadText(row: ManifestRow): string {
  return row.thread
    .map((m) => {
      const who = m.direction === 'outgoing' ? 'OWNER' : 'CUSTOMER';
      return `${m.at.slice(0, 10)} ${who}: ${m.text}${m.hadMedia ? ' [sent photos]' : ''}`;
    })
    .join('\n');
}

function photoLegend(photos: ManifestRow['photos']): string {
  return photos
    .map(
      (p, i) =>
        `Photo ${i + 1}: sent ${p.at.slice(0, 10)} via ${p.source}${p.withText ? ` with text: "${p.withText.slice(0, 120)}"` : ''}`,
    )
    .join('\n');
}

function blindPrompt(row: ManifestRow, itemMenu: string[], photos: ManifestRow['photos']): string {
  return `You are analyzing pre-quote photos sent by a customer to Attack A Crack, a Massachusetts foundation-repair company (two service categories: basement crack injection, and concrete/masonry repair + resurfacing).

Below is the SMS/email conversation around the request, and ${photos.length} photo(s) the customer sent (in order).

CONVERSATION:
${threadText(row)}

PHOTO INDEX:
${photoLegend(photos)}

AVAILABLE SERVICE ITEMS (the company's menu — use these exact names):
${itemMenu.join('\n')}

Your tasks:
1. Read each photo: what surface/structure is shown, what symptoms are visible (cracks, water staining, efflorescence, spalling, settling), any water evidence.
2. Group the photos into DISTINCT PHYSICAL AREAS. Photos of the same crack or structure from different angles/distances are ONE area. Different walls, corners, structures, or parts of the property are SEPARATE areas. Use the conversation for location hints.
3. For each area, predict which service item(s) from the menu the company would quote. Only predict work that is evidenced by a visible symptom or an explicit customer request — never infer a repair from the mere presence of a structure.

Respond with ONLY a JSON object:
{
  "photo_reads": [{"photo": 1, "surface": "...", "symptoms": ["..."], "water_evidence": "none|possible|clear", "notes": "..."}],
  "areas": [{"area": "A", "photos": [1,2], "description": "...", "location": "...", "predicted_items": ["..."], "confidence": "high|medium|low"}],
  "customer_asks": ["each distinct repair request from the conversation"],
  "overall_notes": "..."
}`;
}

function joinPrompt(row: ManifestRow, blindJson: string, photos: ManifestRow['photos']): string {
  const lines = row.lines
    .map((l) => `- ${l.item} | qty ${l.qty} @ ${l.unitPrice} = ${l.amount} | ${(l.description ?? '').slice(0, 160)}`)
    .join('\n');
  return `Earlier you analyzed ${photos.length} customer photo(s) for a foundation-repair quote. Your analysis:
${blindJson}

CONVERSATION (again):
${threadText(row)}

Here is the estimate the company ACTUALLY quoted:
${lines}

Your tasks:
1. Map each actual line to the area(s)/photo(s) that support it. Evidence quality per line: "photo" (visible in photos), "text" (requested/described in conversation only), "unsupported" (no visible or textual basis you can find).
2. Note any area from your analysis that got NO line (the company skipped or ruled it out — say why if the conversation shows it).
3. Extract the owner's own analysis language: verbatim quotes from OWNER messages where he interprets photos, explains the problem, or describes the work. These teach how he reads jobs — include each as written.

Respond with ONLY a JSON object:
{
  "line_mapping": [{"item": "...", "areas": ["A"], "photos": [1], "evidence": "photo|text|unsupported", "note": "..."}],
  "unquoted_areas": [{"area": "B", "likely_reason": "..."}],
  "owner_words": ["verbatim quote 1", "..."],
  "lessons": "1-3 sentences: what does this case teach about how this company reads photos into quotes?"
}`;
}

function parseJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`no JSON object in response: ${cleaned.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callWithRetry(gemini: GeminiClient, prompt: string, imageParts: Array<{ mimeType: string; base64: string }>): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await gemini.generateContent(prompt, {
        temperature: 0,
        maxOutputTokens: 8192,
        thinkingBudget: 4096,
        timeoutMs: 120_000,
        imageParts,
      });
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      if (attempt < MAX_RETRIES && (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('timeout') || msg.includes('503'))) {
        console.log(`    retry ${attempt}/${MAX_RETRIES} after error: ${msg.slice(0, 80)}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('unreachable');
}

function normalizeItem(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;
  const onlyEstimate = argv.includes('--estimate') ? argv[argv.indexOf('--estimate') + 1] : undefined;

  const rows: ManifestRow[] = fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // Item vocabulary = every real line item in the corpus (the live menu).
  const itemMenu = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.item)))]
    .filter((i) => !NON_SCOPE_ITEMS.test(i))
    .sort();

  const done = new Set<string>(
    fs.existsSync(EXEMPLARS_PATH)
      ? fs.readFileSync(EXEMPLARS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).estimateId as string)
      : [],
  );

  let targets = rows.filter((r) => r.photos.length > 0 && !done.has(r.estimateId));
  if (onlyEstimate) targets = rows.filter((r) => r.estimateId === onlyEstimate);
  targets = targets.slice(0, limit);

  console.log(
    `${rows.length} manifest rows, ${rows.filter((r) => r.photos.length > 0).length} with photos — ${done.size} structured, processing ${targets.length} (menu: ${itemMenu.length} items)\n`,
  );

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing env: GEMINI_API_KEY');
  const gemini = new GeminiClient({ apiKey, textModel: MODEL });

  let processed = 0;
  let tricky = 0;
  for (const row of targets) {
    const tag = `[${++processed}/${targets.length}] #${row.docNumber} ${row.customerName}`;
    try {
      let photos = row.photos;
      let truncated = false;
      if (photos.length > MAX_PHOTOS_PER_CALL) {
        photos = photos.slice(0, MAX_PHOTOS_PER_CALL);
        truncated = true;
      }
      const imageParts = photos.map((p) => ({
        mimeType: 'image/jpeg',
        base64: fs.readFileSync(smallPathFor(p.file)).toString('base64'),
      }));

      const blindRaw = await callWithRetry(gemini, blindPrompt(row, itemMenu, photos), imageParts);
      const blind = parseJson(blindRaw) as {
        photo_reads?: unknown[];
        areas?: Array<{ predicted_items?: string[] }>;
        customer_asks?: string[];
      };
      await sleep(PACE_MS);

      const joinRaw = await callWithRetry(gemini, joinPrompt(row, JSON.stringify(blind), photos), imageParts);
      const join = parseJson(joinRaw) as Record<string, unknown>;
      await sleep(PACE_MS);

      // Deterministic blind-vs-actual comparison (scope items only).
      const predicted = new Set(
        (blind.areas ?? []).flatMap((a) => a.predicted_items ?? []).map(normalizeItem),
      );
      const actual = new Set(
        row.lines.filter((l) => !NON_SCOPE_ITEMS.test(l.item)).map((l) => normalizeItem(l.item)),
      );
      const missed = [...actual].filter((i) => !predicted.has(i));
      const extra = [...predicted].filter((i) => !actual.has(i));
      const isTricky = missed.length > 0 || extra.length > 0;
      if (isTricky) tricky++;

      const exemplar = {
        estimateId: row.estimateId,
        docNumber: row.docNumber,
        txnDate: row.txnDate,
        status: row.status,
        outcome: row.outcome,
        totalAmt: row.totalAmt,
        customerId: row.customerId,
        customerName: row.customerName,
        photoCount: row.photos.length,
        photosTruncated: truncated || undefined,
        photoFiles: photos.map((p) => p.file),
        blind,
        join,
        match: { missed, extra, tricky: isTricky },
        model: MODEL,
      };
      fs.appendFileSync(EXEMPLARS_PATH, JSON.stringify(exemplar) + '\n');
      const areaCount = (blind.areas ?? []).length;
      console.log(
        `${tag}: ${photos.length} photos → ${areaCount} areas${truncated ? ' (TRUNCATED)' : ''}; ` +
          (isTricky ? `TRICKY (missed: ${missed.join(', ') || '—'}; extra: ${extra.join(', ') || '—'})` : 'match'),
      );
    } catch (err) {
      console.log(`${tag}: ✗ FAILED — ${(err as Error).message.slice(0, 160)} (will retry on next run)`);
    }
  }

  console.log(`\nDone. ${processed} structured this run, ${tricky} tricky.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
