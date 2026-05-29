# `@aac/quoting/estimate-duration` — Design Sketch

**Status:** Codified 2026-05-29.
- `packages/quoting/src/classify-scope.ts` + tests (22 passing).
- `packages/quoting/data/duration-reference-2026-05-29.json` (54 reliable cases, 12 clusters).
- `packages/quoting/src/estimate-duration.ts` + tests (12 passing).
- Wired into `packages/scheduling/src/normalize-qb-approval.ts` — directives now carry `estimatedDurationHours` AND the full `durationPrediction` (variance + similar cases) so downstream consumers can reason from spread without refetching QB.
- Reference dataset regeneration: `tools/src/scratch/generate-duration-reference.ts`.

Original design notes preserved below.

**Goal:** Given a QB Estimate, return a duration prediction the agent can reason from — not a flat lookup. Per Matt's "variance over hard rules" guidance, the function exposes spread, confidence, and similar past cases instead of just a single hours number.

---

## Function signature (proposed)

```ts
import type { QBEstimate } from '@aac/api-clients/quickbooks';

export function estimateDuration(estimate: QBEstimate): DurationPrediction;

export interface DurationPrediction {
  /** Point estimate (cluster median). Null when we have no data. */
  point: number | null;

  /** Range — what the agent should communicate to the customer. */
  p25: number | null;
  p75: number | null;

  /** Coefficient of variation for the cluster — high = unreliable point. */
  cv: number;

  /** Qualitative confidence — derived from cluster size and cv. */
  confidence: 'high' | 'moderate' | 'low' | 'none';

  /** Classification used for the prediction. */
  category: 'crack_injection' | 'concrete_resurfacing' | 'mixed' | 'other';

  /** Detected scope features — useful in agent prompts and reasoning. */
  signals: ScopeSignals;

  /** Human-readable explanation. */
  rationale: string;

  /** N closest past pairs for agent in-context reasoning. */
  similar: SimilarCase[];
}

export interface ScopeSignals {
  isCrackInjection: boolean;
  isConcreteResurfacing: boolean;
  hasCarbonFiber: boolean;      // structural reinforcement add-on
  hasMembrane: boolean;          // waterproof finish
  isMultiCrack: boolean;         // "multiple cracks" mentioned
  isExterior: boolean;
  isInterior: boolean;
  lineCount: number;
  totalAmt: number;
}

export interface SimilarCase {
  /** Anonymized customer name (initials or token). */
  customerToken: string;
  totalAmt: number;
  lineCount: number;
  actualDurationHours: number;
  category: string;
  /** First 200 chars of the primary scope line. */
  scopeSnippet: string;
  /** Distance score 0–1 (lower = more similar). */
  distance: number;
}
```

---

## How the prediction is computed

1. **Strip warranty boilerplate** from `estimate.Line[].Description` (lines containing `lifetime transferable guarantee` / `this guarantee` / `hic license` / `thank you for trusting attack a crack`).

2. **Classify into category** using Matt's 2-category taxonomy:
   - Crack injection signals: `urethane` | `inject(ion)` | `membrane` | `carbon fiber`
   - Concrete resurfacing signals: `resurfac` | `overlay` | `spall` | `driveway` | `stairway` | `garage` | `walkway` | `patio` | `step` | `floor crack` | `repoint` | `fieldstone` | `masonry` | `brick repair` | `skim coat` | `floor` + `epoxy`
   - Both fire (excluding carbon-fiber-as-sole-crack-signal) → `mixed`
   - Carbon fiber alone alongside resurfacing → `concrete_resurfacing` (carbon fiber is "almost always an add-on to injection" per Matt — but rarely standalone)
   - Default-to-resurfacing when no strong signal but real scope present
   - `other` only for empty / discount-only line items

3. **Compute scope signals** (for agent context).

4. **Find the cluster** = (category, dollar band).
   Dollar bands: `$0–1k` | `$1–2k` | `$2–5k` | `$5–10k` | `$10k+`.

5. **Load cluster stats** from the reference dataset (a static JSON shipped with the package, regenerated periodically from the spike output). Stats include: n, min, p25, median, p75, max, mean, cv.

6. **Find similar past cases.** Score each historical pair by:
   - +3 if same category
   - +2 if same dollar band
   - +1 if line count within ±1
   - +1 if same signals (carbon fiber, membrane, multi-crack)
   Return top 5 by score, with distance normalized 0–1.

7. **Set confidence** based on cluster sample size and cv:
   - `high`: n ≥ 10 AND cv ≤ 0.25
   - `moderate`: n ≥ 5 AND cv ≤ 0.4
   - `low`: n ≥ 2
   - `none`: no cluster match

8. **Build rationale** as a one-paragraph human-readable string the agent can quote:
   > "Crack injection at \$2,050 (3 line items, includes membrane finish). Cluster of 12 similar past jobs ranged 3–6h (median 4h, cv=0.18). Closest example: Lori Ziebart, \$1,275, 4h. Confidence: high."

---

## Why this shape (per Matt's guidance)

