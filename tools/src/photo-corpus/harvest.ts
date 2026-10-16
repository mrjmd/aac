#!/usr/bin/env npx tsx
/**
 * Photo-corpus harvester — Phase 1 of the photo→quote training layer
 * (docs/projects/photo-quote-training.md).
 *
 * Sweeps every estimate in the spike corpus and collects the customer's
 * pre-quote photos (Quo MMS + emailed attachments) plus the thread
 * excerpt around each estimate, attributing photos to estimates by date
 * window (@aac/quoting photo-corpus logic — nearest wins, overlaps
 * flagged ambiguous, never guessed silently).
 *
 * Read-only against every external system. Output (gitignored):
 *   analysis/data/photo-corpus/photos/{customerId}/…       raw images
 *   analysis/data/photo-corpus/manifest.jsonl              one row per estimate
 *   analysis/data/photo-corpus/orphans.jsonl               unattributed photos
 *   analysis/data/photo-corpus/customer-emails.json        QBO email cache
 *   analysis/data/photo-corpus/progress.json               resume checkpoint
 *
 * Usage (from repo root):
 *   npx tsx tools/src/photo-corpus/harvest.ts                 # full sweep (resumable)
 *   npx tsx tools/src/photo-corpus/harvest.ts --limit 10      # pilot: first N customers
 *   npx tsx tools/src/photo-corpus/harvest.ts --customer 123  # one QBO customer id
 *   npx tsx tools/src/photo-corpus/harvest.ts --mms-only      # skip the Gmail sweep
 */

import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { QuickBooksClient } from '@aac/api-clients/quickbooks';
import { QuoClient, type QuoMessage } from '@aac/api-clients/quo';
import { GmailClient } from '@aac/api-clients/gmail';
import { keys, ttl } from '@aac/shared-utils/redis';
import { normalizePhone } from '@aac/shared-utils/phone';
import type { QBOAuthTokens } from '@aac/shared-utils/types';
import {
  attributePhoto,
  messagesWithinWindow,
  type CorpusEstimateRef,
} from '@aac/quoting';

// ── config ───────────────────────────────────────────────────────────

const ESTIMATES_PATH = 'analysis/data/quoting-spike/estimates-full.jsonl';
const OUT_DIR = 'analysis/data/photo-corpus';
const CORPUS_START = '2024-08-01'; // a month before the oldest estimate
const MAX_QUO_PAGES = 12; // 1,200 messages — no 2yr thread is longer
const MAX_PHOTOS_PER_CUSTOMER = 60; // runaway guard; truncation is LOGGED
const MIN_EMAIL_IMAGE_BYTES = 30_000; // skip signature logos / tracking pixels
const QUO_PACE_MS = 120;

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

// ── corpus types ─────────────────────────────────────────────────────

interface CorpusEstimate {
  estimateId: string;
  docNumber: string;
  txnDate: string;
  createdAt: string;
  status: string;
  outcome?: string;
  totalAmt: number;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerCity?: string;
  lines: Array<{ item: string; description: string; unitPrice: number; qty: number; amount: number }>;
}

interface PhotoRecord {
  file: string; // relative to OUT_DIR
  source: 'mms' | 'email';
  at: string;
  mimeType: string;
  bytes: number;
  /** Message text sent alongside the photo (MMS) or email subject. */
  withText?: string;
  daysBeforeEstimate: number | null;
  ambiguousWith: string[];
}

interface ThreadMessage {
  at: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  hadMedia?: boolean;
}

interface ManifestRow {
  estimateId: string;
  docNumber: string;
  txnDate: string;
  status: string;
  outcome?: string;
  totalAmt: number;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  lines: CorpusEstimate['lines'];
  thread: ThreadMessage[];
  photos: PhotoRecord[];
}

interface OrphanRow {
  customerId: string;
  customerName: string;
  photo: PhotoRecord;
}

