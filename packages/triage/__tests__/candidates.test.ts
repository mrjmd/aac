import { describe, it, expect } from 'vitest';
import type { ItemRedis } from '@aac/items';
import { keys } from '@aac/shared-utils/redis';
import {
  botDraftRows,
  parseDraftLabels,
  publishTriageItems,
  triageCandidates,
  type FindingsFile,
  type StaleQuoteLists,
} from '../src/index.js';

const NOW = new Date('2026-11-05T15:00:00Z').getTime();
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function findings(overrides: Partial<FindingsFile> = {}): FindingsFile {
  return {
    generatedAt: iso(NOW),
    snapshotAt: iso(NOW),
    findings: [],
    pulse: {} as FindingsFile['pulse'],
    stats: {},
    ...overrides,
  };
}

const empty: StaleQuoteLists = { queue: null, awaiting: null };

function drafterRow(at: number, docNumber: string, phone = '+16175550100'): Record<string, unknown> {
  return { at: iso(at), trigger: 'quote_promised', phone, mode: 'live', record: { outcome: 'created', docNumber, total: 1175 } };
}

describe('botDraftRows', () => {
  it('keeps the last 7 days of worker + legacy rows, oldest first, dropping no-trigger legacy rows', () => {
    const rows = botDraftRows(
      [drafterRow(NOW - DAY, '1001'), drafterRow(NOW - 8 * DAY, '1000'), { at: iso(NOW), trigger: 'none' }],
      NOW,
      [
        { at: iso(NOW - 2 * DAY), trigger: 't', phone: 'p', outcome: 'created', gate: { label: 'l', wouldAutoCreate: true } },
        { at: iso(NOW - 2 * DAY), outcome: 'no-trigger' },
      ],
    );
    expect(rows.map((r) => [r.at, r.outcome])).toEqual([
      [iso(NOW - 2 * DAY), 'created'],
      [iso(NOW - DAY), 'created'],
    ]);
    expect(rows[1]).toMatchObject({ createdDoc: '1001', gate: { label: 'worker · live', wouldAutoCreate: true } });
  });
});

describe('triageCandidates', () => {
  it('drops bot drafts the owner already handled when labels are passed, keeps all without labels', () => {
    const data = findings({ quoteDrafterRunlog: [drafterRow(NOW - DAY, '1001'), drafterRow(NOW - DAY + 1, '1002', '+16175550101')] });
    const labels = parseDraftLabels(
      [
        JSON.stringify({ docNumber: '1001', estimateId: 'e1', customer: 'Ann', state: 'owner-edited' }),
        JSON.stringify({ docNumber: '1002', estimateId: 'e2', customer: 'Bob', state: 'untouched' }),
      ].join('\n'),
    );
    const withLabels = triageCandidates(data, empty, { now: NOW, labels });
    expect(withLabels.map((c) => c.customer)).toEqual(['Bob']);
    expect(triageCandidates(data, empty, { now: NOW })).toHaveLength(2);
  });

  it('skips internal numbers and stamps the identity cluster', () => {
    const data = findings({
      findings: [
        { id: 'a', section: 'conversation', severity: 'red', title: 'A', phone: '+16175550100', source: 'D1' },
        { id: 'b', section: 'conversation', severity: 'red', title: 'B', phone: '+16177660151', source: 'D1' },
      ],
      contactClusters: { '+16175550100': 'cluster-1' },
    });
    const out = triageCandidates(data, empty, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]?.who?.cluster).toBe('cluster-1');
  });

  it('hides awaiting quotes for customers booked since their last inbound', () => {
    const entry = { doc: '1', customer: 'Cy', phone: '+16175550102', amount: 1, channel: 'text', lastInboundAt: iso(NOW - DAY), daysWaiting: 1, snippet: '' };
    const stale: StaleQuoteLists = { queue: null, awaiting: { generatedAt: iso(NOW), entries: [entry] } };
    expect(triageCandidates(findings(), stale, { now: NOW }).map((c) => c.key)).toEqual(['aw:1']);
    const booked = findings({ booked: [{ phones: [entry.phone], emails: [], qboIds: [], event: 'ev', start: iso(NOW + DAY), createdAt: iso(NOW) }] });
    expect(triageCandidates(booked, stale, { now: NOW })).toEqual([]);
  });
});

describe('publishTriageItems', () => {
  it('writes the snapshot to keys.itemCandidates', async () => {
    const writes: Array<[string, unknown]> = [];
    const redis = { set: async (k: string, v: unknown) => writes.push([k, v]) } as unknown as ItemRedis;
    await publishTriageItems({ redis }, { at: 'x', source: 'triage-worker', candidates: [] });
    expect(writes).toEqual([[keys.itemCandidates, { at: 'x', source: 'triage-worker', candidates: [] }]]);
  });
});
