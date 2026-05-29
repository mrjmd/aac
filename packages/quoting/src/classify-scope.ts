/**
 * classifyScope — categorize an AAC estimate's line-item descriptions
 * into Matt's 2-category service taxonomy.
 *
 * Lifted from `tools/src/scratch/reclassify-and-drill.ts` after the
 * 2026-05-29 duration-analysis spike. See
 * `docs/projects/duration-heuristic-design.md` for the design discussion
 * and `docs/DECISIONS.md` for the "variance over hard rules" reasoning.
 *
 * Pure function. No I/O, no side effects.
 */

export type ScopeCategory =
  | 'crack_injection'
  | 'concrete_resurfacing'
  | 'mixed'
  | 'other';

export interface ScopeClassification {
  category: ScopeCategory;

  /** Crack-injection signal tokens that fired (e.g., 'urethane', 'inject'). */
  crackSignals: string[];

  /** Concrete-resurfacing signal tokens that fired. */
  concreteSignals: string[];

  /** Number of warranty/guarantee boilerplate lines stripped before matching. */
  warrantyLinesStripped: number;

  /** Carbon fiber stapling — structural reinforcement add-on to injection. */
  hasCarbonFiber: boolean;

  /** Waterproof elastomeric membrane finish — add-on to crack injection. */
  hasMembrane: boolean;

  /** "Multiple cracks" / 2+ cracks mentioned in scope. */
  isMultiCrack: boolean;

  /** Interior work mentioned (basement-side membrane, interior wall, etc.). */
  isInterior: boolean;

  /** Exterior work mentioned (excavation, exterior dig, etc.). */
  isExterior: boolean;
}

// ── Warranty boilerplate stripper ──────────────────────────────────
// AAC estimates include a templated guarantee line that mentions BOTH
// "crack injection" and "concrete resurfacing" in the same paragraph.
// Without stripping, this produces false-positive 'mixed' classifications
// across the dataset. Filter the boilerplate before pattern matching.

const WARRANTY_MARKERS: readonly string[] = [
  'lifetime transferable guarantee',
  'this guarantee',
  'hic license',
  'thank you for trusting attack a crack',
  'covered by a standard 2-year warranty',
];

export function isWarrantyLine(desc: string): boolean {
  const d = desc.toLowerCase();
  return WARRANTY_MARKERS.some((m) => d.includes(m));
}

function stripWarrantyLines(descriptions: readonly string[]): string[] {
  return descriptions.filter((d) => !isWarrantyLine(d));
}

// ── Signal patterns ────────────────────────────────────────────────
// Matt's taxonomy (2026-05-29):
//   - Two services: crack_injection and concrete_resurfacing.
//   - Concrete resurfacing is BROAD: includes masonry, repointing,
//     fieldstone, skim coat, brick repair, floor cracks (even epoxy).
//   - Carbon fiber stapling is "almost always an add-on to injection"
//     — flagged separately, not its own category.
//   - When no signals fire but real scope exists, default to resurfacing.

const FLOOR_CRACK_RE = /\bfloor[\s-]*crack/;
const FLOOR_EPOXY_RE = /\bfloor\b.*\bepoxy\b|\bepoxy\b.*\bfloor\b/;
const STEP_RE = /\bstep(s)?\b/;

function detectCrackSignals(all: string): string[] {
  const hits: string[] = [];
  if (/urethane/.test(all)) hits.push('urethane');
  if (/\binject(ion)?/.test(all)) hits.push('inject');
  if (/\bmembrane\b/.test(all)) hits.push('membrane');
  if (/carbon fiber/.test(all)) hits.push('carbon_fiber');
  return hits;
}

function detectConcreteSignals(all: string, crackHits: readonly string[]): string[] {
  const hits: string[] = [];
  if (/resurfac/.test(all)) hits.push('resurfac');
  if (/overlay/.test(all)) hits.push('overlay');
  if (/spall/.test(all)) hits.push('spall');
  if (/driveway/.test(all)) hits.push('driveway');
  if (/stairway/.test(all)) hits.push('stairway');
  if (/garage/.test(all)) hits.push('garage');
  if (/walkway/.test(all)) hits.push('walkway');
  if (/\bpatio\b/.test(all)) hits.push('patio');
  if (STEP_RE.test(all)) hits.push('step');
  if (/\bstair (resurfac|repair|tread|set)/.test(all)) hits.push('stair');
  if (FLOOR_CRACK_RE.test(all)) hits.push('floor_crack');
  if (/\brepoint/.test(all)) hits.push('repoint');
  if (/fieldstone/.test(all)) hits.push('fieldstone');
  if (/masonry/.test(all)) hits.push('masonry');
  if (/brick repair/.test(all)) hits.push('brick_repair');
  if (/skim coat/.test(all)) hits.push('skim_coat');
  if (
    /wall surface/.test(all) &&
    !crackHits.includes('inject') &&
    !crackHits.includes('urethane')
  ) {
    hits.push('wall_surface_prep');
  }
  if (FLOOR_EPOXY_RE.test(all)) hits.push('floor_epoxy');

  // "Floor" without any real crack-injection signal → resurfacing
  if (
    /\bfloor\b/.test(all) &&
    !crackHits.includes('urethane') &&
    !crackHits.includes('inject') &&
    !crackHits.includes('membrane')
  ) {
    hits.push('floor_only');
  }
  return hits;
}

// ── Threshold below which an empty-signal description is treated as
// "other" (empty / discount-only) rather than defaulted to resurfacing.
const REAL_SCOPE_MIN_CHARS = 80;

export function classifyScope(descriptions: readonly string[]): ScopeClassification {
  const before = descriptions.length;
  const scoped = stripWarrantyLines(descriptions);
  const warrantyLinesStripped = before - scoped.length;
  const all = scoped.map((d) => d.toLowerCase()).join(' \n ');

  const crackSignals = detectCrackSignals(all);
  const concreteSignals = detectConcreteSignals(all, crackSignals);

  let category: ScopeCategory;
  if (crackSignals.length > 0 && concreteSignals.length > 0) {
    // Carbon fiber alone alongside resurfacing → still resurfacing
    // (carbon fiber is an add-on, not a category). Only a "real" crack
    // signal (urethane / inject / membrane) co-occurring with concrete
    // signals counts as genuinely mixed work.
    const hasRealCrackSignal = crackSignals.some((h) => h !== 'carbon_fiber');
    category = hasRealCrackSignal ? 'mixed' : 'concrete_resurfacing';
  } else if (crackSignals.length > 0) {
    category = 'crack_injection';
  } else if (concreteSignals.length > 0) {
    category = 'concrete_resurfacing';
  } else {
    const totalLen = scoped.reduce((acc, d) => acc + d.length, 0);
    category = totalLen >= REAL_SCOPE_MIN_CHARS ? 'concrete_resurfacing' : 'other';
  }

  return {
    category,
    crackSignals,
    concreteSignals,
    warrantyLinesStripped,
    hasCarbonFiber: crackSignals.includes('carbon_fiber'),
    hasMembrane: crackSignals.includes('membrane'),
    isMultiCrack: /\b(\d+\s+cracks|multiple cracks|two cracks|three cracks)\b/.test(all),
    isInterior: /\binterior\b/.test(all),
    isExterior: /\bexterior\b/.test(all) || /\bexcavat/.test(all),
  };
}
