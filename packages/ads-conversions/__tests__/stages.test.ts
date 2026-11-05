import { describe, it, expect } from 'vitest';
import type { QBEstimate, QBInvoice } from '@aac/api-clients/quickbooks';
import { stagesFor, realLeadAt, type AdClick } from '../src/index.js';

const click: AdClick = {
  phone: '6175550001', gclid: 'g1', tapAt: '2026-10-01T15:00:00.000Z', matchedBy: 'timing', contactAt: '2026-10-01T15:01:00.000Z',
};
const NOW = new Date('2026-11-05T12:00:00Z');
const est = (create: string, extra: Partial<QBEstimate> = {}): QBEstimate =>
  ({ Id: 'e1', SyncToken: '0', CustomerRef: { value: '1' }, Line: [], TotalAmt: 1175, MetaData: { CreateTime: create }, ...extra }) as QBEstimate;
const inv = (create: string, total: number): QBInvoice =>
  ({ Id: 'i1', SyncToken: '0', CustomerRef: { value: '1' }, Line: [], TotalAmt: total, MetaData: { CreateTime: create } }) as QBInvoice;

describe('realLeadAt', () => {
  it('counts a job-word text, a photo, a 60s call, or a voicemail', () => {
    const msg = (at: string, text: string, hasMedia = false) => ({ at: new Date(at), direction: 'incoming' as const, text, hasMedia });
    expect(realLeadAt(click, [msg('2026-10-01T15:02:00Z', 'hi')], [])).toBeNull();
    expect(realLeadAt(click, [msg('2026-10-01T15:02:00Z', 'crack in my basement wall')], [])?.toISOString()).toBe('2026-10-01T15:02:00.000Z');
    expect(realLeadAt(click, [msg('2026-10-01T15:03:00Z', '', true)], [])).not.toBeNull();
    expect(realLeadAt(click, [], [{ at: new Date('2026-10-01T15:01:00Z'), direction: 'incoming', durationSec: 45, voicemail: false }])).toBeNull();
    expect(realLeadAt(click, [], [{ at: new Date('2026-10-01T15:01:00Z'), direction: 'incoming', durationSec: 0, voicemail: true }])).not.toBeNull();
  });
  it('ignores opt-outs and anything after 14 days', () => {
    const msg = (at: string, text: string) => ({ at: new Date(at), direction: 'incoming' as const, text, hasMedia: false });
    expect(realLeadAt(click, [msg('2026-10-01T15:02:00Z', 'STOP texting me about cracks')], [])).toBeNull();
    expect(realLeadAt(click, [msg('2026-10-20T15:02:00Z', 'crack')], [])).toBeNull();
  });
});

describe('stagesFor', () => {
  const none = { messages: [], calls: [] };

  it('emits lead + quote + won with values and stable orderIds', () => {
    const hits = stagesFor(
      click,
      none,
      [est('2026-10-03T14:00:00Z', { EmailStatus: 'EmailSent' }), est('2026-10-02T14:00:00Z', { TxnStatus: 'Pending' })],
      [inv('2026-10-20T14:00:00Z', 1350)],
      NOW,
    );
    expect(hits.map((h) => [h.stage, h.orderId, h.at.toISOString(), h.value])).toEqual([
      ['lead', 'lead:6175550001', '2026-10-03T14:00:00.000Z', undefined],
      ['quote', 'quote:6175550001', '2026-10-03T14:00:00.000Z', 1175],
      ['won', 'won:6175550001', '2026-10-20T14:00:00.000Z', 1350],
    ]);
  });

  it('a bot draft that was never sent is not a quote', () => {
    expect(stagesFor(click, none, [est('2026-10-03T14:00:00Z', { TxnStatus: 'Pending' })], [], NOW)).toEqual([]);
  });

  it('no lead for a returning customer, but new quotes still count', () => {
    const hits = stagesFor(
      click,
      none,
      [est('2025-06-01T14:00:00Z', { TxnStatus: 'Closed' }), est('2026-10-03T14:00:00Z', { EmailStatus: 'EmailSent' })],
      [],
      NOW,
    );
    expect(hits.map((h) => h.stage)).toEqual(['quote']);
  });

  it('clamps a same-day quote to after the tap', () => {
    const hits = stagesFor(click, none, [est('2026-10-01T13:00:00Z', { EmailStatus: 'EmailSent' })], [], NOW);
    expect(hits[1].at.toISOString()).toBe('2026-10-01T15:01:00.000Z');
  });
});
