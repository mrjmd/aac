import { describe, expect, it, vi } from 'vitest';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import {
  leakValue,
  openRows,
  parseVerdict,
  renderThread,
  runLeadLeaks,
  settledPhones,
  threadFacts,
  type CachedVerdict,
  type LeadLeakDeps,
  type LeakRow,
} from '../src/index.js';

const PHONE = '+16175550101';
const msg = (direction: 'incoming' | 'outgoing', createdAt: string, text: string, photos = 0): QuoMessage => ({
  id: `m-${createdAt}`,
  to: [],
  from: '',
  text,
  phoneNumberId: 'PN1',
  direction,
  status: 'delivered',
  createdAt,
  updatedAt: createdAt,
  ...(photos ? { media: Array.from({ length: photos }, () => ({ url: 'u', type: 'image/jpeg' })) } : {}),
});
const call = (direction: 'incoming' | 'outgoing', createdAt: string, status: QuoCall['status'], duration = 0, voicemail = false): QuoCall => ({
  id: `c-${createdAt}`,
  to: '',
  from: '',
  phoneNumberId: 'PN1',
  direction,
  status,
  duration,
  voicemail: voicemail ? { url: 'v' } : null,
  createdAt,
});

describe('threadFacts', () => {
  it('reads who spoke last, photos and the last thing they sent', () => {
    const f = threadFacts(
      [msg('incoming', '2026-10-05T14:00:00Z', 'can u look at my basement floor?', 3), msg('outgoing', '2026-10-05T14:01:00Z', 'Sorry we missed you')],
      [],
    )!;
    expect(f.lastWho).toBe('us');
    expect(f.photos).toBe(3);
    expect(f.lastText).toBe('can u look at my basement floor? + 3 photos');
    expect(f.missedOnly).toBe(false);
  });

  it('flags missed calls with nothing else', () => {
    const f = threadFacts([msg('outgoing', '2026-11-06T15:01:00Z', 'Sorry we missed your call')], [call('incoming', '2026-11-06T15:00:00Z', 'missed')])!;
    expect(f.missedOnly).toBe(true);
    expect(f.lastText).toBe('missed call');
    expect(f.lastWho).toBe('them');
    expect(f.lastAt).toBe('2026-11-06T15:00:00Z');
  });

  it('a text two minutes after a missed call is Matt replying, not the auto-text', () => {
    const f = threadFacts([msg('outgoing', '2026-11-06T15:02:00Z', 'Hey, saw your call, what can I help with?')], [call('incoming', '2026-11-06T15:00:00Z', 'missed')])!;
    expect(f.missedOnly).toBe(false);
  });

  it('a voicemail or a talked call is not a bare missed call', () => {
    expect(threadFacts([], [call('incoming', '2026-11-06T15:00:00Z', 'completed', 30, true)])!.missedOnly).toBe(false);
    expect(threadFacts([], [call('incoming', '2026-11-06T15:00:00Z', 'missed'), call('outgoing', '2026-11-06T16:00:00Z', 'completed', 200)])!.missedOnly).toBe(false);
  });

  it('is null with nothing from them', () => {
    expect(threadFacts([msg('outgoing', '2026-11-06T15:00:00Z', 'hi')], [])).toBeNull();
  });
});

describe('renderThread', () => {
  it('orders texts and calls and inlines transcripts and voicemails', () => {
    const out = renderThread(
      [msg('incoming', '2026-10-17T13:00:00Z', 'photos attached', 2)],
      [call('outgoing', '2026-10-17T14:00:00Z', 'completed', 420), call('incoming', '2026-10-18T14:00:00Z', 'completed', 20, true)],
      { 'c-2026-10-17T14:00:00Z': ['US: about $900 for the window crack', 'THEM: sounds reasonable'] },
      { 'c-2026-10-18T14:00:00Z': 'please send the quote' },
    );
    expect(out.split('\n')[0]).toBe('[2026-10-17 13:00Z] THEM: photos attached [2 photos]');
    expect(out).toContain('WE called, talked 7 min');
    expect(out).toContain('      THEM: sounds reasonable');
    expect(out).toContain('voicemail: please send the quote');
  });
});

describe('parseVerdict', () => {
  it('keeps a valid answer', () => {
    const v = parseVerdict({ status: 'no_quote', exclude: null, name: 'Kyle Kelly', askedFor: 'window crack', whyStuck: 'sent info Oct 14', scope: 'crack' });
    expect(v).toEqual({ status: 'no_quote', exclude: null, name: 'Kyle Kelly', askedFor: 'window crack', whyStuck: 'sent info Oct 14', scope: 'crack' });
  });

  it('turns an off-schema answer into excluded/other, never a leak', () => {
    const v = parseVerdict({ status: 'maybe', scope: 'roof' });
    expect(v.status).toBe('excluded');
    expect(v.exclude).toBe('other');
    expect(v.scope).toBe('unknown');
    expect(parseVerdict(null).status).toBe('excluded');
  });

  it('an unknown exclude reason becomes other', () => {
    expect(parseVerdict({ status: 'excluded', exclude: 'spam' }).exclude).toBe('other');
  });
});

