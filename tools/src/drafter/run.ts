#!/usr/bin/env npx tsx
/**
 * Quote drafter v1 — bot-marked Pending estimates in QBO.
 *
 * For each `quote_promised` finding in the latest triage run, assemble
 * the Quo thread + MMS photos, draft estimate lines with Gemini against
 * the canonical pricing ruleset (SECTION 0), and create a Pending
 * estimate in QBO. Nothing customer-facing: the estimate is never sent,
 * carries a "BOT DRAFT — REVIEW BEFORE SENDING" top line, and a
 * PrivateNote with reasoning + recent comparables.
 *
 * Usage (from repo root, after a triage refresh):
 *   npx tsx tools/src/drafter/run.ts              # draft all quote_promised findings
 *   npx tsx tools/src/drafter/run.ts --dry-run    # print drafts, create nothing
 *   npx tsx tools/src/drafter/run.ts --phone +1617...   # one thread only
 *
 * Drafting logic lives in @aac/quoting (draft-quote.ts); this script is
 * orchestration + I/O only. See docs/projects/quote-drafter.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient, type QBEstimate } from '@aac/api-clients/quickbooks';
import { QuoClient } from '@aac/api-clients/quo';
import { GeminiClient } from '@aac/api-clients/gemini';
import { keys, ttl } from '@aac/shared-utils/redis';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import {
  assembleEstimateLines,
  buildAreaAnalysisPrompt,
  buildDescriptionLibrary,
  buildDraftPrivateNote,
  buildQuoteDraftPrompt,
  areaSituationText,
  draftTotal,
  formatPhotoContext,
  isBotDraft,
  parseAreaAnalysis,
  parseQuoteDraftResponse,
  retrieveSimilar,
  selectComparables,
  validateQuoteDraft,
  type DraftThreadMessage,
  type ExemplarLibraryEntry,
} from '@aac/quoting';
import type { Finding, FindingsFile } from '../triage/analyze.ts';
import type { Snapshot } from '../triage/collect.ts';

// ── config ───────────────────────────────────────────────────────────

const FINDINGS_PATH = 'analysis/data/triage/findings.json';
const SNAPSHOT_PATH = 'analysis/data/triage/snapshot.json';
const RULESET_PATH = 'analysis/data/quoting-spike/llm-ruleset.md';
const RUNLOG_PATH = 'analysis/data/triage/drafts.json';
// Photo→quote training layer (Phase 4) — both optional; the drafter
// degrades to v1 behavior when they're absent.
const SECTION_V_PATH = 'analysis/data/photo-corpus/section-v-draft.md';
const EXEMPLAR_LIBRARY_PATH = 'analysis/data/photo-corpus/exemplar-library.jsonl';
const EXEMPLARS_PER_AREA = 3;
const MAX_PHOTOS = 6;
const MAX_THREAD_MESSAGES = 100;

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

// ── main ─────────────────────────────────────────────────────────────

interface DraftRunRecord {
  phone: string;
  customer: string;
  outcome: 'created' | 'dry-run' | 'skipped' | 'failed';
  detail: string;
  estimateId?: string;
  docNumber?: string;
  total?: number;
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const phoneArg = argv.includes('--phone') ? argv[argv.indexOf('--phone') + 1] : undefined;

  const findingsFile = JSON.parse(fs.readFileSync(FINDINGS_PATH, 'utf8')) as FindingsFile;
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  const rulesetText = fs.readFileSync(RULESET_PATH, 'utf8');

  let targets = findingsFile.findings.filter(
    (f): f is Finding & { phone: string } => f.section === 'quote_promised' && !!f.phone,
  );
  if (phoneArg) targets = targets.filter((f) => f.phone === phoneArg);

  const skippedNoPhone = findingsFile.findings.filter(
    (f) => f.section === 'quote_promised' && !f.phone,
  );
  for (const f of skippedNoPhone) {
    console.log(`~ skipping (no phone — email-only thread): ${f.title}`);
  }

  if (targets.length === 0) {
    console.log('No quote_promised findings with a phone number. Nothing to draft.');
    return;
  }
  console.log(`${targets.length} quote_promised finding(s)${dryRun ? ' [DRY RUN]' : ''}\n`);

  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const qb = new QuickBooksClient({
    clientId: requireEnv('QUICKBOOKS_CLIENT_ID'),
    clientSecret: requireEnv('QUICKBOOKS_CLIENT_SECRET'),
    realmId: requireEnv('QUICKBOOKS_REALM_ID'),
    redirectUri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    getTokens: async () => (await redis.get<QBOAuthTokens>(keys.qbOAuthTokens)) ?? null,
    saveTokens: async (tokens) => {
      await redis.set(keys.qbOAuthTokens, tokens);
    },
    refreshLock: {
      acquire: async () =>
        (await redis.set(keys.qbRefreshLock, Date.now(), { nx: true, px: ttl.qbRefreshLock * 1000 })) === 'OK',
      release: async () => {
        await redis.del(keys.qbRefreshLock);
      },
    },
  });
  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
  });
  const gemini = new GeminiClient({
    apiKey: requireEnv('GEMINI_API_KEY'),
    textModel: 'gemini-3.6-flash',
  });

  // One fetch for the run: item menu + recent estimates (newest-first)
  // feed the description library and comparables for every draft.
  const items = await qb.listItems();
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const recentEstimates = await qb.listRecentEstimates(yearAgo);
  const library = buildDescriptionLibrary(recentEstimates);
  const itemNames = items.map((i) => i.Name);
  console.log(`QBO: ${items.length} items, ${recentEstimates.length} recent estimates, ${library.size} canonical descriptions\n`);

  // AAC's QBO uses custom transaction numbers — the API assigns nothing,
  // so continue the estimate sequence ourselves (invoices number separately).
  let nextDocNumber =
    Math.max(
      0,
      ...recentEstimates
        .map((e) => Number(e.DocNumber))
        .filter((n) => Number.isFinite(n) && n > 0),
    ) + 1;

  // Photo-training assets (optional — Section V is a DRAFT until owner
  // sign-off; exemplars teach scope reading, Section 0 owns prices).
  const sectionVText = fs.existsSync(SECTION_V_PATH)
    ? fs.readFileSync(SECTION_V_PATH, 'utf8')
    : undefined;
  const exemplarLibrary: ExemplarLibraryEntry[] = fs.existsSync(EXEMPLAR_LIBRARY_PATH)
    ? fs.readFileSync(EXEMPLAR_LIBRARY_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ExemplarLibraryEntry)
    : [];
  console.log(
    `photo layer: Section V ${sectionVText ? 'loaded' : 'ABSENT'}, exemplar library ${exemplarLibrary.length} areas\n`,
  );

  const today = new Date().toISOString().slice(0, 10);
  const records: DraftRunRecord[] = [];

  for (const finding of targets) {
    const label = `${finding.customer ?? 'unknown'} (${finding.phone})`;
    console.log(`── ${label}: ${finding.title}`);
    try {
      const record = await draftOne({ finding, qb, quo, gemini, snapshot, rulesetText, itemNames, items, library, recentEstimates, today, dryRun, docNumber: String(nextDocNumber), sectionVText, exemplarLibrary });
      if (record.outcome === 'created') nextDocNumber++;
      records.push(record);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      console.log(`  ✗ failed: ${msg}`);
      records.push({ phone: finding.phone, customer: finding.customer ?? '', outcome: 'failed', detail: msg });
    }
    console.log('');
  }

  // Append this run to the local run log (review aid; gitignored).
  const prior = fs.existsSync(RUNLOG_PATH)
    ? (JSON.parse(fs.readFileSync(RUNLOG_PATH, 'utf8')) as unknown[])
    : [];
  prior.push({ ranAt: new Date().toISOString(), dryRun, records });
  fs.writeFileSync(RUNLOG_PATH, JSON.stringify(prior, null, 2));

  const created = records.filter((r) => r.outcome === 'created');
  console.log(`Done: ${created.length} created, ${records.filter((r) => r.outcome === 'dry-run').length} dry-run, ${records.filter((r) => r.outcome === 'skipped').length} skipped, ${records.filter((r) => r.outcome === 'failed').length} failed`);
  for (const r of created) {
    console.log(`  → #${r.docNumber} ${r.customer} $${r.total} (estimate ${r.estimateId})`);
  }
}

async function generateWithRetry(
  gemini: GeminiClient,
  prompt: string,
  opts: {
    systemPrompt?: string;
    imageParts?: Array<{ mimeType: string; base64: string }>;
  },
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await gemini.generateContent(prompt, {
        systemPrompt: opts.systemPrompt,
        temperature: 0,
        maxOutputTokens: 8192,
        thinkingBudget: 4096,
        timeoutMs: 120_000,
        imageParts: opts.imageParts?.length ? opts.imageParts : undefined,
      });
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      if (attempt < 2 && /429|500|503|timeout|aborted/i.test(msg)) {
        await new Promise((r) => setTimeout(r, msg.includes('429') ? 65_000 : 5_000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('Gemini returned nothing after retries');
}

async function draftOne(ctx: {
  finding: Finding & { phone: string };
  qb: QuickBooksClient;
  quo: QuoClient;
  gemini: GeminiClient;
  snapshot: Snapshot;
  rulesetText: string;
  itemNames: string[];
  items: Awaited<ReturnType<QuickBooksClient['listItems']>>;
  library: Map<string, string>;
  recentEstimates: QBEstimate[];
  today: string;
  dryRun: boolean;
  docNumber: string;
  sectionVText?: string;
  exemplarLibrary: ExemplarLibraryEntry[];
}): Promise<DraftRunRecord> {
  const { finding, qb, quo, gemini } = ctx;
  const phone = finding.phone;
  const customerName = finding.customer?.trim() || phone;

  // ── resolve the QBO customer (snapshot phone join → name search → create)
  const snapCustomer = ctx.snapshot.customers.find((c) => c.phones.includes(phone));
  let customerId = snapCustomer?.id ?? null;
  let resolvedName = snapCustomer?.name ?? customerName;
  if (!customerId && finding.customer) {
    const byName = await qb.searchCustomerByName(finding.customer);
    if (byName?.Id) {
      customerId = byName.Id;
      resolvedName = byName.DisplayName ?? customerName;
    }
  }

  // ── idempotency: never stack bot drafts on the same customer
  if (customerId) {
    const existing = await qb.getEstimatesByCustomer(customerId);
    const botPending = existing.find((e) => e.TxnStatus === 'Pending' && isBotDraft(e));
    if (botPending) {
      if (!ctx.dryRun) {
        console.log(`  ~ skipped: bot draft already pending (#${botPending.DocNumber})`);
        return { phone, customer: resolvedName, outcome: 'skipped', detail: `bot draft #${botPending.DocNumber} already pending` };
      }
      console.log(`  ~ note: bot draft #${botPending.DocNumber} already pending — a live run would skip; continuing (dry-run)`);
    }
  }

  // ── assemble the thread + photos fresh from Quo (snapshot has no media)
  const page = await quo.listMessages({ participantE164: phone, maxResults: MAX_THREAD_MESSAGES });
  const messages = [...page.data].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  if (messages.length === 0) {
    console.log('  ~ skipped: no Quo messages for this number');
    return { phone, customer: resolvedName, outcome: 'skipped', detail: 'no Quo messages' };
  }
  const thread: DraftThreadMessage[] = messages.map((m) => ({
    direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
    at: m.createdAt,
    text: m.text || (m.media?.length ? '[photo]' : ''),
  }));

  const imageParts: Array<{ mimeType: string; base64: string }> = [];
  for (const m of messages) {
    if (m.direction !== 'incoming' || !m.media) continue;
    for (const media of m.media) {
      if (imageParts.length >= MAX_PHOTOS) break;
      if (media.type && !media.type.startsWith('image/')) continue;
      const dl = await quo.downloadMessageMedia(media.url).catch(() => null);
      if (!dl || !dl.contentType.startsWith('image/')) continue;
      imageParts.push({ mimeType: dl.contentType, base64: Buffer.from(dl.data).toString('base64') });
    }
  }
  console.log(`  thread: ${thread.length} messages, ${imageParts.length} photo(s)`);

  // ── photo pre-pass: segment areas, retrieve similar historical areas
  // (degrades to v1 behavior on any failure — never blocks the draft)
  let photoContext: string | undefined;
  if (imageParts.length > 0 && ctx.exemplarLibrary.length > 0) {
    try {
      const areaRaw = await generateWithRetry(
        gemini,
        buildAreaAnalysisPrompt({ thread, photoCount: imageParts.length, itemNames: ctx.itemNames }),
        { imageParts },
      );
      const analysis = parseAreaAnalysis(areaRaw);
      if (analysis) {
        const situations = analysis.areas.map((a) => areaSituationText(a, analysis.photoReads));
        const vectors = await gemini.embedContent(situations, { timeoutMs: 60_000 });
        const retrieved = analysis.areas.map((area, i) => ({
          area,
          exemplars: retrieveSimilar(vectors[i], ctx.exemplarLibrary, EXEMPLARS_PER_AREA),
        }));
        photoContext = formatPhotoContext({ analysis, retrieved });
        console.log(`  areas: ${analysis.areas.length}`);
        for (const { area, exemplars } of retrieved) {
          console.log(`    [${area.area}] ${area.description.slice(0, 90)}`);
          for (const { item, score } of exemplars.slice(0, 1)) {
            const what = item.quotedItems.length
              ? item.quotedItems.map((q) => q.item).join(' + ')
              : 'NOT QUOTED';
            console.log(`        ≈ #${item.docNumber} (${score.toFixed(2)}): ${what}`);
          }
        }
      } else {
        console.log('  ⚠ photo pre-pass unparseable — drafting without area analysis');
      }
    } catch (err) {
      console.log(`  ⚠ photo pre-pass failed (${(err as Error).message.slice(0, 100)}) — drafting without it`);
    }
  }

  // ── draft with Gemini (retry transient failures like analyze.ts does)
  const { systemPrompt, userPrompt } = buildQuoteDraftPrompt({
    customerName: resolvedName,
    phone,
    today: ctx.today,
    rulesetText: ctx.rulesetText,
    itemNames: ctx.itemNames,
    thread,
    photoCount: imageParts.length,
    photoContext,
    visualRulesetText: ctx.sectionVText,
  });

  const raw = await generateWithRetry(gemini, userPrompt, { systemPrompt, imageParts });

  const parsed = parseQuoteDraftResponse(raw);
  if (!parsed) {
    throw new Error(`unparseable draft response: ${raw.slice(0, 200).replace(/\n/g, ' ')}`);
  }
  const validation = validateQuoteDraft(parsed, ctx.itemNames);
  if (!validation.ok) {
    console.log(`  ✗ validation failed: ${validation.errors.join('; ')}`);
    return { phone, customer: resolvedName, outcome: 'failed', detail: validation.errors.join('; ') };
  }
  const draft = validation.draft;

  const comparables = selectComparables(ctx.recentEstimates, draft);
  const privateNote = buildDraftPrivateNote({
    draft,
    warnings: validation.warnings,
    comparables,
    generatedAt: ctx.today,
  });
  const lines = assembleEstimateLines({ draft, items: ctx.items, descriptionLibrary: ctx.library });

  console.log(`  draft: $${draftTotal(draft)} (${draft.confidence}${draft.needsSiteVisit ? ', site visit' : ''})`);
  for (const l of draft.lines) {
    console.log(`    ${l.item}${l.scopeNote ? ` [${l.scopeNote}]` : ''} ×${l.qty} @ $${l.unitPrice}`);
  }
  for (const a of draft.scopeAccounting) {
    console.log(
      a.quotedItem
        ? `    ✓ "${a.request}" → ${a.quotedItem}`
        : `    ✗ "${a.request}" EXCLUDED: ${a.reason ?? '(no reason)'}`,
    );
  }
  for (const w of validation.warnings) console.log(`    ⚠ ${w}`);
  for (const q of draft.openQuestions) console.log(`    ? ${q}`);

  if (ctx.dryRun) {
    console.log('  [dry-run] would create Pending estimate; PrivateNote:');
    console.log(privateNote.split('\n').map((l) => `    | ${l}`).join('\n'));
    return { phone, customer: resolvedName, outcome: 'dry-run', detail: `$${draftTotal(draft)}`, total: draftTotal(draft) };
  }

  if (!customerId) {
    const created = await qb.createCustomer({ displayName: customerName, phone });
    customerId = created.Id!;
    console.log(`  + created QBO customer ${customerId} "${customerName}"`);
  }

  const estimate = await qb.createEstimate({ customerId, lines, privateNote, docNumber: ctx.docNumber });
  console.log(`  ✓ created Pending estimate #${estimate.DocNumber} — $${estimate.TotalAmt}`);
  return {
    phone,
    customer: resolvedName,
    outcome: 'created',
    detail: `#${estimate.DocNumber}`,
    estimateId: estimate.Id,
    docNumber: estimate.DocNumber,
    total: estimate.TotalAmt,
  };
}

main().catch((err) => {
  console.error('drafter failed:', err);
  process.exit(1);
});
