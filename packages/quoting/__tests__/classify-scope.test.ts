import { describe, it, expect } from 'vitest';
import { classifyScope, isWarrantyLine } from '../src/classify-scope.js';

// Sample line descriptions taken from the 2026-05-29 spike dataset so the
// classifier behavior stays anchored to real AAC estimate text.

const WARRANTY_LINE = `all crack injection repairs performed by attack a crack are backed by our lifetime transferable guarantee. this guarantee remains in effect for the life of the home and automatically transfers to all future homeowners. our guarantee covers both the crack repair itself and any damage resulting from a faulty or failed repair, including but not limited to: drywall, studs, flooring, trim, paint, cabinetry, plumbing, electrical, mechanical systems (e.g., furnace), and the removal/replacement of affected materials. in such an event, attack a crack will cover the full cost of labor and materials necessary to restore the property. this guarantee does not extend to other cracks, leaks, or sources of water not repaired by attack a crack, unless the issue can be directly traced to our work. hic license #214356 thank you for trusting attack a crack with your foundation repair needs.`;

const MIXED_WARRANTY_LINE = `all crack injection repairs performed by attack a crack are backed by our lifetime transferable guarantee. all other work, including but not limited to concrete resurfacing, slab patching, and masonry repair, is covered by a standard 2-year warranty on materials and workmanship. hic license #214356 thank you for trusting attack a crack with your foundation repair needs.`;

const CRACK_INJECTION_LINE = `urethane resin injection. inject high-grade hydrophobic urethane resin into the crack using a compressor and 95 lbs of air pressure. force resin to penetrate the entire thickness of the foundation wall. apply a 100% rubber elastomeric membrane over the repaired crack on the interior surface.`;

const RESURFACING_LINE = `mechanically clean the wall surface. repair any significant spalls, voids, or cracks prior to resurfacing. apply a commercial-grade polymer-modified cement resurfacing mix evenly over the wall surface. finish to a consistent texture and profile.`;

const STAIR_RESURFACING_LINE = `rebuild chipped and broken edges on stair treads and risers using high-strength repair mortar. apply commercial-grade hydraulic cement resurfacer over the entire stair set. work material into surface to achieve uniform coverage and a durable finish.`;

const CARBON_FIBER_LINE = `install carbon fiber stapling across diagonal crack to provide structural reinforcement. epoxy-bond carbon fiber straps to the foundation wall.`;

const FLOOR_CRACK_EPOXY_LINE = `clean and prepare floor cracks for treatment. apply two-part epoxy fill to floor cracks; level to match surrounding floor surface.`;

const MASONRY_REPOINT_LINE = `chip out failing mortar joints in fieldstone foundation wall. repoint joints using type-S masonry mortar. brick repair as needed on adjacent face.`;

const EXTERIOR_EXCAVATION_LINE = `excavate exterior of foundation wall to expose existing waterproofing membrane. inspect and repair membrane.`;

describe('isWarrantyLine', () => {
  it('flags the standard injection-only warranty boilerplate', () => {
    expect(isWarrantyLine(WARRANTY_LINE)).toBe(true);
  });

  it('flags the mixed warranty boilerplate (the one that caused false positives)', () => {
    expect(isWarrantyLine(MIXED_WARRANTY_LINE)).toBe(true);
  });

  it('does not flag a real scope line', () => {
    expect(isWarrantyLine(CRACK_INJECTION_LINE)).toBe(false);
    expect(isWarrantyLine(RESURFACING_LINE)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isWarrantyLine(WARRANTY_LINE.toUpperCase())).toBe(true);
  });
});

describe('classifyScope — warranty stripping', () => {
  it('strips warranty boilerplate before pattern matching', () => {
    const result = classifyScope([CRACK_INJECTION_LINE, WARRANTY_LINE]);
    expect(result.warrantyLinesStripped).toBe(1);
    expect(result.category).toBe('crack_injection');
  });

  it('mixed-warranty boilerplate alone does not produce a mixed classification', () => {
    // This was the bug from the spike: warranty text mentions "concrete
    // resurfacing" inside a "crack injection" template. Pre-strip, scope
    // is empty → should classify as 'other', not 'mixed'.
    const result = classifyScope([MIXED_WARRANTY_LINE]);
    expect(result.warrantyLinesStripped).toBe(1);
    expect(result.category).toBe('other');
    expect(result.crackSignals).toEqual([]);
    expect(result.concreteSignals).toEqual([]);
  });

  it('crack-injection + mixed-warranty stays crack_injection', () => {
    const result = classifyScope([CRACK_INJECTION_LINE, MIXED_WARRANTY_LINE]);
    expect(result.category).toBe('crack_injection');
  });
});

