#!/usr/bin/env npx tsx
/**
 * Enriched re-JOIN: re-runs the structure.ts JOIN pass for corpus cases that
 * gained field context (Mike debrief findings and/or attributed technician
 * photos), producing exemplars-v2.jsonl.
 *
 * The blind pass is NOT re-run — it is deliberately contextless (the
 * "before" photo and the embedding source). Only the join (line↔evidence
 * mapping) is upgraded: a new evidence class "field" covers lines that the
 * technician visit/debrief established.
 *
 * Inputs: exemplars.jsonl, manifest.jsonl, field-context.jsonl,
 *   mike-photo-attribution.jsonl, photos-mike-small/
 * Work file (resumable): exemplars-field-work.jsonl
 * Final output (merge step): exemplars-v2.jsonl — ALL rows, enriched ones
 *   replaced and tagged joinVersion: 2 + assessmentSourced flag.
 *
 * Usage: npx tsx tools/src/photo-corpus/restructure-field.ts [--limit N] [--merge-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';

const OUT_DIR = 'analysis/data/photo-corpus';
const WORK_PATH = path.join(OUT_DIR, 'exemplars-field-work.jsonl');
const V2_PATH = path.join(OUT_DIR, 'exemplars-v2.jsonl');
const SMALL_DIR = path.join(OUT_DIR, 'photos-small');
const MIKE_SMALL_DIR = path.join(OUT_DIR, 'photos-mike-small');
const MODEL = 'gemini-3.6-flash';
const MAX_PHOTOS_PER_CALL = 12;
const MAX_MIKE_PHOTOS = 6;
const MAX_RETRIES = 3;

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

function readJsonl(p: string): any[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function smallPathFor(dir: string, file: string): string {
  // customer photos: "photos/<custId>/<name>.<ext>" → "<custId>__<name>.jpg"
  // (same mapping as structure.ts); Mike photos are flat filenames.
  const stem = file.replace('photos/', '').replace('/', '__');
  return path.join(dir, stem.replace(/\.[a-zA-Z0-9]+$/, '') + '.jpg');
}

function threadText(row: any): string {
  return (row.thread ?? [])
    .map((m: any) => `${m.direction === 'outgoing' ? 'OWNER' : 'CUSTOMER'} ${String(m.at).slice(0, 10)}: ${m.text}`)
    .join('\n');
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
      if (attempt < MAX_RETRIES && /429|RESOURCE_EXHAUSTED|timeout|503/.test(msg)) {
        await sleep(/429/.test(msg) ? 65_000 : 5_000 * attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('unreachable');
}

function enrichedJoinPrompt(row: any, blindJson: string, custPhotoCount: number, mikePhotos: any[], ctx: any): string {
  const lines = (row.lines ?? [])
    .map((l: any) => `- ${l.item} | qty ${l.qty} @ ${l.unitPrice} = ${l.amount} | ${(l.description ?? '').slice(0, 160)}`)
    .join('\n');
  const mikeLegend = mikePhotos.length
    ? `\nTECHNICIAN PHOTOS (sent by the technician Mike after visiting the site — numbered T1..T${mikePhotos.length}, appended after the customer photos):\n` +
      mikePhotos.map((p, i) => `T${i + 1}: sent ${String(p.at).slice(0, 10)}${p.withText ? ` with text "${p.withText}"` : ''}${p.ambiguousWith?.length ? ' [ATTRIBUTION UNCERTAIN — may be another customer\'s site]' : ''}`).join('\n')
    : '';
  const fieldBlock = ctx?.findings
    ? `\nFIELD DEBRIEF (extracted from owner↔technician texts/calls about this job):\n${ctx.findings}\n` +
      (ctx.mikeQuotes?.length ? `Verbatim: ${ctx.mikeQuotes.map((q: string) => `"${q}"`).join(' | ')}\n` : '')
    : '';
  return `Earlier you analyzed ${custPhotoCount} customer photo(s) for a foundation-repair quote. Your analysis:
${blindJson}

CONVERSATION (owner↔customer):
${threadText(row)}
${fieldBlock}${mikeLegend}

Here is the estimate the company ACTUALLY quoted:
${lines}

Your tasks:
1. Map each actual line to its supporting evidence. Evidence quality per line: "photo" (visible in CUSTOMER photos), "field" (established by the technician's visit — the debrief or technician photos show it, the customer photos alone do not), "text" (requested/described in the customer conversation only), "unsupported" (no basis found anywhere).
2. Note any area from your analysis that got NO line (skipped or ruled out — say why if the conversation or debrief shows it).
3. Extract the owner's own analysis language: verbatim quotes from OWNER messages interpreting photos or explaining the work.
4. field_findings_used: 1-2 sentences — what did the visit/debrief add that changed or completed the scope beyond the customer photos? (null if nothing)

Respond with ONLY a JSON object:
{
  "line_mapping": [{"item": "...", "areas": ["A"], "photos": [1], "evidence": "photo|field|text|unsupported", "note": "..."}],
  "unquoted_areas": [{"area": "B", "likely_reason": "..."}],
  "owner_words": ["verbatim quote 1"],
  "field_findings_used": "...",
  "lessons": "1-3 sentences: what does this case teach about how this company reads photos into quotes?"
}`;
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;
  const mergeOnly = argv.includes('--merge-only');

  const exemplars = readJsonl(path.join(OUT_DIR, 'exemplars.jsonl'));
  const manifest = new Map(readJsonl(path.join(OUT_DIR, 'manifest.jsonl')).map((r) => [r.estimateId, r]));
  const fieldCtx = new Map(
    readJsonl(path.join(OUT_DIR, 'field-context.jsonl')).filter((r) => r.relevant).map((r) => [r.estimateId, r]),
  );
  const mikePhotos = new Map(
    readJsonl(path.join(OUT_DIR, 'mike-photo-attribution.jsonl')).map((r) => [r.estimateId, r.photos]),
  );

  const affected = exemplars.filter((e) => fieldCtx.has(e.estimateId) || mikePhotos.has(e.estimateId));
  const done = new Set(readJsonl(WORK_PATH).map((r) => r.estimateId));
  console.log(`exemplars ${exemplars.length} | affected ${affected.length} (${fieldCtx.size} w/ debrief, ${mikePhotos.size} w/ Mike photos) | done ${done.size}`);

  if (!mergeOnly) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Missing env: GEMINI_API_KEY');
    const gemini = new GeminiClient({ apiKey, textModel: MODEL });
    const out = fs.createWriteStream(WORK_PATH, { flags: 'a' });
    let processed = 0;

    for (const ex of affected) {
      if (done.has(ex.estimateId)) continue;
      if (processed >= limit) break;
      const row = manifest.get(ex.estimateId);
      if (!row) continue;
      const tag = `[${++processed}/${affected.length - done.size}] #${ex.docNumber}`;
      try {
        const custPhotos = (row.photos ?? []).slice(0, MAX_PHOTOS_PER_CALL);
        // technician photos: unambiguous first, cap at MAX_MIKE_PHOTOS
        const mp = (mikePhotos.get(ex.estimateId) ?? [])
          .sort((a: any, b: any) => (a.ambiguousWith?.length ?? 0) - (b.ambiguousWith?.length ?? 0))
          .slice(0, MAX_MIKE_PHOTOS)
          .filter((p: any) => fs.existsSync(smallPathFor(MIKE_SMALL_DIR, p.file)));
        const imageParts = [
          ...custPhotos.map((p: any) => ({
            mimeType: 'image/jpeg',
            base64: fs.readFileSync(smallPathFor(SMALL_DIR, p.file)).toString('base64'),
          })),
          ...mp.map((p: any) => ({
            mimeType: 'image/jpeg',
            base64: fs.readFileSync(smallPathFor(MIKE_SMALL_DIR, p.file)).toString('base64'),
          })),
        ];
        const ctx = fieldCtx.get(ex.estimateId);
        const joinRaw = await callWithRetry(
          gemini,
          enrichedJoinPrompt(row, JSON.stringify(ex.blind), custPhotos.length, mp, ctx),
          imageParts,
        );
        const join = parseJson(joinRaw);
        out.write(JSON.stringify({
          estimateId: ex.estimateId,
          join,
          fieldContext: ctx ? { findings: ctx.findings, mikeQuotes: ctx.mikeQuotes, events: ctx.events } : null,
          mikePhotoFiles: mp.map((p: any) => p.file),
        }) + '\n');
        console.log(`${tag} ok (${mp.length} tech photos, debrief: ${ctx ? 'yes' : 'no'})`);
      } catch (err) {
        console.error(`${tag} FAILED: ${String(err).slice(0, 140)}`);
      }
    }
    out.end();
  }

  // ── merge ────────────────────────────────────────────────────────────
  const work = new Map(readJsonl(WORK_PATH).map((r) => [r.estimateId, r]));
  const merged = exemplars.map((ex) => {
    const w = work.get(ex.estimateId);
    const assessmentSourced = fieldCtx.has(ex.estimateId) || mikePhotos.has(ex.estimateId);
    if (!w) return { ...ex, assessmentSourced, joinVersion: 1 };
    return {
      ...ex,
      join: w.join,
      fieldContext: w.fieldContext,
      mikePhotoFiles: w.mikePhotoFiles,
      assessmentSourced,
      joinVersion: 2,
    };
  });
  fs.writeFileSync(V2_PATH, merged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const v2count = merged.filter((r) => r.joinVersion === 2).length;
  console.log(`\nexemplars-v2.jsonl written: ${merged.length} rows, ${v2count} enriched (joinVersion 2), ${merged.filter((r) => r.assessmentSourced).length} assessment-sourced`);
}

main().catch((err) => { console.error(err); process.exit(1); });
