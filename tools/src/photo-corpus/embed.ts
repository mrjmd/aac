#!/usr/bin/env npx tsx
/**
 * Exemplar embedding — Phase 3 of the photo→quote training layer.
 *
 * Builds the retrieval library: one entry per (exemplar, area) with a
 * situation text (what the drafter would know at runtime: area description,
 * location, symptoms) embedded via Gemini, plus the answer payload (items
 * actually quoted for that area, prices, date, owner words). Retrieval is
 * brute-force cosine in-process (@aac/quoting retrieval.ts).
 *
 * Usage: npx tsx tools/src/photo-corpus/embed.ts
 * Output: analysis/data/photo-corpus/exemplar-library.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';

const OUT_DIR = 'analysis/data/photo-corpus';
const EXEMPLARS_PATH = path.join(OUT_DIR, 'exemplars.jsonl');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.jsonl');
const LIBRARY_PATH = path.join(OUT_DIR, 'exemplar-library.jsonl');
const EMBED_MODEL = 'gemini-embedding-001';

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

interface AreaEntry {
  id: string; // estimateId:area
  estimateId: string;
  docNumber: string;
  txnDate: string;
  outcome?: string;
  customerName: string;
  area: string;
  situation: string;
  photoFiles: string[];
  quotedItems: Array<{ item: string; unitPrice: number; qty: number }>;
  unquoted?: string; // likely_reason when the area got no line
  ownerWords: string[];
  lesson?: string;
  embedModel: string;
  vector: number[];
}

async function main(): Promise<void> {
  loadEnv();
  const argvIn = process.argv.indexOf('--in');
  const exemplarsPath = argvIn >= 0 ? process.argv[argvIn + 1] : EXEMPLARS_PATH;
  const exemplars = fs.readFileSync(exemplarsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const man = new Map(
    fs.readFileSync(MANIFEST_PATH, 'utf8').split('\n').filter(Boolean).map((l) => {
      const m = JSON.parse(l);
      return [m.estimateId as string, m] as const;
    }),
  );

  const entries: Omit<AreaEntry, 'vector'>[] = [];
  for (const ex of exemplars) {
    const m = man.get(ex.estimateId);
    if (!m) continue;
    const lineByItem = new Map<string, { item: string; unitPrice: number; qty: number }>(
      m.lines.map((l: { item: string; unitPrice: number; qty: number }) => [
        l.item.toLowerCase(),
        { item: l.item, unitPrice: l.unitPrice, qty: l.qty },
      ]),
    );
    const mappings: Array<{ item: string; areas?: string[] }> = ex.join?.line_mapping ?? [];
    const unquotedByArea = new Map<string, string>(
      (ex.join?.unquoted_areas ?? []).map((u: { area: string; likely_reason?: string }) => [
        u.area,
        u.likely_reason ?? 'not quoted',
      ]),
    );
    const photoFilesByIndex: string[] = ex.photoFiles ?? [];
    for (const a of ex.blind?.areas ?? []) {
      const areaId = String(a.area);
      const symptoms = (ex.blind?.photo_reads ?? [])
        .filter((p: { photo: number }) => (a.photos ?? []).includes(p.photo))
        .flatMap((p: { symptoms?: string[] }) => p.symptoms ?? []);
      const situation = [
        a.description,
        a.location ? `Location: ${a.location}.` : '',
        symptoms.length ? `Symptoms: ${[...new Set(symptoms)].join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      // The join pass sometimes echoes the whole rendered line ("Crack
      // Repair | qty 1 @ 575 = …") as `item` — match on the leading item
      // name instead of exact equality.
      const resolveLine = (raw: string) => {
        const head = raw.split('|')[0].trim().toLowerCase();
        return (
          lineByItem.get(head) ??
          [...lineByItem.values()].find((l) => head.startsWith(l.item.toLowerCase()))
        );
      };
      const quoted = mappings
        .filter((mp) => (mp.areas ?? []).includes(areaId))
        .map((mp) => resolveLine(mp.item))
        .filter((x): x is { item: string; unitPrice: number; qty: number } => !!x);
      entries.push({
        id: `${ex.estimateId}:${areaId}`,
        estimateId: ex.estimateId,
        docNumber: ex.docNumber,
        txnDate: ex.txnDate,
        outcome: ex.outcome,
        customerName: ex.customerName,
        area: areaId,
        situation,
        photoFiles: (a.photos ?? []).map((i: number) => photoFilesByIndex[i - 1]).filter(Boolean),
        quotedItems: quoted,
        unquoted: quoted.length === 0 ? unquotedByArea.get(areaId) ?? 'no line mapped' : undefined,
        ownerWords: (ex.join?.owner_words ?? []).slice(0, 4),
        lesson: ex.join?.lessons,
        embedModel: EMBED_MODEL,
      });
    }
  }
  console.log(`${entries.length} area exemplars to embed`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing env: GEMINI_API_KEY');
  const gemini = new GeminiClient({ apiKey });
  const vectors = await gemini.embedContent(entries.map((e) => e.situation), {
    model: EMBED_MODEL,
    timeoutMs: 120_000,
  });

  const argvOut = process.argv.indexOf('--out');
  const libraryOut = argvOut >= 0 ? process.argv[argvOut + 1] : LIBRARY_PATH;
  const out = entries.map((e, i) => ({ ...e, vector: vectors[i] }));
  fs.writeFileSync(libraryOut, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`Wrote ${out.length} entries (${vectors[0]?.length ?? 0} dims) → ${libraryOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
