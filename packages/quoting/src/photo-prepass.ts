/**
 * photo-prepass — runtime photo analysis stage for the quote drafter
 * (Phase 4 of docs/projects/photo-quote-training.md).
 *
 * Before the draft prompt runs, the pre-pass segments the customer's
 * photos into distinct physical AREAS (the direct fix for merged-scope
 * drafts), then similar historical areas are retrieved from the exemplar
 * library and injected into the draft prompt as worked examples.
 *
 * Exemplars teach SCOPE READING only — Section 0 of the pricing ruleset
 * is the only pricing authority (historical exemplar prices drift).
 */

import type { DraftThreadMessage } from './draft-quote.js';
import type { Scored } from './retrieval.js';

export interface PhotoRead {
  photo: number;
  surface?: string;
  symptoms?: string[];
  water_evidence?: string;
  notes?: string;
}

export interface PhotoArea {
  area: string;
  photos: number[];
  description: string;
  location?: string;
  predicted_items?: string[];
  confidence?: string;
}

export interface AreaAnalysis {
  photoReads: PhotoRead[];
  areas: PhotoArea[];
  customerAsks: string[];
}

/** One row of exemplar-library.jsonl (built by tools/src/photo-corpus/embed.ts). */
export interface ExemplarLibraryEntry {
  id: string;
  docNumber: string;
  txnDate: string;
  outcome?: string;
  situation: string;
  quotedItems: Array<{ item: string; unitPrice: number; qty: number }>;
  unquoted?: string;
  embedModel: string;
  vector: number[];
}

export function threadDigest(thread: DraftThreadMessage[]): string {
  return thread
    .map((m) => `${m.direction === 'outgoing' ? 'OUT' : 'IN'} ${m.at.slice(0, 16)}: ${m.text}`)
    .join('\n');
}

/**
 * The area-segmentation prompt (mirrors the corpus structuring blind pass
 * so runtime situations land in the same embedding space as the library).
 */
export function buildAreaAnalysisPrompt(args: {
  thread: DraftThreadMessage[];
  photoCount: number;
  itemNames: string[];
}): string {
  return `You are analyzing pre-quote photos sent by a customer to Attack A Crack, a Massachusetts foundation-repair company (two service categories: basement crack injection, and concrete/masonry repair + resurfacing).

Below is the SMS conversation (OUT = owner, IN = customer) and ${args.photoCount} photo(s) the customer sent (in order).

CONVERSATION:
${threadDigest(args.thread)}

AVAILABLE SERVICE ITEMS (use these exact names):
${args.itemNames.join(' | ')}

Your tasks:
1. Read each photo: what surface/structure is shown, what symptoms are visible (cracks, water staining, efflorescence, spalling, settling), any water evidence.
2. Group the photos into DISTINCT PHYSICAL AREAS. Photos of the same crack or structure from different angles/distances are ONE area. Different walls, corners, structures, or parts of the property are SEPARATE areas. Use the conversation for location hints.
3. For each area, predict which service item(s) the company would quote. Only predict work evidenced by a visible symptom or an explicit customer request — never infer a repair from the mere presence of a structure.

Respond with ONLY a JSON object:
{
  "photo_reads": [{"photo": 1, "surface": "...", "symptoms": ["..."], "water_evidence": "none|possible|clear", "notes": "..."}],
  "areas": [{"area": "A", "photos": [1,2], "description": "...", "location": "...", "predicted_items": ["..."], "confidence": "high|medium|low"}],
  "customer_asks": ["each distinct repair request from the conversation"]
}`;
}

export function parseAreaAnalysis(raw: string): AreaAnalysis | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
      photo_reads?: PhotoRead[];
      areas?: PhotoArea[];
      customer_asks?: string[];
    };
    if (!Array.isArray(obj.areas) || obj.areas.length === 0) return null;
    return {
      photoReads: obj.photo_reads ?? [],
      areas: obj.areas,
      customerAsks: obj.customer_asks ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * The retrieval-query text for an area. MUST stay composition-identical to
 * the corpus side (tools/src/photo-corpus/embed.ts) — same embedding space.
 */
export function areaSituationText(area: PhotoArea, photoReads: PhotoRead[]): string {
  const symptoms = photoReads
    .filter((p) => (area.photos ?? []).includes(p.photo))
    .flatMap((p) => p.symptoms ?? []);
  return [
    area.description,
    area.location ? `Location: ${area.location}.` : '',
    symptoms.length ? `Symptoms: ${[...new Set(symptoms)].join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const NON_SCOPE_ITEMS = /guarantee|discount|deposit|warranty/i;

/**
 * Render the pre-pass result + retrieved exemplars as a prompt block for
 * the main draft prompt.
 */
export function formatPhotoContext(args: {
  analysis: AreaAnalysis;
  retrieved: Array<{ area: PhotoArea; exemplars: Array<Scored<ExemplarLibraryEntry>> }>;
}): string {
  const sections = args.retrieved.map(({ area, exemplars }) => {
    const header = `AREA ${area.area} (photos ${area.photos.join(',')}): ${areaSituationText(
      area,
      args.analysis.photoReads,
    )}`;
    const lines = exemplars.map(({ item, score }) => {
      const quoted = item.quotedItems.filter((q) => !NON_SCOPE_ITEMS.test(q.item));
      const outcomeTag = item.outcome ? `, ${item.outcome}` : '';
      const what =
        quoted.length > 0
          ? `QUOTED: ${quoted.map((q) => `${q.item} ×${q.qty}`).join(' + ')}`
          : `NOT QUOTED (${item.unquoted ?? 'deliberately skipped'})`;
      return `  - similar past job [${item.txnDate.slice(0, 7)}, #${item.docNumber}${outcomeTag}, sim ${score.toFixed(2)}]: ${item.situation} → ${what}`;
    });
    return [header, ...lines].join('\n');
  });

  return `PHOTO AREA ANALYSIS (pre-pass over the attached photos — treat each AREA as a distinct scope):
${sections.join('\n')}

Area rules:
- scope_accounting must account for EVERY area above (quoted or excluded with reason + suggested_reply), in addition to every textual ask.
- Past jobs show WHAT was quoted in similar situations, never the price — Section 0 is the only pricing authority.
- If an area's similar jobs were NOT QUOTED, consider excluding it the same way.`;
}
