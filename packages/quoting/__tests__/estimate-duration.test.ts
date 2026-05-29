import { describe, it, expect } from 'vitest';
import type { QBEstimate, QBLine } from '@aac/api-clients/quickbooks';
import { estimateDuration } from '../src/estimate-duration.js';

// Fixtures derived from the 2026-05-29 spike dataset so predictions
// stay anchored to real classifier behavior.

const CRACK_INJECTION_DESC = `preparation & access. mechanically clean the foundation crack. drill injection ports. urethane resin injection. inject high-grade hydrophobic urethane resin into the crack using a compressor. apply a 100% rubber elastomeric membrane over the repaired crack on the interior surface.`;

const RESURFACING_DESC = `mechanically clean the wall surface. repair any significant spalls, voids, or cracks prior to resurfacing. apply a commercial-grade polymer-modified cement resurfacing mix evenly over the wall surface.`;

const WARRANTY_DESC = `all crack injection repairs performed by attack a crack are backed by our lifetime transferable guarantee. hic license #214356 thank you for trusting attack a crack with your foundation repair needs.`;

function line(description: string, amount: number): QBLine {
  return { Description: description, Amount: amount, DetailType: 'SalesItemLineDetail' };
}

function makeEstimate(overrides: Partial<QBEstimate> = {}): QBEstimate {
  return {
    Id: '1234',
    SyncToken: '0',
    CustomerRef: { value: 'cust-99', name: 'Test Customer' },
    Line: [line(CRACK_INJECTION_DESC, 1500), line(WARRANTY_DESC, 0)],
    TotalAmt: 1500,
    ...overrides,
  };
}

describe('estimateDuration — happy path (crack injection $1-2k cluster)', () => {
  it('returns a high-confidence prediction with non-null point/p25/p75', () => {
    const result = estimateDuration(makeEstimate());
    expect(result.category).toBe('crack_injection');
    expect(result.point).not.toBeNull();
    expect(result.p25).not.toBeNull();
    expect(result.p75).not.toBeNull();
    expect(result.p25!).toBeLessThanOrEqual(result.point!);
    expect(result.point!).toBeLessThanOrEqual(result.p75!);
    // n=17 cluster in the 2026-05-29 dataset, cv=0.11 → high confidence
    expect(result.confidence).toBe('high');
  });

  it('signals reflect the classification', () => {
    const result = estimateDuration(makeEstimate());
    expect(result.signals.isCrackInjection).toBe(true);
    expect(result.signals.isConcreteResurfacing).toBe(false);
    expect(result.signals.hasMembrane).toBe(true);
    expect(result.signals.totalAmt).toBe(1500);
    expect(result.signals.lineCount).toBe(2);
  });

  it('returns up to 5 similar past cases', () => {
    const result = estimateDuration(makeEstimate());
    expect(result.similar.length).toBeGreaterThan(0);
    expect(result.similar.length).toBeLessThanOrEqual(5);
    expect(result.similar[0].distance).toBeLessThanOrEqual(result.similar.at(-1)!.distance);
  });

  it('rationale mentions cluster size, median, and confidence', () => {
    const result = estimateDuration(makeEstimate());
    expect(result.rationale).toMatch(/Crack injection/);
    expect(result.rationale).toMatch(/\$1,500/);
    expect(result.rationale).toMatch(/median/);
    expect(result.rationale).toMatch(/high/i);
  });
});

describe('estimateDuration — concrete resurfacing', () => {
  it('classifies and predicts for a resurfacing scope', () => {
    const result = estimateDuration({
      ...makeEstimate({ TotalAmt: 800 }),
      Line: [line(RESURFACING_DESC, 800), line(WARRANTY_DESC, 0)],
    });
    expect(result.category).toBe('concrete_resurfacing');
    expect(result.signals.isConcreteResurfacing).toBe(true);
    expect(result.signals.isCrackInjection).toBe(false);
    expect(result.point).not.toBeNull();
  });
});

describe('estimateDuration — fallback when cluster is empty', () => {
  it('falls back to adjacent dollar band, marks confidence none', () => {
    // 50k crack injection — no cluster exists at 10k+ in the dataset.
    const result = estimateDuration({
      ...makeEstimate({ TotalAmt: 50_000 }),
      Line: [line(CRACK_INJECTION_DESC, 50_000)],
    });
    expect(result.category).toBe('crack_injection');
    // Still returns a prediction from the nearest cluster (5-10k or below)
    expect(result.point).not.toBeNull();
    // But confidence is 'none' because we used a fallback cluster
    expect(result.confidence).toBe('none');
  });
});

describe('estimateDuration — other / unclassified', () => {
  it('returns null point + rationale flagging the unknown', () => {
    const result = estimateDuration({
      ...makeEstimate({ TotalAmt: 50 }),
      Line: [line('10% loyalty discount', 50)],
    });
    expect(result.category).toBe('other');
    expect(result.point).toBeNull();
    expect(result.p25).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.rationale).toMatch(/Unclassified|expand the classifier/i);
  });
});

describe('estimateDuration — multi-day defaults (v1)', () => {
  it('isMultiDay defaults to false in v1', () => {
    const result = estimateDuration(makeEstimate());
    expect(result.isMultiDay).toBe(false);
    expect(result.workdayCount).toBeNull();
  });
});

describe('estimateDuration — invariants', () => {
  it('prediction is JSON-roundtrip safe', () => {
    const result = estimateDuration(makeEstimate());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('handles estimate with empty Line array', () => {
    const result = estimateDuration({
      ...makeEstimate({ TotalAmt: 0 }),
      Line: [],
    });
    expect(result.category).toBe('other');
    expect(result.point).toBeNull();
  });

  it('handles missing TotalAmt as $0', () => {
    const result = estimateDuration({
      Id: '999',
      SyncToken: '0',
      CustomerRef: { value: 'x', name: 'x' },
      Line: [line(CRACK_INJECTION_DESC, 0)],
    });
    expect(result.signals.totalAmt).toBe(0);
    // Lands in 0-1k band, still classifies as crack_injection
    expect(result.category).toBe('crack_injection');
  });

  it('p25 ≤ point ≤ p75 for every non-null prediction', () => {
    const fixtures: QBEstimate[] = [
      makeEstimate({ TotalAmt: 500 }),
      makeEstimate({ TotalAmt: 1500 }),
      makeEstimate({ TotalAmt: 3000 }),
      { ...makeEstimate({ TotalAmt: 800 }), Line: [line(RESURFACING_DESC, 800)] },
    ];
    for (const est of fixtures) {
      const r = estimateDuration(est);
      if (r.point !== null && r.p25 !== null && r.p75 !== null) {
        expect(r.p25).toBeLessThanOrEqual(r.point);
        expect(r.point).toBeLessThanOrEqual(r.p75);
      }
    }
  });
});
