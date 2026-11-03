import { describe, it, expect } from 'vitest';
import { fromAwaitingQuote, fromBotDraft, fromFollowupDraft, fromFunnelFlag, fromInvoiceNudge } from '../src/index.js';

const awaiting = {
  doc: '1561',
  customer: 'Ben Arnaud',
  phone: '+17815550123',
  amount: 2350,
  channel: 'text',
  lastInboundAt: '2026-10-28T14:00:00Z',
  daysWaiting: 6,
  snippet: 'Does the warranty transfer?',
};

describe('fromAwaitingQuote', () => {
  it('is a sales needs-you item, red at 14+ days', () => {
    const c = fromAwaitingQuote(awaiting);
    expect(c).toMatchObject({ key: 'aw:1561', area: 'sales', lane: 'needs-you', severity: 'yellow', amount: 2350 });
    expect(fromAwaitingQuote({ ...awaiting, daysWaiting: 14 }).severity).toBe('red');
  });
  it('fingerprint ignores age but changes on a newer inbound message', () => {
    const a = fromAwaitingQuote(awaiting).fingerprint;
    expect(fromAwaitingQuote({ ...awaiting, daysWaiting: 9 }).fingerprint).toBe(a);
    expect(fromAwaitingQuote({ ...awaiting, lastInboundAt: '2026-11-02T10:00:00Z' }).fingerprint).not.toBe(a);
  });
});

describe('fromFollowupDraft', () => {
  it('goes to the confirm lane with the draft text', () => {
    const c = fromFollowupDraft(
      { doc: '1590', customer: 'Sam Okafor', phone: '+1', amount: 900, ageDays: 4, tier: 't1', draft: 'Hi Sam', whyNow: 'Day 4.', queuedAt: '2026-11-02T12:00:00Z' },
      true,
    );
    expect(c).toMatchObject({ key: 'fup:1590', lane: 'confirm', severity: 'yellow', detail: '"Hi Sam"' });
    expect(c.evidence).toContain('not sent yet');
  });
});

describe('fromFunnelFlag', () => {
  it('skips capacity holds', () => {
    expect(fromFunnelFlag({ kind: 'capacity-hold', doc: '1', customer: 'X', amount: 1, detail: '' })).toBeNull();
    expect(fromFunnelFlag({ kind: 'flip-accepted', doc: '2', customer: 'Y', amount: 5, detail: 'd' })?.severity).toBe('yellow');
  });
});

describe('fromBotDraft', () => {
  const row = { at: '2026-11-01T10:00:00Z', trigger: 'T1', phone: '+1', outcome: 'created', createdDoc: '1594', total: 1175 };
  it('created drafts are confirm-lane items keyed by doc', () => {
    expect(fromBotDraft(row)).toMatchObject({ key: 'qd:1594', lane: 'confirm', amount: 1175 });
  });
  it('failures need Matt; skips are not items', () => {
    expect(fromBotDraft({ ...row, outcome: 'draft-failed' })?.lane).toBe('needs-you');
    expect(fromBotDraft({ ...row, outcome: 'skipped' })).toBeNull();
  });
});

describe('fromInvoiceNudge', () => {
  const n = {
    invoiceId: '2368',
    doc: '2368',
    customer: 'Emanuel Markis',
    balance: 7800,
    dueDate: '2026-07-03',
    daysOverdue: 123,
    next: { kind: 'reminder' as const, label: 'QBO reminder email', day: 7 },
    behind: 3,
    history: [],
  };
  it('takes over the D3 key, is a money item, and says how far behind', () => {
    const c = fromInvoiceNudge(n);
    expect(c).toMatchObject({ key: 'd3:2368', area: 'money', sensitive: 'money', severity: 'yellow', amount: 7800 });
    expect(c.detail).toContain('3 steps behind');
  });
  it('a new rung or a payment reopens it; age does not', () => {
    const f = fromInvoiceNudge(n).fingerprint;
    expect(fromInvoiceNudge({ ...n, daysOverdue: 130 }).fingerprint).toBe(f);
    expect(fromInvoiceNudge({ ...n, next: { kind: 'call', label: 'Phone call', day: 30 } }).fingerprint).not.toBe(f);
    expect(fromInvoiceNudge({ ...n, balance: 3900 }).fingerprint).not.toBe(f);
  });
});
