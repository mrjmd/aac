import { describe, it, expect, vi } from 'vitest';
import { keys } from '@aac/shared-utils/redis';
import type { GA4ReportResponse } from '@aac/api-clients/google-analytics';
import { parseTaps, runAdsConversions, type AdsConversionsDeps, type AdsRedis } from '../src/index.js';

const NOW = new Date('2026-11-05T17:00:00Z');

function fakeRedis(): AdsRedis & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const hash = (k: string) => (data.get(k) as Record<string, unknown>) ?? {};
  return {
    data,
    async get<T>(k: string) { return (data.get(k) as T) ?? null; },
    async set(k, v) { data.set(k, v); return 'OK'; },
    async hgetall<T extends Record<string, unknown>>(k: string) { return (data.has(k) ? hash(k) : null) as T | null; },
    async hsetnx(k, f, v) { const h = hash(k); if (f in h) return 0; data.set(k, { ...h, [f]: v }); return 1; },
    async hdel(k, ...fs) { const h = { ...hash(k) }; fs.forEach((f) => delete h[f]); data.set(k, h); return fs.length; },
    async smembers(k) { return [...((data.get(k) as Set<string>) ?? [])]; },
    async sadd(k, ...ms) { const s = (data.get(k) as Set<string>) ?? new Set<string>(); ms.forEach((m) => s.add(m)); data.set(k, s); return ms.length; },
  };
}

// 11:58am ET tap on 11/5 → 2026-11-05T16:58:00Z
const report: GA4ReportResponse = {
  dimensionHeaders: [
    { name: 'dateHourMinute' }, { name: 'eventName' }, { name: 'customEvent:ad_click_id' }, { name: 'customEvent:ref_code' },
  ],
  metricHeaders: [{ name: 'eventCount' }],
  rows: [
    { dimensionValues: [{ value: '202611051120' }, { value: 'text_message_click' }, { value: 'gRef' }, { value: 'K7QM' }], metricValues: [{ value: '1' }] },
    { dimensionValues: [{ value: '202611051130' }, { value: 'phone_call_click' }, { value: 'gCall' }, { value: '(not set)' }], metricValues: [{ value: '1' }] },
    { dimensionValues: [{ value: '202611051140' }, { value: 'phone_call_click' }, { value: '(not set)' }, { value: '(not set)' }], metricValues: [{ value: '1' }] },
    { dimensionValues: [{ value: '202611051158' }, { value: 'phone_call_click' }, { value: 'gTooNew' }, { value: '(not set)' }], metricValues: [{ value: '1' }] },
  ],
  rowCount: 4,
};

function makeDeps(redis = fakeRedis()) {
  const conv = (p: string, created: string) => ({ id: p, phoneNumberId: 'PN', participants: [p], lastActivityAt: created, createdAt: created, updatedAt: created });
  const messages: Record<string, unknown[]> = {
    '+16175550001': [{ id: 'm1', from: '+16175550001', to: [], text: "I'd like a free quote. (Ref: K7QM)", phoneNumberId: 'PN', direction: 'incoming', status: 'delivered', createdAt: '2026-11-05T16:21:00Z', updatedAt: '' }],
    '+16175550002': [],
  };
  const calls: Record<string, unknown[]> = {
    '+16175550001': [],
    '+16175550002': [{ id: 'c1', from: '+16175550002', to: '', phoneNumberId: 'PN', direction: 'incoming', status: 'completed', duration: 240, createdAt: '2026-11-05T16:31:10Z' }],
  };
  const upload = vi.fn(async (_d: unknown[], _e: unknown[], _o?: { validateOnly?: boolean }) => ({ requestId: 'req-1' }));
  const deps: AdsConversionsDeps = {
    ga: { runReport: async () => report },
    quo: {
      listConversations: async () => ({ data: [conv('+16175550001', '2026-11-05T16:21:00Z'), conv('+16175550002', '2026-11-05T16:31:10Z'), conv('+16176681677', '2026-11-05T16:00:00Z')] }),
      listMessages: async ({ participantE164 }) => ({ data: (messages[participantE164] ?? []) as never }),
      listCalls: async ({ participantE164 }) => ({ data: (calls[participantE164] ?? []) as never }),
    },
    qb: {
      listAllCustomers: async () => [{ Id: '77', DisplayName: 'A', PrimaryPhone: { FreeFormNumber: '(617) 555-0002' } } as never],
      getEstimatesByCustomer: async () => [
        { Id: 'e1', SyncToken: '0', CustomerRef: { value: '77' }, Line: [], TotalAmt: 1175, EmailStatus: 'EmailSent', MetaData: { CreateTime: '2026-11-05T16:50:00Z' } } as never,
      ],
      getInvoicesByCustomer: async () => [],
    },
    ads: {
      listConversionActions: async () => [
        { resourceName: 'ca/1', id: '1', name: 'AAC Real lead', type: 'UPLOAD_CLICKS', status: 'ENABLED' },
        { resourceName: 'ca/2', id: '2', name: 'AAC Quote sent', type: 'UPLOAD_CLICKS', status: 'ENABLED' },
        { resourceName: 'ca/3', id: '3', name: 'AAC Won job', type: 'UPLOAD_CLICKS', status: 'ENABLED' },
      ],
    },
    dataManager: { ingestEvents: upload },
    adsAccount: { customerId: '4683607368', loginCustomerId: '9448392141' },
    redis,
    ownLine: '+16176681677',
    now: () => NOW.getTime(),
    log: () => {},
  };
  return { deps, redis, upload };
}

