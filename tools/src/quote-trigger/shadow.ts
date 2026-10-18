#!/usr/bin/env npx tsx
/**
 * Quote-trigger runner (photo-quote-training Phase 6).
 *
 * Drains the middleware-fed trigger queue (keys.quoteTriggerQueue), applies
 * debounce + trigger classification (T1 photo-burst, T3 quote-promised),
 * runs the drafter for triggered customers, and logs the gate verdict.
 * Runs every 10 min via launchd (com.aac.quote-shadow) — the schedule is
 * the executor, the queue events are the trigger.
 *
 * Modes (owner go-live 2026-10-18):
 *   default        — LIVE: creates bot-marked Pending QBO drafts.
 *                    CREATE-ONCE-ONLY: the drafter's idempotency skips any
 *                    customer with a bot draft already pending, and the
 *                    runner never updates an existing estimate — so it can
 *                    never step on owner edits. Nothing is ever sent.
 *   --shadow       — dry-run, log-only (the original shadow mode).
 *
 * State: analysis/data/quote-trigger/pending.json (per-phone event buffer,
 * survives across runs for debounce), shadow-log.jsonl (the record the
 * 2-3 week shadow review reads).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';

const STATE_DIR = 'analysis/data/quote-trigger';
const PENDING_PATH = path.join(STATE_DIR, 'pending.json');
const LOG_PATH = path.join(STATE_DIR, 'shadow-log.jsonl');
const DEBOUNCE_MS = 15 * 60 * 1000;
/** Internal numbers that must never trigger a customer quote analysis. */
const INTERNAL = new Set(['+18573126761', '+16177660151', '+16176681677']);
const QUOTE_PROMISE_RE =
  /\b(quote|estimate|price|write (it|that|this) up|get (that|you|a) (quote|estimate|price|number))\b/i;
/** Injection-family items — the high-confidence gate stratum. */
const INJECTION_ITEMS = new Set([
  'crack repair', 'crack repair e', 'cold joint', 'window injection', 'spot injection',
  'bulkhead injection', 'tie hole injections', 'sewer inlet injection', 'water line injection',
  'conduit injection', 'fieldstone injection', 'decomissioned penetration injection',
]);
const NON_SCOPE = /guarantee|discount|deposit|warranty/i;

interface TriggerEvent {
  phone: string;
  direction: 'incoming' | 'outgoing';
  at: string;
  hasMedia: boolean;
  snippet: string;
}

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

function classify(events: TriggerEvent[]): { trigger: 'T1' | 'T3'; why: string } | null {
  const inboundMedia = events.filter((e) => e.direction === 'incoming' && e.hasMedia);
  if (inboundMedia.length) {
    return { trigger: 'T1', why: `${inboundMedia.length} inbound photo message(s)` };
  }
  const promise = events.find((e) => e.direction === 'outgoing' && QUOTE_PROMISE_RE.test(e.snippet));
  if (promise) {
    return { trigger: 'T3', why: `outbound quote promise: "${promise.snippet.slice(0, 80)}"` };
  }
  return null;
}

/** Cap live drafts per run — a backlog flood should trickle, not burst. */
const MAX_DRAFTS_PER_RUN = 5;