// ── harvest one customer ─────────────────────────────────────────────

interface HarvestDeps {
  quo: QuoClient;
  gmail: GmailClient | null;
}

interface CustomerGroup {
  customerId: string;
  customerName: string;
  phones: string[]; // E.164, deduped
  email?: string;
  estimates: CorpusEstimate[];
}

interface RawPhoto {
  buf: Buffer;
  source: 'mms' | 'email';
  at: string;
  mimeType: string;
  withText?: string;
  key: string; // filename stem (unique per photo)
}

function extFor(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('heic') || mime.includes('heif')) return 'heic';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

async function fetchQuoThread(quo: QuoClient, phoneE164: string): Promise<QuoMessage[]> {
  const all: QuoMessage[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_QUO_PAGES; page++) {
    const res = await quo.listMessages({ participantE164: phoneE164, maxResults: 100, pageToken });
    all.push(...res.data);
    pageToken = res.nextPageToken;
    const oldest = res.data[res.data.length - 1]?.createdAt ?? '';
    await sleep(QUO_PACE_MS);
    if (!pageToken || res.data.length === 0) break;
    if (oldest && oldest.slice(0, 10) < CORPUS_START) break;
  }
  return all.filter((m) => m.createdAt.slice(0, 10) >= CORPUS_START);
}

