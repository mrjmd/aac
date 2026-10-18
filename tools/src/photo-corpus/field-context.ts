#!/usr/bin/env npx tsx
/**
 * Field-context attribution: joins each corpus estimate to the Matt↔Mike
 * channel (texts + call transcripts) and the ops calendar, then LLM-extracts
 * the field findings relevant to that customer's quote.
 *
 * This implements the owner's process rule (owner-notes.jsonl, 2026-10-18):
 * quotes not derivable from photos+customer thread came from an assessment —
 * calendar event + employee debrief. Output feeds the JOIN re-structuring
 * pass and the post-assessment drafting mode.
 *
 * Inputs (all under analysis/data/photo-corpus/):
 *   manifest.jsonl, mike-thread.jsonl, mike-call-transcripts.jsonl,
 *   calendar-events.jsonl
 * Output: field-context.jsonl — {estimateId, docNumber, events, texts,
 *   calls, findings, relevant}
 *
 * Resumable: skips estimateIds already present in the output file.
 * Usage: npx tsx tools/src/photo-corpus/field-context.ts [--limit N]
 *   [--blind]           omit the actual quote lines from the extraction
 *                       prompt — REQUIRED for holdout-eval inputs (the
 *                       default prompt sees the labels; feeding that into
 *                       an eval would leak)
 *   [--only holdout.json] restrict to those estimateIds
 *   [--out file.jsonl]    alternate output (default field-context.jsonl)
 */
import fs from 'node:fs';
import path from 'node:path';
import { GeminiClient } from '@aac/api-clients/gemini';