| Field | Why it exists |
|---|---|
| `p25`, `p75` | Agent communicates a range to customers ("3–6 hours"), not a false-precision single number. |
| `cv` | Tells the agent how reliable the point estimate is — a high-cv cluster means the median is misleading. |
| `similar` | Most important field. Lets the agent reason from concrete examples instead of trusting a derived heuristic. Per Matt: "the outliers are important, and we need to have our agent understand what they might be." |
| `signals` | Interpretable features the agent can use in prompts ("this is an exterior carbon-fiber-staple job") rather than opaque cluster math. |
| `rationale` | Quotable explanation so Matt can audit the reasoning when the agent surfaces it. |

---

## Reference dataset

Static JSON shipped with the package as `packages/quoting/data/duration-reference-<YYYY-MM-DD>.json`. Source: `tools/src/scratch/spike-output/duration-analysis-<DATE>.json`. Regenerate every 30–60 days as the dataset grows.

Schema:
```ts
{
  generated: ISO date,
  windowDays: number,
  matched: MatchedPair[],      // raw pairs for similar-case lookup
  clusters: ClusterStats[],    // pre-computed per category × dollar band
}
```

---

## Open questions for Matt (before codification)

1. ~~**Is the 2-category taxonomy frozen?**~~ → **Resolved 2026-05-29:** more sub-categories allowed where the data shows distinct patterns. Don't force everything into 2 buckets.

2. ~~**Reference-data refresh cadence.**~~ → **Resolved:** manual regeneration when needed. No cron.

3. ~~**Customer-facing range communication.**~~ → **Resolved:** tight practical windows ("3–4 hours, most of the day"), not statistical ranges. The internal `DurationPrediction` keeps p25/p75/cv for agent reasoning; the customer-facing layer translates into a tight scheduling window. Goal: maximize jobs/day × revenue.

4. ~~**Multi-day job representation.**~~ → **Resolved:** the prediction must flag multi-day explicitly. Schema addition:

```ts
export interface DurationPrediction {
  // ... existing fields ...

  /** When true, the job spans multiple workdays. */
  isMultiDay: boolean;

  /** When isMultiDay, the number of workdays required. */
  workdayCount: number | null;
}
```

The historical dataset shows multi-day jobs as separate single-day events — so the heuristic needs to detect multi-day from estimate features (very large total amount + multiple line items + specific keywords like "two-day" or "phase 1" / "day 1"). Will need to flag a small training set of multi-day jobs and learn from those. Initial v1 may need Matt-curated flags.

5. ~~**The "other" category**~~ → **Resolved (Matt's "keep cranking" implies my recommendation):** option (A) — return `{ point: null, confidence: 'none' }` with a rationale string flagging the unknown to Matt. Don't fake an answer; surfacing unknowns is how the classifier improves over time (Matt either resolves ad-hoc or expands the keyword set).

6. ~~**The Dillon outlier**~~ → **Resolved 2026-05-29:** Matt confirmed it was a same-day assessment-to-job conversion (real \$2,050 job, calendar event never extended). See [[assessment-to-job-conversion]] memory for the workflow pattern and long-term auto-detection vision. Immediate fix: data-quality filter for the reference dataset — exclude matched pairs whose `durationHours < 1.5h` (flagged `unreliableDuration: true` in the JSON). Currently filters out 0 pairs in the 180d dataset because Matt already recolored Dillon's event back to Assessment (purple); the rule remains load-bearing for future runs.

7. **Address-fuzzy matcher improvements** → **Deferred.** The 10 unmatched events scoring 0.55–0.60 (Pat Metcalf, Mary Dobruck, Kevin O'Halloran, etc.) could be caught with better address tokenization. Matt 2026-05-29: "Hopefully once we get automated scheduling, the address for the improvements won't matter anymore. We'll standardize the exact way that multi-day jobs get titled, etc." — the auto-scheduler will write standardized event titles/locations going forward, so the matcher gap is self-correcting over time. No fuzzy-matcher refinement before codification.

8. **Multi-day job representation** → **Deferred to v2.** Dataset has 0 multi-day jobs in 180d (they're scheduled as separate single-day events per Matt). `isMultiDay: false` is the v1 default. v2 will learn from a Matt-curated set of multi-day flags once we have examples — or detect from estimate features (large \$ + multi-line + "phase 1" / "day 1" keywords).

---

## What this does NOT do (yet)

- **Address-difficulty adjustments** (multi-story access, far-from-driveway, etc.) — these are context features I can't pull from the Estimate alone.
- **Seasonal / weather adjustments** — winter crack injection takes longer; the dataset has the signal but I'm not exposing seasonality.
- **Customer-history weighting** — if a customer has had 3 prior jobs at 4h each, that's stronger signal than the cluster median. Future v2.
- **Confidence intervals beyond p25/p75** — could expose p10/p90 for the agent's edge-case reasoning. Not in v1.

---

## Implementation order (when approved)

1. Move the warranty stripper + classifier from `tools/src/scratch/reclassify-and-drill.ts` into `packages/quoting/src/classify-scope.ts` with unit tests.
2. Generate the reference dataset and ship as `packages/quoting/data/duration-reference-<DATE>.json`.
3. Write `packages/quoting/src/estimate-duration.ts` exporting `estimateDuration(estimate)`.
4. Wire into `packages/scheduling/src/normalize-qb-approval.ts` so directives stop returning `estimatedDurationHours: null`.
5. Wire into apps/command-center's pending-directives view so the agent (and Matt) sees the prediction + range + similar cases.