describe('parseTaps', () => {
  it('reads Eastern minutes and drops taps without a gclid', () => {
    const taps = parseTaps(report);
    expect(taps.map((t) => [t.at.toISOString(), t.gclid, t.kind, t.refCode])).toEqual([
      ['2026-11-05T16:20:00.000Z', 'gRef', 'text', 'K7QM'],
      ['2026-11-05T16:30:00.000Z', 'gCall', 'call', null],
      ['2026-11-05T16:58:00.000Z', 'gTooNew', 'call', null],
    ]);
  });
});

describe('runAdsConversions', () => {
  it('live: matches by ref and timing, uploads stages once', async () => {
    const { deps, redis, upload } = makeDeps();
    const s = await runAdsConversions(deps, { mode: 'live' });
    expect(s).toMatchObject({ taps: 3, newMatches: 2, matchedByRef: 1, matchedByTiming: 1, uploaded: 3 });
    expect(s.pending).toEqual({ lead: 2, quote: 1, won: 0 });
    const [dests, events, o] = upload.mock.calls[0] as [
      Array<{ reference: string; conversionActionId: string; operatingAccountId: string }>,
      Array<{ transactionId: string; gclid: string; destinationReferences: string[]; conversionValue?: number }>,
      { validateOnly: boolean },
    ];
    expect(dests.map((d) => [d.reference, d.conversionActionId, d.operatingAccountId])).toEqual([
      ['lead', '1', '4683607368'],
      ['quote', '2', '4683607368'],
      ['won', '3', '4683607368'],
    ]);
    expect(events.map((c) => [c.transactionId, c.gclid, c.destinationReferences[0], c.conversionValue]).sort()).toEqual([
      ['lead:6175550001', 'gRef', 'lead', undefined],
      ['lead:6175550002', 'gCall', 'lead', undefined],
      ['quote:6175550002', 'gCall', 'quote', 1175],
    ]);
    expect(o).toEqual({ validateOnly: false });
    expect(s.requestId).toBe('req-1');
    expect(redis.data.get(keys.cronLastRun('ads-conversions'))).toBe(NOW.toISOString());

    const again = await runAdsConversions(deps, { mode: 'live' });
    expect(again).toMatchObject({ newMatches: 0, uploaded: 0, trackedClicks: 2 });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('dry: validateOnly, nothing marked sent', async () => {
    const { deps, redis, upload } = makeDeps();
    const s = await runAdsConversions(deps, { mode: 'dry' });
    expect(upload.mock.calls[0][2]).toEqual({ validateOnly: true });
    expect(s.uploaded).toBe(0);
    expect(redis.data.get(keys.adsConversionsSent)).toBeUndefined();
    expect(redis.data.get(keys.adsClicks)).toBeUndefined();
    expect(s.newMatches).toBe(2);
  });

  it('skips the upload when the actions do not exist yet', async () => {
    const { deps, redis, upload } = makeDeps();
    deps.ads.listConversionActions = async () => [];
    const s = await runAdsConversions(deps, { mode: 'live' });
    expect(s.skipped).toMatch(/conversion actions missing/);
    expect(upload).not.toHaveBeenCalled();
    // A skip is not a run: the watchdog's last-run stamp stays put.
    expect(redis.data.get(keys.cronLastRun('ads-conversions'))).toBeUndefined();
  });

  it('drops events the API names as invalid and retries the rest once', async () => {
    const { deps, redis, upload } = makeDeps();
    upload.mockRejectedValueOnce(new Error('Data Manager ingest error 400: field events.events[0].adIdentifiers.gclid invalid'));
    const s = await runAdsConversions(deps, { mode: 'live' });
    expect(upload).toHaveBeenCalledTimes(2);
    expect((upload.mock.calls[1][1] as unknown[]).length).toBe(2);
    expect(s.failed).toHaveLength(1);
    expect(s.uploaded).toBe(2);
    expect((redis.data.get(keys.adsConversionsSent) as Set<string>).size).toBe(2);
    // One bad event is a data problem, not a dead job: still stamped.
    expect(redis.data.get(keys.cronLastRun('ads-conversions'))).toBe(NOW.toISOString());
  });

  it('marks nothing sent when the whole request fails', async () => {
    const { deps, redis, upload } = makeDeps();
    upload.mockRejectedValueOnce(new Error('Data Manager ingest error 403: API not enabled'));
    const s = await runAdsConversions(deps, { mode: 'live' });
    expect(s.failed[0].orderId).toBe('*');
    expect(s.uploaded).toBe(0);
    expect(redis.data.get(keys.adsConversionsSent)).toBeUndefined();
    expect(redis.data.get(keys.cronLastRun('ads-conversions'))).toBeUndefined();
  });

  it('a QBO error on one click is recorded and the rest still upload', async () => {
    const { deps, upload } = makeDeps();
    deps.qb.getEstimatesByCustomer = async () => {
      throw new Error('QuickBooks API error: 429');
    };
    const s = await runAdsConversions(deps, { mode: 'live' });
    expect(s.failed).toEqual([{ orderId: 'click:6175550002', error: 'QuickBooks API error: 429' }]);
    expect(s.uploaded).toBe(1); // the ref-matched lead (no QBO customer)
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('off does nothing', async () => {
    const { deps, upload } = makeDeps();
    expect((await runAdsConversions(deps, { mode: 'off' })).skipped).toBe('off');
    expect(upload).not.toHaveBeenCalled();
  });
});