describe('classifyScope — crack injection', () => {
  it('detects urethane, injection, and membrane signals', () => {
    const result = classifyScope([CRACK_INJECTION_LINE]);
    expect(result.category).toBe('crack_injection');
    expect(result.crackSignals).toContain('urethane');
    expect(result.crackSignals).toContain('inject');
    expect(result.crackSignals).toContain('membrane');
    expect(result.hasMembrane).toBe(true);
    expect(result.hasCarbonFiber).toBe(false);
  });

  it('detects carbon fiber stapling and flags hasCarbonFiber', () => {
    const result = classifyScope([CRACK_INJECTION_LINE, CARBON_FIBER_LINE]);
    expect(result.category).toBe('crack_injection');
    expect(result.hasCarbonFiber).toBe(true);
  });

  it('detects isInterior from "interior surface" in scope', () => {
    const result = classifyScope([CRACK_INJECTION_LINE]);
    expect(result.isInterior).toBe(true);
    expect(result.isExterior).toBe(false);
  });

  it('detects isExterior from excavation language', () => {
    const result = classifyScope([CRACK_INJECTION_LINE, EXTERIOR_EXCAVATION_LINE]);
    expect(result.isExterior).toBe(true);
  });
});

describe('classifyScope — concrete resurfacing (Matt\'s broad taxonomy)', () => {
  it('detects wall resurfacing', () => {
    const result = classifyScope([RESURFACING_LINE]);
    expect(result.category).toBe('concrete_resurfacing');
    expect(result.concreteSignals).toContain('resurfac');
    expect(result.concreteSignals).toContain('spall');
  });

  it('detects stair resurfacing (stair treads, stair set, etc.)', () => {
    const result = classifyScope([STAIR_RESURFACING_LINE]);
    expect(result.category).toBe('concrete_resurfacing');
    expect(result.concreteSignals).toContain('stair');
    expect(result.concreteSignals).toContain('resurfac');
  });

  it('floor cracks (even with epoxy) classify as resurfacing per Matt', () => {
    const result = classifyScope([FLOOR_CRACK_EPOXY_LINE]);
    expect(result.category).toBe('concrete_resurfacing');
    expect(result.concreteSignals).toContain('floor_crack');
    expect(result.concreteSignals).toContain('floor_epoxy');
  });

  it('masonry/repointing/fieldstone classifies as resurfacing per Matt', () => {
    const result = classifyScope([MASONRY_REPOINT_LINE]);
    expect(result.category).toBe('concrete_resurfacing');
    expect(result.concreteSignals).toContain('repoint');
    expect(result.concreteSignals).toContain('fieldstone');
    expect(result.concreteSignals).toContain('masonry');
  });

  it('carbon-fiber-only (no real crack signal) co-occurring with resurfacing → resurfacing', () => {
    // Per Matt: carbon fiber is an add-on, not its own category. If it
    // co-occurs ONLY with resurfacing signals (no urethane/inject/membrane),
    // the dominant work is resurfacing.
    const result = classifyScope([CARBON_FIBER_LINE, RESURFACING_LINE]);
    expect(result.category).toBe('concrete_resurfacing');
    expect(result.hasCarbonFiber).toBe(true);
  });
});

describe('classifyScope — mixed', () => {
  it('genuine injection + resurfacing → mixed', () => {
    const result = classifyScope([CRACK_INJECTION_LINE, RESURFACING_LINE]);
    expect(result.category).toBe('mixed');
    expect(result.crackSignals.length).toBeGreaterThan(0);
    expect(result.concreteSignals.length).toBeGreaterThan(0);
  });
});

describe('classifyScope — other / default-to-resurfacing', () => {
  it('empty descriptions → other', () => {
    expect(classifyScope([]).category).toBe('other');
  });

  it('discount-only short line → other', () => {
    const result = classifyScope(['10% discount']);
    expect(result.category).toBe('other');
  });

  it('substantial unmatched scope defaults to concrete_resurfacing per Matt', () => {
    // Per Matt's "default to resurfacing" rule: when no signals fire but
    // the descriptions have real content, treat as resurfacing.
    const longUnmatched = 'A '.repeat(50) + 'substantial scope with no specific keywords matched.';
    const result = classifyScope([longUnmatched]);
    expect(result.category).toBe('concrete_resurfacing');
  });
});

describe('classifyScope — output shape', () => {
  it('counts warrantyLinesStripped accurately', () => {
    const result = classifyScope([WARRANTY_LINE, CRACK_INJECTION_LINE, MIXED_WARRANTY_LINE]);
    expect(result.warrantyLinesStripped).toBe(2);
  });

  it('isMultiCrack detects multiple cracks language', () => {
    expect(classifyScope(['inject 3 cracks in foundation']).isMultiCrack).toBe(true);
    expect(classifyScope(['inject multiple cracks']).isMultiCrack).toBe(true);
    expect(classifyScope([CRACK_INJECTION_LINE]).isMultiCrack).toBe(false);
  });
});