async function main(): Promise<void> {
  loadEnv();
  const shadow = process.argv.includes('--shadow');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });

  // ── drain queue into per-phone pending state ──────────────────────────
  const pending: Record<string, TriggerEvent[]> = fs.existsSync(PENDING_PATH)
    ? JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'))
    : {};
  let drained = 0;
  for (;;) {
    const raw = await redis.rpop<string | TriggerEvent>(keys.quoteTriggerQueue);
    if (raw === null || raw === undefined) break;
    const ev: TriggerEvent = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (INTERNAL.has(ev.phone)) continue;
    (pending[ev.phone] ??= []).push(ev);
    drained++;
    if (drained >= 500) break; // safety valve per run
  }

  // ── evaluate each phone: debounce → classify → shadow-draft ──────────
  const now = Date.now();
  const log = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  let acted = 0;
  for (const [phone, events] of Object.entries(pending)) {
    const newest = Math.max(...events.map((e) => new Date(e.at).getTime()));
    if (now - newest < DEBOUNCE_MS) continue; // still settling — next run
    delete pending[phone]; // consumed either way below

    const verdict = classify(events);
    if (!verdict) {
      log.write(JSON.stringify({ at: new Date().toISOString(), phone, outcome: 'no-trigger', events: events.length }) + '\n');
      continue;
    }

    if (acted >= MAX_DRAFTS_PER_RUN) {
      // leave the rest pending for the next run (10 min away)
      pending[phone] = events;
      continue;
    }
    acted++;
    console.log(`→ ${phone}: ${verdict.trigger} (${verdict.why}) — ${shadow ? 'shadow' : 'LIVE'} drafting`);
    const findingsPath = path.join(STATE_DIR, `finding-${phone.replace(/\D/g, '')}.json`);
    fs.writeFileSync(findingsPath, JSON.stringify({
      findings: [{ section: 'quote_promised', customer: null, phone, title: `TRIGGER ${verdict.trigger}: ${verdict.why}` }],
    }));
    let output = '';
    let failed = false;
    try {
      const args = ['tsx', 'tools/src/drafter/run.ts', '--phone', phone, '--findings', findingsPath, '--skip-if-recent-estimate', '30'];
      if (shadow) args.splice(2, 0, '--dry-run');
      output = execFileSync('npx', args, {
        encoding: 'utf8',
        timeout: 420_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      failed = true;
      output = String((err as { stdout?: string }).stdout ?? err).slice(0, 4000);
    }
    fs.rmSync(findingsPath, { force: true });

    // parse the dry-run output for the shadow record
    const draftLine = output.match(/draft: \$(\d[\d,]*) \((\w+)\)/);
    const items = [...output.matchAll(/^\s{4}(.+?) \[/gm)].map((m) => m[1].toLowerCase().trim());
    const scopeItems = items.filter((i) => !NON_SCOPE.test(i));
    const simpleInjection = scopeItems.length > 0 && scopeItems.length <= 2 && scopeItems.every((i) => INJECTION_ITEMS.has(i));
    const needsVisit = /needs?[_ ]site[_ ]visit|site visit recommended/i.test(output);
    const confidence = draftLine?.[2] ?? null;
    const wouldAutoCreate = !failed && simpleInjection && confidence === 'high' && !needsVisit;
    const createdDoc = output.match(/(?:created|regenerated) Pending estimate #(\S+)/)?.[1] ?? null;
    const regenerated = /regenerated Pending estimate #/.test(output);
    const skipped = /~ skipped:/.test(output);

    log.write(JSON.stringify({
      at: new Date().toISOString(),
      mode: shadow ? 'shadow' : 'live',
      phone,
      trigger: verdict.trigger,
      why: verdict.why,
      events: events.length,
      createdDoc,
      outcome: failed ? 'draft-failed' : regenerated ? 'updated' : createdDoc ? 'created' : skipped ? 'skipped' : 'drafted',
      total: draftLine ? Number(draftLine[1].replace(/,/g, '')) : null,
      confidence,
      scopeItems,
      gate: { simpleInjection, needsVisit, wouldAutoCreate, label: wouldAutoCreate ? 'HIGH-CONFIDENCE' : 'COMPLEX/REVIEW' },
      outputTail: output.split('\n').slice(-25).join('\n'),
    }) + '\n');
    console.log(`  gate: ${wouldAutoCreate ? 'WOULD AUTO-CREATE' : 'review-label'} (${scopeItems.join(', ') || 'no scope'})`);
  }
  log.end();

  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 1));
  console.log(`drained ${drained} event(s); ${Object.keys(pending).length} phone(s) still settling; ${acted} shadow draft(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
