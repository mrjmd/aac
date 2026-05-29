import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeQbApproval } from '../src/normalize-qb-approval.js';
import type { NormalizerDeps } from '../src/types.js';
import type {
  QBCustomer,
  QBEstimate,
  QBEstimateStatus,
} from '@aac/api-clients/quickbooks';
import type { PipedrivePerson } from '@aac/api-clients/pipedrive';

// ── fixtures ──────────────────────────────────────────────────────

function makeEstimate(overrides: Partial<QBEstimate> = {}): QBEstimate {
  return {
    Id: '1234',
    SyncToken: '0',
    TxnStatus: 'Accepted' satisfies QBEstimateStatus,
    CustomerRef: { value: 'cust-99', name: 'Smith, John' },
    Line: [
      { Description: 'Foundation crack repair (3 cracks)', Amount: 1200, DetailType: 'SalesItemLineDetail' },
      { Description: 'Sealant + epoxy', Amount: 300, DetailType: 'SalesItemLineDetail' },
    ],
    TotalAmt: 1500,
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<QBCustomer> = {}): QBCustomer {
  return {
    Id: 'cust-99',
    DisplayName: 'Smith, John',
    PrimaryPhone: { FreeFormNumber: '(617) 555-0123' },
    ...overrides,
  };
}

function makePerson(overrides: Partial<PipedrivePerson> = {}): PipedrivePerson {
  return {
    id: 9001,
    name: 'John Smith',
    phone: [{ value: '+16175550123', primary: true, label: 'work' }],
    email: [],
    ...overrides,
  } as PipedrivePerson;
}

function makeDeps(overrides: Partial<NormalizerDeps> = {}): NormalizerDeps {
  return {
    qb: { getCustomer: vi.fn().mockResolvedValue(makeCustomer()) },
    pd: { searchPersonByPhone: vi.fn().mockResolvedValue(makePerson()) },
    quo: {},
    newId: () => '01HQTEST',
    now: () => new Date('2026-05-29T15:00:00.000Z'),
    ...overrides,
  } as unknown as NormalizerDeps;
}

// ── tests ─────────────────────────────────────────────────────────

describe('normalizeQbApproval', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when estimate is not Accepted', async () => {
    const deps = makeDeps();
    const directive = await normalizeQbApproval(deps, {
      estimate: makeEstimate({ TxnStatus: 'Pending' }),
    });
    expect(directive).toBeNull();
  });

  it('returns null for Rejected/Converted/Closed', async () => {
    const deps = makeDeps();
    for (const status of ['Rejected', 'Converted', 'Closed'] as QBEstimateStatus[]) {
      expect(
        await normalizeQbApproval(deps, { estimate: makeEstimate({ TxnStatus: status }) }),
      ).toBeNull();
    }
  });

  it('produces a well-formed QuoteApprovedDirective on Accepted', async () => {
    const deps = makeDeps();
    const directive = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(directive).not.toBeNull();
    expect(directive!.intent).toBe('quote_approved');
    expect(directive!.eventClass).toBe('job');
    expect(directive!.source).toBe('qb_webhook');
    expect(directive!.qbCustomerId).toBe('cust-99');
    expect(directive!.qbEstimateId).toBe('1234');
    expect(directive!.customerPhone).toBe('+16175550123');
    expect(directive!.pdPersonId).toBe(9001);
    expect(directive!.estimatedDurationHours).toBeNull(); // Crawl
    expect(directive!.id).toBe('01HQTEST');
    expect(directive!.createdAt).toBe('2026-05-29T15:00:00.000Z');
  });

  it('builds scope summary from line item descriptions', async () => {
    const deps = makeDeps();
    const directive = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(directive!.scopeSummary).toBe(
      'Smith, John — Foundation crack repair (3 cracks); Sealant + epoxy',
    );
  });

  it('handles estimate with empty line descriptions', async () => {
    const deps = makeDeps();
    const directive = await normalizeQbApproval(deps, {
      estimate: makeEstimate({
        Line: [{ Description: undefined, Amount: 100, DetailType: 'SalesItemLineDetail' }],
      }),
    });
    expect(directive!.scopeSummary).toBe('Smith, John — (no line-item descriptions)');
  });

  it('keeps customerPhone empty when QB customer has no phone', async () => {
    const deps = makeDeps({
      qb: { getCustomer: vi.fn().mockResolvedValue(makeCustomer({ PrimaryPhone: undefined })) },
    } as unknown as Partial<NormalizerDeps>);
    const directive = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(directive!.customerPhone).toBe('');
    expect(directive!.pdPersonId).toBeUndefined();
    expect(directive!.confidence.signals).not.toContain('customer_phone_normalized');
  });

  it('omits pdPersonId when no PD match', async () => {
    const deps = makeDeps({
      pd: { searchPersonByPhone: vi.fn().mockResolvedValue(null) },
    } as unknown as Partial<NormalizerDeps>);
    const directive = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(directive!.pdPersonId).toBeUndefined();
    expect(directive!.confidence.signals).not.toContain('matching_pd_person_found');
  });

  it('reconciliation source omits webhook signal and lowers score', async () => {
    const deps = makeDeps();
    const webhook = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    const reconciliation = await normalizeQbApproval(deps, {
      estimate: makeEstimate(),
      source: 'qb_reconciliation',
    });
    expect(webhook!.confidence.signals).toContain('qb_webhook_signature_verified');
    expect(reconciliation!.confidence.signals).toContain('qb_reconciliation_backstop');
    expect(reconciliation!.confidence.signals).not.toContain('qb_webhook_signature_verified');
    expect(reconciliation!.confidence.score).toBeLessThan(webhook!.confidence.score);
    expect(reconciliation!.source).toBe('qb_reconciliation');
  });

  it('confidence score is bounded to [0, 1]', async () => {
    const deps = makeDeps();
    const directive = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(directive!.confidence.score).toBeGreaterThan(0);
    expect(directive!.confidence.score).toBeLessThanOrEqual(1);
  });

  it('directive is JSON-roundtrip safe', async () => {
    const deps = makeDeps();
    const directive = await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(JSON.parse(JSON.stringify(directive))).toEqual(directive);
  });

  it('does not call PD lookup when QB customer phone is missing', async () => {
    const pdSearch = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      qb: { getCustomer: vi.fn().mockResolvedValue(makeCustomer({ PrimaryPhone: undefined })) },
      pd: { searchPersonByPhone: pdSearch },
    } as unknown as Partial<NormalizerDeps>);
    await normalizeQbApproval(deps, { estimate: makeEstimate() });
    expect(pdSearch).not.toHaveBeenCalled();
  });
});
