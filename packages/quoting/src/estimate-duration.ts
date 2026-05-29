/**
 * estimateDuration — given a QB Estimate, return a duration prediction
 * the scheduling agent can reason from.
 *
 * Per `docs/projects/duration-heuristic-design.md` and `docs/DECISIONS.md`
 * entry 2026-05-29: this is a variance surface, not a flat lookup. The
 * caller gets a point estimate AND a range AND similar past cases AND a
 * confidence label, then decides how to use them.
 *
 * Reference dataset is the static JSON shipped at
 * `packages/quoting/data/duration-reference-<DATE>.json`. Regenerated
 * manually via `tools/src/scratch/generate-duration-reference.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import { classifyScope, type ScopeCategory } from './classify-scope.js';

// ── Reference dataset shape (matches the generator output) ────────

const REFERENCE_FILE = 'duration-reference-2026-05-29.json';

type DollarBandId = '0-1k' | '1-2k' | '2-5k' | '5-10k' | '10k+';

interface ReferenceCase {
  customerToken: string;
  totalAmt: number;
  lineCount: number;
  durationHours: number;
  category: ScopeCategory;
  dollarBand: DollarBandId;
  hasCarbonFiber: boolean;
  hasMembrane: boolean;
  isMultiCrack: boolean;
  isInterior: boolean;
  isExterior: boolean;
  scopeSnippet: string;
}

interface ClusterStats {
  category: ScopeCategory;
  dollarBand: DollarBandId;
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  cv: number;
  categoryN: number;
}

interface ReferenceDataset {
  generated: string;
  sourceSpike: string;
  windowDays: number;
  durationFloorHours: number;
  counts: { sourcePairs: number; reliablePairs: number; filteredUnreliable: number };
  cases: ReferenceCase[];
  clusters: ClusterStats[];
}

const DATASET: ReferenceDataset = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../data/${REFERENCE_FILE}`, import.meta.url)), 'utf8'),
);

// ── Public types ──────────────────────────────────────────────────

export type DurationConfidence = 'high' | 'moderate' | 'low' | 'none';

export interface ScopeSignals {
  isCrackInjection: boolean;
  isConcreteResurfacing: boolean;
  hasCarbonFiber: boolean;
  hasMembrane: boolean;
  isMultiCrack: boolean;
  isExterior: boolean;
  isInterior: boolean;
  lineCount: number;
  totalAmt: number;
}

export interface SimilarCase {
  customerToken: string;
  totalAmt: number;
  lineCount: number;
  durationHours: number;
  category: ScopeCategory;
  scopeSnippet: string;
  /** 0 = identical, 1 = very different. Lower = more similar. */
  distance: number;
}

export interface DurationPrediction {
  /** Point estimate (cluster median). Null when no usable data. */
  point: number | null;
  /** Range. Use the customer-facing layer to translate into a tight window. */
  p25: number | null;
  p75: number | null;
  /** Spread signal — high cv means the point is unreliable. */
  cv: number;
  confidence: DurationConfidence;
  category: ScopeCategory;
  signals: ScopeSignals;
  rationale: string;
  similar: SimilarCase[];
  /** v1 default: false. Future v2 will detect from estimate features. */
  isMultiDay: boolean;
  workdayCount: number | null;
}

// ── Dollar bands (must match the generator's bands) ───────────────

const DOLLAR_BANDS: ReadonlyArray<{ id: DollarBandId; min: number; max: number }> = [
  { id: '0-1k', min: 0, max: 1000 },
  { id: '1-2k', min: 1000, max: 2000 },
  { id: '2-5k', min: 2000, max: 5000 },
  { id: '5-10k', min: 5000, max: 10_000 },
  { id: '10k+', min: 10_000, max: Number.POSITIVE_INFINITY },
];

function bandFor(totalAmt: number): DollarBandId {
  for (const b of DOLLAR_BANDS) {
    if (totalAmt >= b.min && totalAmt < b.max) return b.id;
  }
  return '10k+';
}

// ── Confidence rules ──────────────────────────────────────────────
//   high:     n ≥ 10 AND cv ≤ 0.25
//   moderate: n ≥ 5  AND cv ≤ 0.40
//   low:      n ≥ 2
//   none:     no cluster match (or 1-case cluster — treated as none here
//             because a single case can't establish variance)

function confidenceFor(cluster: ClusterStats | undefined): DurationConfidence {
  if (!cluster) return 'none';
  if (cluster.n >= 10 && cluster.cv <= 0.25) return 'high';
  if (cluster.n >= 5 && cluster.cv <= 0.4) return 'moderate';
  if (cluster.n >= 2) return 'low';
  return 'none';
}

// ── Similar-case scoring ──────────────────────────────────────────
//   +3 same category
//   +2 same dollar band
//   +1 line-count within ±1
//   +1 per matching boolean signal (carbon fiber, membrane, multi-crack)
// Max possible: 3 + 2 + 1 + 3 = 9. Distance = 1 - score/9.

function scoreSimilarity(
  c: ReferenceCase,
  category: ScopeCategory,
  band: DollarBandId,
  signals: ScopeSignals,
): number {
  let s = 0;
  if (c.category === category) s += 3;
  if (c.dollarBand === band) s += 2;
  if (Math.abs(c.lineCount - signals.lineCount) <= 1) s += 1;
  if (c.hasCarbonFiber === signals.hasCarbonFiber && signals.hasCarbonFiber) s += 1;
  if (c.hasMembrane === signals.hasMembrane && signals.hasMembrane) s += 1;
  if (c.isMultiCrack === signals.isMultiCrack && signals.isMultiCrack) s += 1;
  return s;
}

const MAX_SIMILAR = 5;
const MAX_SIMILAR_SCORE = 9;

