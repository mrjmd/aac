import { describe, it, expect } from 'vitest';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import { diffDraftLines, buildDraftCreatedNote, buildDraftUpdatedNote, qboEstimateLink } from '../src/draft-notes';

const prev = {
  Id: '900', SyncToken: '1', DocNumber: '1570', TxnStatus: 'Pending',
  CustomerRef: { value: '42' }, TotalAmt: 2350,
  Line: [
    { Amount: 2350, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '7', name: 'Crack Repair' }, Qty: 2, UnitPrice: 1175 } },
    { Amount: 0, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '12', name: 'Guarantee' }, Qty: 1, UnitPrice: 0 } },
  ],
} as unknown as QBEstimate;

describe('diffDraftLines', () => {
  it('reports adds, changes, and removals against the previous draft', () => {
    const changes = diffDraftLines(prev, [
      { item: 'Crack Repair', qty: 3, unitPrice: 1175 },
      { item: 'Sewer Inlet Injection', qty: 1, unitPrice: 775 },
    ]);
    expect(changes).toContain('~ Crack Repair: ×2 @ $1175 → ×3 @ $1175');
    expect(changes).toContain('+ Sewer Inlet Injection ×1 @ $775');
    expect(changes).toContain('− Guarantee removed');
  });

  it('empty when nothing changed', () => {
    expect(diffDraftLines(prev, [
      { item: 'Crack Repair', qty: 2, unitPrice: 1175 },
      { item: 'Guarantee', qty: 1, unitPrice: 0 },
    ])).toEqual([]);
  });
});

describe('note builders', () => {
  it('created note carries lines, confidence, and the QBO link', () => {
    const n = buildDraftCreatedNote({
      docNumber: '1571', estimateId: '901', total: 1175,
      confidence: 'high', needsSiteVisit: false,
      lines: [{ item: 'Crack Repair', qty: 1, unitPrice: 1175 }],
    });
    expect(n).toContain('#1571 created — $1175 (high confidence)');
    expect(n).toContain('• Crack Repair ×1 @ $1175');
    expect(n).toContain(qboEstimateLink('901'));
  });

  it('updated note leads with the delta and lists changes', () => {
    const n = buildDraftUpdatedNote({
      docNumber: '1570', estimateId: '900', total: 3125, previousTotal: 2350,
      changes: ['+ Sewer Inlet Injection ×1 @ $775'],
    });
    expect(n).toContain('UPDATED — $3125 (was $2350)');
    expect(n).toContain('+ Sewer Inlet Injection');
    expect(n).toContain('txnId=900');
  });
});
