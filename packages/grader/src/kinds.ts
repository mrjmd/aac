/**
 * Kinds of cases, from the 11/06 segmentation of 573 quotes and the lead
 * data (docs/plans/command-center/automations-and-big-ideas.md, "Kinds of
 * cases come from the data"). Quote kinds are read from the drafted lines,
 * so wall type and crack direction (which the lines don't carry) aren't
 * split out yet.
 */
import type { DraftLine, KindPath } from './types.js';

/** Lines QBO adds or that don't describe the work. */
const NOT_WORK = /^(guarantee|discount|letter)$/i;
const CRACK = /^(crack repair( e)?|spot injection|window (corner )?injection|cold joint|honeycomb injection)$/i;
const PIPE = /^(tie hole injections|sewer inlet injection|water line injection|conduit injection|gas line inlet|hydraulic cement|holes? in foundation wall)/i;
const BULKHEAD = /^bulkhead injection$/i;
const EXTRA = /^(sheetrock \/ paneling removal|removing materials)$/i;
const STRUCTURAL = /carbon fiber|structural/i;
const MASONRY = /fieldstone|mortar|masonry|repointing|cinder block|bluestone/i;
const FLAT = /resurfacing|pool deck|garage|surface seal|epoxy|sidewalk|leveling|expansion joint|void fill/i;

export const QUOTE_KIND_PATH: Record<string, KindPath> = {
  'one-crack': 'fast',
  cracks: 'fast',
  pipes: 'fast',
  bulkhead: 'fast',
  'cracks-plus': 'learn',
  floor: 'learn',
  steps: 'learn',
  'flat-resurfacing': 'human',
  structural: 'human',
  masonry: 'human',
  mixed: 'human',
};

export function quoteKind(lines: DraftLine[]): { kind: string; path: KindPath } {
  const work = lines.filter((l) => !NOT_WORK.test(l.item.trim()));
  const names = work.map((l) => l.item.trim());
  const pick = (kind: string) => ({ kind, path: QUOTE_KIND_PATH[kind] });
  if (names.length === 0) return pick('mixed');
  if (names.some((n) => STRUCTURAL.test(n))) return pick('structural');
  if (names.some((n) => MASONRY.test(n))) return pick('masonry');
  if (names.some((n) => /stair/i.test(n))) return names.every((n) => /stair/i.test(n)) ? pick('steps') : pick('flat-resurfacing');
  if (names.some((n) => FLAT.test(n))) return pick('flat-resurfacing');
  if (names.every((n) => /floor crack/i.test(n))) return pick('floor');
  if (!names.every((n) => CRACK.test(n) || PIPE.test(n) || BULKHEAD.test(n) || EXTRA.test(n))) return pick('mixed');
  const cracks = work.filter((l) => CRACK.test(l.item.trim()));
  if (cracks.length === work.length) {
    return pick(cracks.reduce((s, l) => s + (l.qty || 1), 0) <= 1 ? 'one-crack' : 'cracks');
  }
  if (cracks.length > 0) return pick('cracks-plus');
  if (names.every((n) => BULKHEAD.test(n))) return pick('bulkhead');
  if (names.every((n) => PIPE.test(n))) return pick('pipes');
  return pick('mixed');
}

/** Stale-quote touches: check-ins to a silent customer are fast, the final check-in slower. */
export function staleKind(tier: string): { kind: string; path: KindPath } {
  return { kind: tier, path: tier === 'T3' ? 'learn' : 'fast' };
}

/**
 * "Just sent your quote" texts: a quiet thread drafts well (7 of 9 sent as
 * drafted), an open customer question doesn't (0 of 8). Open = the customer
 * texted after Matt's last text, before the draft.
 */
export function followupKind(openQuestion: boolean): { kind: string; path: KindPath } {
  return openQuestion ? { kind: 'open-question', path: 'human' } : { kind: 'quiet', path: 'fast' };
}
