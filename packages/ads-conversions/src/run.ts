/**
 * One run: GA4 ad taps → match to Quo first contacts → store phone→gclid →
 * work out funnel stages from Quo + QBO → upload new conversions to Google.
 *
 * Modes: 'off' does nothing; 'dry' matches in memory and uploads with
 * validateOnly (nothing reaches Google, nothing is stored except the run
 * summary); 'live' stores clicks and uploads for real.
 */
import type { GA4ReportRequest, GA4ReportResponse } from '@aac/api-clients/google-analytics';
import type { DataManagerEvent, GoogleAdsDestination, IngestResponse } from '@aac/api-clients/data-manager';
import type { ConversionActionRow } from '@aac/api-clients/google-ads';
import type { QBCustomer, QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoConversation, QuoMessage, QuoPaginated } from '@aac/api-clients/quo';
import { easternWallTime } from '@aac/shared-utils/eastern';
import { isInternalPhone, quickNormalizePhone, toRedisPhone } from '@aac/shared-utils/phone';
import { keys } from '@aac/shared-utils/redis';
import { matchTaps, parseRefCode, WINDOW_AFTER_MS, type AdClick, type AdTap, type InboundEvent } from './match.js';
import { CLICK_MAX_AGE_MS, stagesFor, type Stage, type StageHit } from './stages.js';

export type AdsConversionsMode = 'off' | 'dry' | 'live';

/** Conversion action names in the MA account, one per stage. */
export const ACTION_NAMES: Record<Stage, string> = {
  lead: 'AAC Real lead',
  quote: 'AAC Quote sent',
  won: 'AAC Won job',
};

export const TAP_EVENTS: Record<string, 'call' | 'text'> = {
  phone_call_click: 'call',
  text_message_click: 'text',
};

export interface AdsRedis {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<unknown>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hsetnx<T>(key: string, field: string, value: T): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, member: string, ...members: string[]): Promise<number>;
}

export interface AdsConversionsDeps {
  ga: { runReport(req: GA4ReportRequest): Promise<GA4ReportResponse> };
  quo: {
    listConversations(opts: { maxResults?: number; pageToken?: string; updatedAfter?: Date }): Promise<QuoPaginated<QuoConversation>>;
    listMessages(opts: { participantE164: string; maxResults?: number }): Promise<QuoPaginated<QuoMessage>>;
    listCalls(opts: { participantE164: string; maxResults?: number }): Promise<QuoPaginated<QuoCall>>;
  };
  qb: {
    listAllCustomers(opts?: { includeInactive?: boolean }): Promise<QBCustomer[]>;
    getEstimatesByCustomer(customerId: string): Promise<QBEstimate[]>;
    getInvoicesByCustomer(customerId: string): Promise<QBInvoice[]>;
  };
  ads: { listConversionActions(): Promise<ConversionActionRow[]> };
  /** Data Manager API: the upload path (Ads' own upload is allowlist-only since 2026-06-15). */
  dataManager: {
    ingestEvents(d: GoogleAdsDestination[], e: DataManagerEvent[], opts?: { validateOnly?: boolean }): Promise<IngestResponse>;
  };
  /** The MA Ads account (digits) and the MCC it's reached through. */
  adsAccount: { customerId: string; loginCustomerId?: string };
  redis: AdsRedis;
  /** The business line (QUO_PHONE_NUMBER); its own number is never a lead. */
  ownLine: string;
  now: () => number;
  log: (line: string) => void;
}

export interface AdsRunSummary {
  mode: AdsConversionsMode;
  ranAt: string;
  lookbackDays: number;
  taps: number;
  newMatches: number;
  matchedByRef: number;
  matchedByTiming: number;
  ambiguous: number;
  unmatched: number;
  trackedClicks: number;
  pruned: number;
  /** Conversions ready to send this run, by stage. */
  pending: Record<Stage, number>;
  uploaded: number;
  failed: Array<{ orderId: string; error: string }>;
  skipped?: string;
  /** Data Manager request ID of the accepted upload (look up diagnostics with it). */
  requestId?: string;
  /** Dry runs only: every conversion that would be sent, for review. */
  preview?: Array<{ orderId: string; matchedBy: AdClick['matchedBy']; tapAt: string; at: string; value?: number }>;
}

const MIN = 60_000;
const DAY = 86_400_000;

// ── GA4 ──────────────────────────────────────────────────────────────