describe('leakValue', () => {
  it('known scope = ticket × win rate', () => {
    expect(leakValue('no_quote', 'crack', false).value).toBe(Math.round(1175 * 0.542));
  });
  it('unknown scope = standard lead; assessed = average job × win rate', () => {
    expect(leakValue('no_reply', 'unknown', false).value).toBe(842);
    expect(leakValue('assessed', 'unknown', false).value).toBe(Math.round(2073 * 0.542));
  });
  it('a bare missed call is a quarter lead', () => {
    expect(leakValue('no_reply', 'unknown', true).value).toBe(211);
  });
});

describe('openRows', () => {
  const row = { phone: PHONE, lastActivityAt: '2026-11-01T00:00:00Z' } as LeakRow;
  it('hides a handled row until the thread moves', () => {
    expect(openRows([row], { [PHONE]: '2026-11-01T00:00:00Z' })).toEqual([]);
    expect(openRows([row], { [PHONE]: '2026-10-01T00:00:00Z' })).toEqual([row]);
    expect(openRows([row], null)).toEqual([row]);
  });
});

describe('settledPhones', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const ev = (colorId: string, start: string, description: string): CalendarEvent => ({
    id: start,
    summary: 'x',
    description,
    start,
    end: start,
    colorId,
    attendees: [],
    htmlLink: '',
    attachments: [],
  });
  it('quoted by a QBO estimate in the window, booked by a job, assessed by a past assessment', () => {
    const r = settledPhones({
      customers: [
        { Id: '1', DisplayName: 'A', PrimaryPhone: { FreeFormNumber: '(617) 555-0101' } },
        { Id: '2', DisplayName: 'B', Mobile: { FreeFormNumber: '617-555-0102' } },
      ],
      estimates: [
        { CustomerRef: { value: '1' }, TxnDate: '2026-10-01' },
        { CustomerRef: { value: '2' }, TxnDate: '2026-01-01' },
      ],
      events: [ev('10', '2026-11-20T13:00:00Z', 'Phone: 617-555-0103'), ev('3', '2026-10-20T13:00:00Z', 'Phone: 617-555-0104'), ev('3', '2026-11-20T13:00:00Z', '617-555-0105')],
      since: '2026-08-09T00:00:00Z',
      now,
    });
    expect([...r.quoted]).toEqual(['+16175550101']);
    expect(r.booked.has('+16175550103')).toBe(true);
    expect(r.booked.has('+16175550105')).toBe(true);
    expect(r.assessedOn.get('+16175550104')).toBe('2026-10-20');
    expect(r.booked.has('+16175550104')).toBe(false);
  });

  it('settles by name when the phone differs: a booked event title or a quoted customer', () => {
    const r = settledPhones({
      customers: [{ Id: '1', DisplayName: 'Kate Chun', PrimaryPhone: { FreeFormNumber: '617-555-0199' } }],
      estimates: [{ CustomerRef: { value: '1' }, TxnDate: '2026-10-01' }],
      events: [ev('10', '2026-11-12T13:00:00Z', 'no phone here')].map((e) => ({ ...e, summary: 'Jeanette George' })),
      since: '2026-08-09T00:00:00Z',
      now,
    });
    expect(r.settledName('Jeanette George')).toBe(true);
    expect(r.settledName('Kate Chun')).toBe(true);
    expect(r.settledName('Jeanette')).toBe(false);
    expect(r.settledName(null)).toBe(false);
    expect(r.settledName('Peter Eleey')).toBe(false);
  });
});