const OUT_DIR = 'analysis/data/photo-corpus';
const OUT_PATH = path.join(OUT_DIR, 'field-context.jsonl');
const MODEL = 'gemini-3.6-flash';
const WINDOW_BEFORE_DAYS = 45;
const WINDOW_AFTER_DAYS = 3;
const DAY = 86_400_000;
/** Debrief window around a matched calendar visit: same day or day after. */
const DEBRIEF_AFTER_DAYS = 2;
const MAX_TRANSCRIPT_CHARS = 9_000;
const MAX_CONTEXT_CALLS = 6;

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
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readJsonl(file: string): any[] {
  const p = path.join(OUT_DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Name tokens: last name weighted — a last-name hit is a match on its own;
 *  a first-name hit only counts alongside temporal proximity to a visit. */
function nameTokens(customerName: string): { last: string[]; first: string[] } {
  const words = String(customerName).toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  if (words.length <= 1) return { last: words, first: [] };
  return { last: [words[words.length - 1]], first: words.slice(0, -1) };
}

const eventStartMs = (e: any): number => {
  const s = e.start?.dateTime ?? e.start?.date ?? e.start;
  return new Date(typeof s === 'string' ? s : '').getTime();
};

async function main(): Promise<void> {
  loadEnv();
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const blind = process.argv.includes('--blind');
  const onlyArg = process.argv.indexOf('--only');
  const onlyIds: Set<string> | null = onlyArg >= 0
    ? new Set(JSON.parse(fs.readFileSync(process.argv[onlyArg + 1], 'utf8')).holdoutEstimateIds)
    : null;
  const outArg = process.argv.indexOf('--out');
  const outPath = outArg >= 0 ? path.join(OUT_DIR, process.argv[outArg + 1]) : OUT_PATH;

  const gemini = new GeminiClient({ apiKey: requireEnv('GEMINI_API_KEY') });
  const manifest = readJsonl('manifest.jsonl');
  const mikeTexts = readJsonl('mike-thread.jsonl');
  const transcripts = readJsonl('mike-call-transcripts.jsonl').filter((t) => t.hasTranscript);
  const events = readJsonl('calendar-events.jsonl');
  const done = new Set(readJsonl(path.basename(outPath)).map((r) => r.estimateId));
  console.log(`manifest ${manifest.length} | mike texts ${mikeTexts.length} | transcripts ${transcripts.length} | events ${events.length} | done ${done.size}${blind ? ' | BLIND (labels hidden)' : ''}`);

  const out = fs.createWriteStream(outPath, { flags: 'a' });
  let processed = 0;
  let relevant = 0;

  for (const est of manifest) {
    if (onlyIds && !onlyIds.has(est.estimateId)) continue;
    if (done.has(est.estimateId)) continue;
    if (processed >= limit) break;

    const t = new Date(est.txnDate + 'T12:00:00Z').getTime();
    const lo = t - WINDOW_BEFORE_DAYS * DAY;
    const hi = t + WINDOW_AFTER_DAYS * DAY;
    const inWindow = (at?: string) => {
      if (!at) return false;
      const x = new Date(at).getTime();
      return x >= lo && x <= hi;
    };
    const { last, first } = nameTokens(est.customerName ?? '');
    const hasLast = (s: string) => last.some((tok) => s.toLowerCase().includes(tok));
    const hasFirst = (s: string) => first.some((tok) => s.toLowerCase().includes(tok));

    // 1. calendar events for this customer in window (last-name match)
    const custEvents = events.filter((e) => {
      const x = eventStartMs(e);
      if (!(x >= lo && x <= hi)) return false;
      const hay = `${e.summary} ${e.location ?? ''} ${e.description ?? ''}`;
      return hasLast(hay) || (hasFirst(hay) && String(e.colorId) === '3');
    });
    const visitTimes = custEvents.map(eventStartMs);
    const nearVisit = (at?: string) => {
      if (!at) return false;
      const x = new Date(at).getTime();
      return visitTimes.some((v) => x >= v - 0.5 * DAY && x <= v + DEBRIEF_AFTER_DAYS * DAY);
    };

    // 2. Mike texts: name mention in window, or any text near a visit
    const texts = mikeTexts.filter((m) => {
      if (!inWindow(m.createdAt)) return false;
      const txt = m.text ?? '';
      return hasLast(txt) || hasFirst(txt) || nearVisit(m.createdAt);
    });

    // 3. calls: transcript mentions name in window, or call near a visit
    const calls = transcripts
      .filter((c) => {
        if (!inWindow(c.at)) return false;
        const joined = (c.dialogue ?? []).map((d: any) => d.content).join(' ');
        return hasLast(joined) || nearVisit(c.at);
      })
      .slice(0, MAX_CONTEXT_CALLS);

    if (!custEvents.length && !texts.length && !calls.length) {
      out.write(JSON.stringify({
        estimateId: est.estimateId, docNumber: est.docNumber,
        events: [], texts: [], calls: [], relevant: false, findings: null,
      }) + '\n');
      processed++;
      continue;
    }

    // 4. LLM extraction of quote-relevant field findings
    const evidence: string[] = [];
    for (const e of custEvents) {
      evidence.push(`CALENDAR [${String(e.colorId) === '3' ? 'ASSESSMENT' : String(e.colorId) === '10' ? 'JOB' : 'event'}] ${new Date(eventStartMs(e)).toISOString().slice(0, 10)}: ${e.summary}${e.location ? ` @ ${e.location}` : ''}`);
    }
    for (const m of texts.slice(0, 40)) {
      evidence.push(`TEXT ${String(m.createdAt).slice(0, 10)} ${m.direction === 'outgoing' ? 'MATT' : 'MIKE'}: ${(m.text ?? '').slice(0, 300)}`);
    }
    for (const c of calls) {
      const lines = (c.dialogue ?? []).map((d: any) =>
        `${d.identifier === '+18573126761' ? 'MIKE' : 'MATT'}: ${d.content}`);
      let joined = lines.join('\n');
      if (joined.length > MAX_TRANSCRIPT_CHARS) {
        // keep segments around name mentions, else head+tail
        const idx = last.length ? joined.toLowerCase().indexOf(last[0]) : -1;
        joined = idx >= 0
          ? joined.slice(Math.max(0, idx - MAX_TRANSCRIPT_CHARS / 2), idx + MAX_TRANSCRIPT_CHARS / 2)
          : joined.slice(0, MAX_TRANSCRIPT_CHARS / 2) + '\n…\n' + joined.slice(-MAX_TRANSCRIPT_CHARS / 2);
      }
      evidence.push(`CALL ${String(c.at).slice(0, 10)} (${Math.round((c.duration ?? 0) / 60)}min):\n${joined}`);
    }

    const prompt = `You are extracting technician field findings for a foundation-repair quote.

CUSTOMER: ${est.customerName}
QUOTE DATE: ${est.txnDate}
${blind ? '' : `QUOTE LINES (what was actually quoted): ${(est.lines ?? []).map((l: any) => `${l.item} ×${l.qty}`).join('; ')}\n`}

Below are calendar events and Matt↔Mike (owner↔technician) texts/call-transcript excerpts from the weeks before the quote. Mike visits sites and reports back; Matt writes the quotes. Much of this traffic is about OTHER customers — only extract what is about ${est.customerName} (or clearly about their job/address).

Return strict JSON:
{"relevant": boolean, "findings": string|null, "quotes": string[]}
- relevant: true only if any evidence is clearly about this customer's job
- findings: 1-4 sentences — what the field visit/debrief established that the photos+customer thread alone would not show (scope, measurements, access, water sources, what Mike recommended)
- quotes: up to 3 short verbatim lines from Mike or Matt about this job

EVIDENCE:
${evidence.join('\n\n')}`;

    let parsed: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const text = await gemini.generateContent(prompt, {
          model: MODEL, temperature: 0, maxOutputTokens: 8192,
          thinkingBudget: 4096, timeoutMs: 120_000,
        });
        const m = text.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : null;
        break;
      } catch (err) {
        const msg = String(err);
        if (attempt === 3) { console.error(`  #${est.docNumber}: extraction failed: ${msg.slice(0, 120)}`); break; }
        await sleep(/429/.test(msg) ? 65_000 : 5_000 * attempt);
      }
    }

    out.write(JSON.stringify({
      estimateId: est.estimateId,
      docNumber: est.docNumber,
      events: custEvents.map((e) => ({ id: e.id, summary: e.summary, colorId: e.colorId, at: new Date(eventStartMs(e)).toISOString().slice(0, 10) })),
      texts: texts.slice(0, 40).map((m) => ({ at: m.createdAt, direction: m.direction, text: (m.text ?? '').slice(0, 300) })),
      calls: calls.map((c) => ({ callId: c.callId, at: c.at, duration: c.duration })),
      relevant: parsed?.relevant === true,
      findings: parsed?.relevant === true ? (parsed.findings ?? null) : null,
      mikeQuotes: parsed?.relevant === true ? (parsed.quotes ?? []) : [],
    }) + '\n');
    processed++;
    if (parsed?.relevant === true) relevant++;
    if (processed % 20 === 0) console.log(`progress: ${processed} processed, ${relevant} relevant`);
  }
  out.end();
  console.log(`\ndone: ${processed} processed this run, ${relevant} with relevant field context`);
}

main().catch((err) => { console.error(err); process.exit(1); });