export function parseTaps(report: GA4ReportResponse): AdTap[] {
  const idx = (name: string) => report.dimensionHeaders.findIndex((h) => h.name === name);
  const [iMin, iEvent, iGclid, iRef] = ['dateHourMinute', 'eventName', 'customEvent:ad_click_id', 'customEvent:ref_code'].map(idx);
  const taps: AdTap[] = [];
  for (const row of report.rows) {
    const v = row.dimensionValues.map((d) => d.value);
    const kind = TAP_EVENTS[v[iEvent]];
    const gclid = v[iGclid];
    const stamp = v[iMin]; // YYYYMMDDHHmm, property time zone (Eastern)
    if (!kind || !gclid || gclid === '(not set)' || !/^\d{12}$/.test(stamp)) continue;
    const label = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    const ref = iRef >= 0 ? v[iRef] : '';
    taps.push({
      at: easternWallTime(label, Number(stamp.slice(8, 10)), Number(stamp.slice(10, 12))),
      gclid,
      kind,
      refCode: ref && ref !== '(not set)' ? ref.toUpperCase() : null,
    });
  }
  return taps;
}

async function fetchTaps(deps: AdsConversionsDeps, lookbackDays: number): Promise<AdTap[]> {
  const report = await deps.ga.runReport({
    dateRanges: [{ startDate: `${lookbackDays}daysAgo`, endDate: 'today' }],
    dimensions: [
      { name: 'dateHourMinute' },
      { name: 'eventName' },
      { name: 'customEvent:ad_click_id' },
      { name: 'customEvent:ref_code' },
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: Object.keys(TAP_EVENTS) } } },
    limit: 10000,
  });
  return parseTaps(report);
}

// ── Quo ──────────────────────────────────────────────────────────────

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Thread {
  phone: string;
  e164: string;
  messages: QuoMessage[];
  calls: QuoCall[];
}

async function fetchThread(deps: AdsConversionsDeps, e164: string): Promise<Thread> {
  const [m, c] = await Promise.all([
    deps.quo.listMessages({ participantE164: e164, maxResults: 50 }),
    deps.quo.listCalls({ participantE164: e164, maxResults: 50 }),
  ]);
  return { phone: toRedisPhone(e164) as string, e164, messages: m.data ?? [], calls: c.data ?? [] };
}

/**
 * Inbound events worth matching: a new number's first contact, and any
 * inbound text carrying a ref code. Only threads that could hold one are
 * fetched: conversations created in the window (new numbers), plus, when
 * ref-coded taps exist, conversations active since the earliest of them.
 */