describe('runLeadLeaks', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  function deps(over: { cache?: Record<string, CachedVerdict>; answer?: unknown } = {}) {
    const hashes: Record<string, Record<string, unknown>> = { v: { ...(over.cache ?? {}) } };
    const saved: Record<string, string> = {};
    const generateJson = vi.fn().mockResolvedValue(
      over.answer ?? { status: 'no_quote', exclude: null, name: 'Peter', askedFor: 'seal a small area', whyStuck: 'never got a reply', scope: 'crack' },
    );
    const listMessages = vi.fn().mockResolvedValue({ data: [msg('incoming', '2026-10-06T14:00:00Z', 'seal and reface the problem area', 4)] });
    const d: LeadLeakDeps = {
      redis: {
        hgetall: async <T,>(k: string) => (hashes[k] ?? null) as T | null,
        hset: async (k, kv) => {
          hashes[k] = { ...(hashes[k] ?? {}), ...kv };
          return 1;
        },
        set: async (k, v) => {
          saved[k] = v;
          return 'OK';
        },
      },
      quo: {
        listConversations: vi.fn().mockResolvedValue({
          data: [
            { id: 'a', phoneNumberId: 'PN1', participants: [PHONE], lastActivityAt: '2026-10-06T14:00:00Z', createdAt: '', updatedAt: '' },
            { id: 'b', phoneNumberId: 'PN1', participants: ['+16175550102'], lastActivityAt: '2026-10-06T14:00:00Z', createdAt: '', updatedAt: '' },
            { id: 'c', phoneNumberId: 'PN1', participants: ['+16177660151'], lastActivityAt: '2026-10-06T14:00:00Z', createdAt: '', updatedAt: '' },
          ],
        }),
        listMessages,
        listCalls: vi.fn().mockResolvedValue({ data: [] }),
        getCallTranscript: vi.fn(),
        getCallVoicemail: vi.fn(),
      } as unknown as LeadLeakDeps['quo'],
      qb: {
        listAllCustomers: vi.fn().mockResolvedValue([{ Id: '2', DisplayName: 'Quoted', Mobile: { FreeFormNumber: '6175550102' } }]),
        listEstimatesUpdatedSince: vi.fn().mockResolvedValue([{ CustomerRef: { value: '2' }, TxnDate: '2026-10-07' }]),
      } as unknown as LeadLeakDeps['qb'],
      calendar: { listEvents: vi.fn().mockResolvedValue([]) },
      gemini: { generateJson } as unknown as LeadLeakDeps['gemini'],
      ownLine: '+16176681677',
      keys: { snapshot: 's', verdicts: 'v' },
    };
    return { d, hashes, saved, generateJson, listMessages };
  }

  it('skips quoted and internal phones, reads the rest, values and saves the row', async () => {
    const { d, saved, generateJson, hashes } = deps();
    const snap = await runLeadLeaks(d, { now, deadlineMs: Date.now() + 60_000 });
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(snap.counts.quoted_or_booked).toBe(1);
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]).toMatchObject({ phone: PHONE, stage: 'no_quote', name: 'Peter', photos: 4, value: Math.round(1175 * 0.542) });
    expect(JSON.parse(saved.s!).rows).toHaveLength(1);
    expect((hashes.v![PHONE] as CachedVerdict).lastActivityAt).toBe('2026-10-06T14:00:00Z');
  });

  it('reuses a cached read while the thread has not moved, without touching Quo or the model', async () => {
    const first = deps();
    await runLeadLeaks(first.d, { now, deadlineMs: Date.now() + 60_000 });
    const again = deps({ cache: first.hashes.v as Record<string, CachedVerdict> });
    const snap = await runLeadLeaks(again.d, { now, deadlineMs: Date.now() + 60_000 });
    expect(again.generateJson).not.toHaveBeenCalled();
    expect(again.listMessages).not.toHaveBeenCalled();
    expect(snap.rows).toHaveLength(1);
  });

  it('a bare missed call is a lead for a week, then phone tag', async () => {
    const run = async (at: string) => {
      const x = deps();
      (x.d.quo.listConversations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ id: 'a', phoneNumberId: 'PN1', participants: [PHONE], lastActivityAt: at, createdAt: '', updatedAt: '' }],
      });
      x.listMessages.mockResolvedValue({ data: [] });
      (x.d.quo.listCalls as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [call('incoming', at, 'missed')] });
      const snap = await runLeadLeaks(x.d, { now, deadlineMs: Date.now() + 60_000 });
      expect(x.generateJson).not.toHaveBeenCalled();
      return snap;
    };
    const fresh = await run('2026-11-05T14:00:00Z');
    expect(fresh.rows[0]).toMatchObject({ stage: 'no_reply', value: 211 });
    const old = await run('2026-10-20T14:00:00Z');
    expect(old.rows).toEqual([]);
    expect(old.counts.phone_tag).toBe(1);
  });

  it('counts a solicitation instead of listing it', async () => {
    const { d } = deps({ answer: { status: 'excluded', exclude: 'solicitation', name: null, askedFor: 'sell SEO', whyStuck: 'vendor', scope: 'unknown' } });
    const snap = await runLeadLeaks(d, { now, deadlineMs: Date.now() + 60_000 });
    expect(snap.rows).toEqual([]);
    expect(snap.counts.solicitation).toBe(1);
  });

  it('a past deadline reads nothing new and says so', async () => {
    const { d, generateJson } = deps();
    const snap = await runLeadLeaks(d, { now, deadlineMs: Date.now() - 1 });
    expect(generateJson).not.toHaveBeenCalled();
    expect(snap.partial).toBe(true);
    expect(snap.gaps.join(' ')).toContain('Ran out of time');
  });
});
