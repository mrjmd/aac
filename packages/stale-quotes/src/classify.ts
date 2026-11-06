import type { QBEstimate } from '@aac/api-clients/quickbooks';
import {
  CAPACITY_RESURF_LARGE_USD,
  CAPACITY_SQFT_MAX,
  CAPACITY_STAIR_USD,
  T1_VARIANTS,
  T2_VARIANTS,
  type ServiceClass,
} from './types.js';

/** djb2 — stable variant assignment, same spirit as followup.ts variantSlot. */
function hashCode(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function assignVariant(estimateId: string): { t1Days: number; t2Days: number } {
  const h = hashCode(`stale-quote:${estimateId}`);
  return { t1Days: T1_VARIANTS[h & 1], t2Days: T2_VARIANTS[(h >> 1) & 1] };
}

// ── service classification (plan §4.5 + Mike capacity policy) ────────

// Resurfacing classification runs on ITEM NAMES ONLY — never descriptions.
// QBO crack-repair description templates mention floors/patios/steps and
// false-positived 20+ injection quotes (Chad Brown's 3 crack injections,
// Lisa Martin's carbon fiber) into capacity-hold on the first dry run.
// Item taxonomy (from the all-time estimate pull): Concrete Resurfacing,
// Concrete Stair Resurfacing, Garage resurfacing, Pool Deck Resurfacing/
// Sealing, Epoxy Garage Coating, Sidewalk grinding/repair, Driveway Repair.
const RESURF_ITEM_RE = /resurfac|pool deck|garage coating|sidewalk|driveway|concrete leveling/i;
const FULL_SURFACE_ITEM_RE = /pool deck|garage resurfac|garage coating/i;

// Stated square footage, read from resurf line DESCRIPTIONS only (safe:
// the line is already item-name-classified as resurfacing). "approx. 450
// square feet", "225 sq ft", "1400 SF" all match.
const SQFT_RE = /([\d,]+)\s*(?:sq(?:uare)?\.?\s*(?:ft|feet|foot)|sf\b)/i;
const STAIR_ITEM_RE = /stair|step/i;

export function classifyService(e: QBEstimate): { cls: ServiceClass; largeResurf: boolean; resurfTotal: number; statedSqft: number | null } {
  const lines = (e.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => {
      const d = (l as unknown as { SalesItemLineDetail?: { ItemRef?: { name?: string } }; Amount?: number; Description?: string });
      return { item: d.SalesItemLineDetail?.ItemRef?.name ?? '', amount: d.Amount ?? 0, desc: d.Description ?? '' };
    })
    .filter((l) => l.item && !/discount|guarantee/i.test(l.item));

  const resurfLines = lines.filter((l) => RESURF_ITEM_RE.test(l.item));
  const resurfTotal = resurfLines.reduce((s, l) => s + l.amount, 0);
  const itemText = lines.map((l) => l.item).join(' ');

  let cls: ServiceClass = 'injection';
  if (/pool/i.test(itemText)) cls = 'pool-deck';
  else if (/garage/i.test(itemText) && resurfLines.length) cls = 'garage-interior';
  else if (resurfLines.length) cls = 'exterior-resurf';

  // MAX across resurf lines, not sum — resurf + epoxy on the same 225 sq ft
  // garage floor is still one 225 sq ft surface.
  const sqfts = resurfLines
    .map((l) => {
      const m = l.desc.match(SQFT_RE);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    })
    .filter((n): n is number => n !== null && n > 0);
  const statedSqft = sqfts.length ? Math.max(...sqfts) : null;
  const stairOnly = resurfLines.length > 0 && resurfLines.every((l) => STAIR_ITEM_RE.test(l.item));

  let largeResurf = false;
  if (resurfLines.length) {
    if (statedSqft !== null) largeResurf = statedSqft > CAPACITY_SQFT_MAX;
    else if (stairOnly) largeResurf = resurfTotal > CAPACITY_STAIR_USD;
    else largeResurf = resurfTotal > CAPACITY_RESURF_LARGE_USD || FULL_SURFACE_ITEM_RE.test(itemText);
  }
  return { cls, largeResurf, resurfTotal, statedSqft };
}