async function fetchInboundEvents(
  deps: AdsConversionsDeps,
  since: Date,
  taps: AdTap[],
  skipPhones: Set<string>,
): Promise<InboundEvent[]> {
  const conversations: QuoConversation[] = [];
  let pageToken: string | undefined;
  do {
    const page = await deps.quo.listConversations({ maxResults: 100, pageToken, updatedAfter: since });
    conversations.push(...(page.data ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const refTaps = taps.filter((t) => t.refCode);
  const refSince = refTaps.length ? Math.min(...refTaps.map((t) => t.at.getTime())) - 2 * MIN : Infinity;
  const wanted = new Map<string, QuoConversation>();
  for (const c of conversations) {
    if (c.participants.length !== 1) continue;
    const e164 = quickNormalizePhone(c.participants[0]);
    const phone = toRedisPhone(e164);
    if (!e164 || !phone || skipPhones.has(phone) || isInternalPhone(e164, deps.ownLine)) continue;
    const created = Date.parse(c.createdAt);
    const active = Date.parse(c.lastActivityAt ?? c.updatedAt);
    if (created >= since.getTime() || active >= refSince) wanted.set(e164, c);
  }

  const threads = await mapLimit([...wanted.keys()], 4, (e164) => fetchThread(deps, e164));
  const events: InboundEvent[] = [];
  for (const t of threads) {
    const conv = wanted.get(t.e164) as QuoConversation;
    const all = [
      ...t.messages.map((m) => ({ at: new Date(m.createdAt), dir: m.direction, kind: 'text' as const, text: m.text ?? '' })),
      ...t.calls.map((c) => ({ at: new Date(c.createdAt), dir: c.direction, kind: 'call' as const, text: '' })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = all[0];
    // New number: the conversation began in the window and its very first
    // event was them reaching us (not us reaching out).
    const isNew =
      !!first &&
      first.dir === 'incoming' &&
      Date.parse(conv.createdAt) >= since.getTime() &&
      first.at.getTime() >= Date.parse(conv.createdAt) - 10 * MIN;
    if (isNew) {
      events.push({ phone: t.phone, at: first.at, kind: first.kind, text: first.text, firstContact: true });
    }
    for (const m of t.messages) {
      if (m.direction !== 'incoming' || !parseRefCode(m.text)) continue;
      if (isNew && new Date(m.createdAt).getTime() === first.at.getTime()) continue; // already added
      events.push({ phone: t.phone, at: new Date(m.createdAt), kind: 'text', text: m.text, firstContact: false });
    }
  }
  return events;
}

// ── QBO ──────────────────────────────────────────────────────────────

function customersByPhone(customers: QBCustomer[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of customers) {
    for (const p of [c.PrimaryPhone, c.Mobile, c.AlternatePhone]) {
      const phone = toRedisPhone(quickNormalizePhone(p?.FreeFormNumber));
      if (!phone || !c.Id) continue;
      const ids = map.get(phone) ?? [];
      if (!ids.includes(c.Id)) ids.push(c.Id);
      map.set(phone, ids);
    }
  }
  return map;
}

// ── Run ──────────────────────────────────────────────────────────────

export async function runAdsConversions(
  deps: AdsConversionsDeps,
  opts: { mode: AdsConversionsMode; lookbackDays?: number },
): Promise<AdsRunSummary> {
  const now = new Date(deps.now());
  const lookbackDays = opts.lookbackDays ?? 3;
  const summary: AdsRunSummary = {
    mode: opts.mode,
    ranAt: now.toISOString(),
    lookbackDays,
    taps: 0,
    newMatches: 0,
    matchedByRef: 0,
    matchedByTiming: 0,
    ambiguous: 0,
    unmatched: 0,
    trackedClicks: 0,
    pruned: 0,
    pending: { lead: 0, quote: 0, won: 0 },
    uploaded: 0,
    failed: [],
  };
  if (opts.mode === 'off') return { ...summary, skipped: 'off' };

  // 1. Match new taps.
  const stored = ((await deps.redis.hgetall<Record<string, AdClick>>(keys.adsClicks)) ?? {}) as Record<string, AdClick>;
  const since = new Date(now.getTime() - (lookbackDays + 1) * DAY);
  const taps = await fetchTaps(deps, lookbackDays);
  summary.taps = taps.length;
  const events = await fetchInboundEvents(deps, since, taps, new Set(Object.keys(stored)));
  // A tap from the last few minutes may still be waiting on its call.
  const settled = taps.filter((t) => t.at.getTime() + WINDOW_AFTER_MS < now.getTime());
  const result = matchTaps(settled, events);
  summary.ambiguous = result.ambiguous;
  summary.unmatched = result.unmatched;
  for (const click of result.matches) {
    // Dry runs keep matches in memory so a trial leaves no state behind.
    const isNew =
      opts.mode === 'live' ? await deps.redis.hsetnx(keys.adsClicks, click.phone, click) : !(click.phone in stored);
    if (isNew) {
      stored[click.phone] = click;
      summary.newMatches++;
      if (click.matchedBy === 'ref') summary.matchedByRef++;
      else summary.matchedByTiming++;
    }
  }

  // 2. Prune clicks Google would reject.
  const live: AdClick[] = [];
  for (const [phone, click] of Object.entries(stored)) {
    if (now.getTime() - Date.parse(click.tapAt) > CLICK_MAX_AGE_MS) {
      if (opts.mode === 'live') await deps.redis.hdel(keys.adsClicks, phone);
      summary.pruned++;
    } else {
      live.push(click);
    }
  }
  summary.trackedClicks = live.length;

  // 3. Stages reached, minus what Google already has.
  const sent = new Set(await deps.redis.smembers(keys.adsConversionsSent));
  const open = live.filter((c) => (['lead', 'quote', 'won'] as Stage[]).some((s) => !sent.has(`${s}:${c.phone}`)));
  const pending: Array<{ click: AdClick; hit: StageHit }> = [];
  if (open.length) {
    const byPhone = customersByPhone(await deps.qb.listAllCustomers({ includeInactive: true }));
    await mapLimit(open, 3, async (click) => {
      const thread = sent.has(`lead:${click.phone}`)
        ? { messages: [], calls: [] }
        : await fetchThread(deps, `+1${click.phone}`);
      const ids = byPhone.get(click.phone) ?? [];
      const estimates = (await Promise.all(ids.map((id) => deps.qb.getEstimatesByCustomer(id)))).flat();
      const invoices = (await Promise.all(ids.map((id) => deps.qb.getInvoicesByCustomer(id)))).flat();
      const hits = stagesFor(
        click,
        {
          messages: thread.messages.map((m) => ({
            at: new Date(m.createdAt),
            direction: m.direction,
            text: m.text ?? '',
            hasMedia: (m.media?.length ?? 0) > 0,
          })),
          calls: thread.calls.map((c) => ({
            at: new Date(c.createdAt),
            direction: c.direction,
            durationSec: c.duration ?? 0,
            voicemail: !!c.voicemail,
          })),
        },
        estimates,
        invoices,
        now,
      );
      for (const hit of hits) if (!sent.has(hit.orderId)) pending.push({ click, hit });
    });
  }
  for (const p of pending) summary.pending[p.hit.stage]++;
  if (opts.mode === 'dry') {
    summary.preview = pending.map(({ click, hit }) => ({
      orderId: hit.orderId,
      matchedBy: click.matchedBy,
      tapAt: click.tapAt,
      at: hit.at.toISOString(),
      value: hit.value,
    }));
  }

  // 4. Upload.
  if (!pending.length) return finish(deps, summary);
  const actions = new Map((await deps.ads.listConversionActions()).map((a) => [a.name, a.id]));
  const missing = (Object.values(ACTION_NAMES) as string[]).filter((n) => !actions.has(n));
  if (missing.length) {
    return finish(deps, { ...summary, skipped: `conversion actions missing: ${missing.join(', ')}` });
  }
  const destinations: GoogleAdsDestination[] = (Object.keys(ACTION_NAMES) as Stage[]).map((stage) => ({
    reference: stage,
    operatingAccountId: deps.adsAccount.customerId,
    loginAccountId: deps.adsAccount.loginCustomerId,
    conversionActionId: actions.get(ACTION_NAMES[stage]) as string,
  }));
  let batch: DataManagerEvent[] = pending.map(({ click, hit }) => ({
    destinationReferences: [hit.stage],
    gclid: click.gclid,
    eventTimestamp: hit.at.toISOString(),
    transactionId: hit.orderId,
    ...(hit.value !== undefined ? { conversionValue: hit.value, currency: 'USD' } : {}),
  }));
  // Validation is fast-fail: a rejected request names the bad events by
  // index. Drop those and retry once, so one bad gclid can't block the rest.
  for (let attempt = 0; attempt < 2 && batch.length; attempt++) {
    try {
      const res = await deps.dataManager.ingestEvents(destinations, batch, { validateOnly: opts.mode !== 'live' });
      summary.requestId = res.requestId;
      if (opts.mode === 'live') {
        const ids = batch.map((e) => e.transactionId);
        await deps.redis.sadd(keys.adsConversionsSent, ids[0], ...ids.slice(1));
        summary.uploaded = ids.length;
      }
      break;
    } catch (err) {
      const msg = (err as Error).message;
      const bad = new Set([...msg.matchAll(/events\[(\d+)\]/g)].map((m) => Number(m[1])));
      if (attempt === 1 || bad.size === 0) {
        summary.failed.push({ orderId: '*', error: msg.slice(0, 500) });
        break;
      }
      batch.forEach((e, i) => {
        if (bad.has(i)) summary.failed.push({ orderId: e.transactionId, error: msg.slice(0, 300) });
      });
      batch = batch.filter((_, i) => !bad.has(i));
    }
  }
  return finish(deps, summary);
}

async function finish(deps: AdsConversionsDeps, summary: AdsRunSummary): Promise<AdsRunSummary> {
  await deps.redis.set(keys.adsConversionsLastSummary, summary);
  await deps.redis.set(keys.cronLastRun('ads-conversions'), summary.ranAt);
  deps.log(
    `ads-conversions ${summary.mode}: taps=${summary.taps} new=${summary.newMatches} ` +
      `(ref ${summary.matchedByRef}, timing ${summary.matchedByTiming}) ambiguous=${summary.ambiguous} ` +
      `tracked=${summary.trackedClicks} pending=${JSON.stringify(summary.pending)} uploaded=${summary.uploaded} ` +
      `failed=${summary.failed.length}${summary.skipped ? ` skipped=${summary.skipped}` : ''}`,
  );
  return summary;
}