function findSimilar(
  category: ScopeCategory,
  band: DollarBandId,
  signals: ScopeSignals,
): SimilarCase[] {
  const scored = DATASET.cases.map((c) => ({
    c,
    score: scoreSimilarity(c, category, band, signals),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SIMILAR).map(({ c, score }) => ({
    customerToken: c.customerToken,
    totalAmt: c.totalAmt,
    lineCount: c.lineCount,
    durationHours: c.durationHours,
    category: c.category,
    scopeSnippet: c.scopeSnippet,
    distance: Math.round((1 - score / MAX_SIMILAR_SCORE) * 100) / 100,
  }));
}

// ── Rationale builder ─────────────────────────────────────────────

function buildRationale(args: {
  category: ScopeCategory;
  totalAmt: number;
  signals: ScopeSignals;
  cluster: ClusterStats | undefined;
  similar: SimilarCase[];
  confidence: DurationConfidence;
}): string {
  const { category, totalAmt, signals, cluster, similar, confidence } = args;
  const dollarStr = `$${totalAmt.toLocaleString('en-US')}`;
  const featureBits: string[] = [];
  if (signals.hasMembrane) featureBits.push('membrane finish');
  if (signals.hasCarbonFiber) featureBits.push('carbon fiber reinforcement');
  if (signals.isMultiCrack) featureBits.push('multiple cracks');
  if (signals.isExterior) featureBits.push('exterior excavation');
  const featureStr = featureBits.length > 0 ? ` (${featureBits.join(', ')})` : '';

  if (!cluster) {
    return `${formatCategory(category)} at ${dollarStr}${featureStr}. No matching reference cluster — falling back to similar-case reasoning.`;
  }

  const closest = similar[0];
  const closestStr = closest
    ? ` Closest example: ${closest.customerToken}, $${closest.totalAmt.toLocaleString('en-US')}, ${closest.durationHours}h.`
    : '';

  return `${formatCategory(category)} at ${dollarStr}${featureStr}. Cluster of ${cluster.n} similar past job${cluster.n === 1 ? '' : 's'} ranged ${cluster.p25}–${cluster.p75}h (median ${cluster.median}h, cv=${cluster.cv}).${closestStr} Confidence: ${confidence}.`;
}

function formatCategory(c: ScopeCategory): string {
  switch (c) {
    case 'crack_injection': return 'Crack injection';
    case 'concrete_resurfacing': return 'Concrete resurfacing';
    case 'mixed': return 'Mixed (injection + resurfacing)';
    case 'other': return 'Unclassified scope';
  }
}

// ── Public entry point ────────────────────────────────────────────

export function estimateDuration(estimate: QBEstimate): DurationPrediction {
  const descriptions = estimate.Line
    .map((l) => l.Description)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
  const totalAmt = estimate.TotalAmt ?? 0;
  const lineCount = estimate.Line.length;

  const classification = classifyScope(descriptions);
  const { category } = classification;

  const signals: ScopeSignals = {
    isCrackInjection: category === 'crack_injection' || category === 'mixed',
    isConcreteResurfacing: category === 'concrete_resurfacing' || category === 'mixed',
    hasCarbonFiber: classification.hasCarbonFiber,
    hasMembrane: classification.hasMembrane,
    isMultiCrack: classification.isMultiCrack,
    isExterior: classification.isExterior,
    isInterior: classification.isInterior,
    lineCount,
    totalAmt,
  };

  const band = bandFor(totalAmt);
  const cluster = DATASET.clusters.find(
    (c) => c.category === category && c.dollarBand === band,
  );

  // Per design doc question 5: when no cluster matches and category is
  // 'other', return null point with rationale flagging the unknown to Matt.
  if (category === 'other') {
    return {
      point: null,
      p25: null,
      p75: null,
      cv: 0,
      confidence: 'none',
      category,
      signals,
      rationale: `Unclassified scope at $${totalAmt.toLocaleString('en-US')} — no signals matched. Surface to Matt for ad-hoc resolution or to expand the classifier keyword set.`,
      similar: findSimilar(category, band, signals),
      isMultiDay: false,
      workdayCount: null,
    };
  }

  const confidence = confidenceFor(cluster);
  const similar = findSimilar(category, band, signals);

  // Fallback when the (category × band) cluster is empty: degrade to
  // category-wide stats via the closest non-empty cluster.
  const fallbackCluster = cluster ?? findFallbackCluster(category, band);

  return {
    point: fallbackCluster?.median ?? null,
    p25: fallbackCluster?.p25 ?? null,
    p75: fallbackCluster?.p75 ?? null,
    cv: fallbackCluster?.cv ?? 0,
    confidence: cluster ? confidence : 'none',
    category,
    signals,
    rationale: buildRationale({
      category,
      totalAmt,
      signals,
      cluster: fallbackCluster,
      similar,
      confidence: cluster ? confidence : 'none',
    }),
    similar,
    isMultiDay: false,
    workdayCount: null,
  };
}

function findFallbackCluster(
  category: ScopeCategory,
  band: DollarBandId,
): ClusterStats | undefined {
  const inCat = DATASET.clusters.filter((c) => c.category === category);
  if (inCat.length === 0) return undefined;
  const bandIndex = DOLLAR_BANDS.findIndex((b) => b.id === band);
  // Pick the nearest band by index distance, ties broken by larger n.
  return inCat
    .map((c) => ({
      c,
      idxDist: Math.abs(DOLLAR_BANDS.findIndex((b) => b.id === c.dollarBand) - bandIndex),
    }))
    .sort((a, b) => a.idxDist - b.idxDist || b.c.n - a.c.n)[0]?.c;
}