async function harvestCustomer(deps: HarvestDeps, group: CustomerGroup): Promise<{
  rows: ManifestRow[];
  orphans: OrphanRow[];
  stats: { mms: number; email: number; truncated: boolean; skippedSmallEmail: number };
}> {
  const { quo, gmail } = deps;
  const photoDir = path.join(OUT_DIR, 'photos', group.customerId);
  const rawPhotos: RawPhoto[] = [];
  const thread: ThreadMessage[] = [];
  const stats = { mms: 0, email: 0, truncated: false, skippedSmallEmail: 0 };

  // ── Quo: full thread per phone (dedup messages across phones by id) ──
  const seenMsgIds = new Set<string>();
  for (const phone of group.phones) {
    const messages = await fetchQuoThread(quo, phone);
    for (const m of messages) {
      if (m.id && seenMsgIds.has(m.id)) continue;
      if (m.id) seenMsgIds.add(m.id);
      thread.push({
        at: m.createdAt,
        direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
        text: m.text ?? '',
        hadMedia: (m.media?.length ?? 0) > 0 || undefined,
      });
      if (m.direction === 'outgoing' || !m.media?.length) continue;
      for (let i = 0; i < m.media.length; i++) {
        if (rawPhotos.length >= MAX_PHOTOS_PER_CUSTOMER) { stats.truncated = true; break; }
        const item = m.media[i];
        try {
          const dl = await quo.downloadMessageMedia(item.url);
          await sleep(60);
          if (!dl) continue; // expired/404 — degrade
          if (!dl.contentType.startsWith('image/')) continue; // videos etc.
          rawPhotos.push({
            buf: Buffer.from(dl.data),
            source: 'mms',
            at: m.createdAt,
            mimeType: dl.contentType,
            withText: m.text || undefined,
            key: `mms-${m.id ?? m.createdAt.slice(0, 10)}-${i}`,
          });
          stats.mms++;
        } catch (err) {
          console.log(`    ! media download failed (${(err as Error).message.slice(0, 80)})`);
        }
      }
    }
  }

  // ── Gmail: image attachments from the customer's address ──
  if (gmail && group.email) {
    try {
      const after = CORPUS_START.replace(/-/g, '/');
      const messages = await gmail.listMessages({
        query: `from:${group.email} has:attachment after:${after}`,
        maxResults: 100,
      });
      for (const msg of messages) {
        for (const att of msg.attachments) {
          if (!att.mimeType.startsWith('image/')) continue;
          if (att.sizeBytes < MIN_EMAIL_IMAGE_BYTES) { stats.skippedSmallEmail++; continue; }
          if (rawPhotos.length >= MAX_PHOTOS_PER_CUSTOMER) { stats.truncated = true; break; }
          const buf = await gmail.downloadAttachment(msg.id, att.attachmentId);
          if (!buf) continue;
          rawPhotos.push({
            buf,
            source: 'email',
            at: msg.at,
            mimeType: att.mimeType,
            withText: msg.subject || undefined,
            key: `email-${msg.id}-${att.filename.replace(/\.[a-zA-Z0-9]+$/, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40)}`,
          });
          stats.email++;
        }
      }
    } catch (err) {
      console.log(`    ! gmail sweep failed (${(err as Error).message.slice(0, 80)})`);
    }
  }

  // ── Attribute photos → estimates, write files ──
  const refs: CorpusEstimateRef[] = group.estimates.map((e) => ({
    estimateId: e.estimateId,
    docNumber: e.docNumber,
    txnDate: e.txnDate,
  }));

  const attributed = new Map<string, PhotoRecord[]>();
  const orphans: OrphanRow[] = [];
  if (rawPhotos.length > 0) fs.mkdirSync(photoDir, { recursive: true });
  for (const p of rawPhotos) {
    const file = path.join('photos', group.customerId, `${p.key}.${extFor(p.mimeType)}`);
    fs.writeFileSync(path.join(OUT_DIR, file), p.buf);
    const attr = attributePhoto(p.at, refs);
    const record: PhotoRecord = {
      file,
      source: p.source,
      at: p.at,
      mimeType: p.mimeType,
      bytes: p.buf.length,
      withText: p.withText,
      daysBeforeEstimate: attr.daysBeforeEstimate,
      ambiguousWith: attr.ambiguousWith,
    };
    if (attr.estimateId) {
      const list = attributed.get(attr.estimateId) ?? [];
      list.push(record);
      attributed.set(attr.estimateId, list);
    } else {
      orphans.push({ customerId: group.customerId, customerName: group.customerName, photo: record });
    }
  }

  thread.sort((a, b) => a.at.localeCompare(b.at));
  const rows: ManifestRow[] = group.estimates.map((e) => ({
    estimateId: e.estimateId,
    docNumber: e.docNumber,
    txnDate: e.txnDate,
    status: e.status,
    outcome: e.outcome,
    totalAmt: e.totalAmt,
    customerId: e.customerId,
    customerName: e.customerName,
    customerPhone: e.customerPhone,
    customerEmail: group.email,
    lines: e.lines,
    thread: messagesWithinWindow(thread, e.txnDate),
    photos: attributed.get(e.estimateId) ?? [],
  }));

  return { rows, orphans, stats };
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;
  const onlyCustomer = argv.includes('--customer') ? argv[argv.indexOf('--customer') + 1] : undefined;
  const mmsOnly = argv.includes('--mms-only');

  fs.mkdirSync(path.join(OUT_DIR, 'photos'), { recursive: true });

  const estimates: CorpusEstimate[] = fs
    .readFileSync(ESTIMATES_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // ── customer email map (one-time QBO pull, cached) ──
  const emailCachePath = path.join(OUT_DIR, 'customer-emails.json');
  let emailById: Record<string, string> = {};
  if (fs.existsSync(emailCachePath)) {
    emailById = JSON.parse(fs.readFileSync(emailCachePath, 'utf8'));
  } else {
    console.log('Pulling customer emails from QBO (one-time, cached)…');
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
    const customers = await qb.listAllCustomers();
    for (const c of customers) {
      const email = c.PrimaryEmailAddr?.Address?.trim();
      if (c.Id && email) emailById[c.Id] = email.toLowerCase();
    }
    fs.writeFileSync(emailCachePath, JSON.stringify(emailById, null, 1));
    console.log(`  ${customers.length} customers, ${Object.keys(emailById).length} with email\n`);
  }

  // ── group estimates by customer ──
  const byCustomer = new Map<string, CustomerGroup>();
  for (const e of estimates) {
    let g = byCustomer.get(e.customerId);
    if (!g) {
      g = {
        customerId: e.customerId,
        customerName: e.customerName,
        phones: [],
        email: emailById[e.customerId],
        estimates: [],
      };
      byCustomer.set(e.customerId, g);
    }
    g.estimates.push(e);
    const e164 = e.customerPhone ? normalizePhone(e.customerPhone) : null;
    if (e164 && !g.phones.includes(e164)) g.phones.push(e164);
  }

  // ── resume checkpoint ──
  const progressPath = path.join(OUT_DIR, 'progress.json');
  const done = new Set<string>(
    fs.existsSync(progressPath)
      ? (JSON.parse(fs.readFileSync(progressPath, 'utf8')).doneCustomerIds as string[])
      : [],
  );

  let groups = [...byCustomer.values()].sort((a, b) => Number(a.customerId) - Number(b.customerId));
  if (onlyCustomer) groups = groups.filter((g) => g.customerId === onlyCustomer);
  const pending = groups.filter((g) => !done.has(g.customerId)).slice(0, limit);

  console.log(
    `${estimates.length} estimates / ${groups.length} customers — ${done.size} done, processing ${pending.length}${mmsOnly ? ' [MMS ONLY]' : ''}\n`,
  );

  const quo = new QuoClient({
    apiKey: requireEnv('QUO_API_KEY'),
    phoneNumber: requireEnv('QUO_PHONE_NUMBER'),
  });
  const gmail = mmsOnly
    ? null
    : new GmailClient({
        oauth: {
          clientId: requireEnv('GOOGLE_CLIENT_ID'),
          clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
          refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
        },
      });

  const manifestPath = path.join(OUT_DIR, 'manifest.jsonl');
  const orphansPath = path.join(OUT_DIR, 'orphans.jsonl');
  const totals = { customers: 0, mms: 0, email: 0, orphans: 0, estWithPhotos: 0, estTotal: 0, noPhone: 0 };

  for (const group of pending) {
    totals.customers++;
    const tag = `[${totals.customers}/${pending.length}] ${group.customerName} (${group.customerId})`;
    if (group.phones.length === 0 && !group.email) {
      console.log(`${tag}: no phone, no email — manifest rows only`);
      totals.noPhone++;
    }
    try {
      const { rows, orphans, stats } = await harvestCustomer({ quo, gmail }, group);
      for (const row of rows) fs.appendFileSync(manifestPath, JSON.stringify(row) + '\n');
      for (const o of orphans) fs.appendFileSync(orphansPath, JSON.stringify(o) + '\n');
      totals.mms += stats.mms;
      totals.email += stats.email;
      totals.orphans += orphans.length;
      totals.estTotal += rows.length;
      totals.estWithPhotos += rows.filter((r) => r.photos.length > 0).length;
      const parts = [`${stats.mms} mms`, `${stats.email} email`, `${orphans.length} orphan`];
      if (stats.truncated) parts.push(`TRUNCATED at ${MAX_PHOTOS_PER_CUSTOMER}`);
      if (stats.skippedSmallEmail) parts.push(`${stats.skippedSmallEmail} small-img skipped`);
      console.log(`${tag}: ${rows.length} est → ${parts.join(', ')}`);
      done.add(group.customerId);
      fs.writeFileSync(progressPath, JSON.stringify({ doneCustomerIds: [...done] }, null, 1));
    } catch (err) {
      console.log(`${tag}: ✗ FAILED — ${(err as Error).message.slice(0, 160)} (will retry on next run)`);
    }
  }

  console.log(
    `\nDone. ${totals.customers} customers: ${totals.mms} MMS + ${totals.email} email photos, ` +
      `${totals.orphans} orphans. Estimates with ≥1 photo this run: ${totals.estWithPhotos}/${totals.estTotal}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
