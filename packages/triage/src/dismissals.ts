/**
 * Editing the owner's dismissal rules (triage:dismissals), the list analyze
 * applies after the detectors: a finding is dropped when a live rule's
 * `match` appears (case-insensitively) in its customer, title or phone and
 * the rule's `sections` (if any) include the finding's section. `until`
 * (YYYY-MM-DD) ends a temporary hold. Replaces hand-editing
 * dismissals.json (plan decision 3); tools/src/triage/dismiss.ts is the CLI.
 */

import type { DismissalRule, TriageStore } from './store.js';
import type { Section } from './types.js';

/** Every Section, at runtime (validated against the type both ways). */
export const TRIAGE_SECTIONS = [
  'system',
  'booked_gap',
  'stub_review',
  'offer_hold',
  'incomplete_event',
  'quote_promised',
  'quote_gap',
  'deal_closer',
  'cash_not_invoiced',
  'cash_not_sent',
  'cash_overdue',
  'stale_estimate',
  'message_draft',
  'conversation',
  'solicitation',
  'scope_flag',
] as const satisfies readonly Section[];

// Fails to compile if a Section is added to types.ts but not listed above.
type MissingSection = Exclude<Section, (typeof TRIAGE_SECTIONS)[number]>;
const allSectionsListed: [MissingSection] extends [never] ? true : MissingSection = true;
void allSectionsListed;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(v: string): boolean {
  return DATE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
}

/** Check an untrusted value against the rule shape analyze reads; throws with every problem found. */
export function validateDismissalRule(input: unknown): DismissalRule {
  const problems: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('dismissal rule must be an object');
  const r = input as Record<string, unknown>;
  const allowed = new Set(['match', 'sections', 'reason', 'addedAt', 'until']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) problems.push(`unknown field "${k}"`);
  if (typeof r.match !== 'string' || !r.match.trim()) problems.push('match must be a non-empty string');
  else if (r.match !== r.match.trim()) problems.push('match must not have leading/trailing spaces');
  if (r.sections !== undefined) {
    if (!Array.isArray(r.sections) || r.sections.length === 0) problems.push('sections must be a non-empty array when present');
    else
      for (const s of r.sections)
        if (!(TRIAGE_SECTIONS as readonly unknown[]).includes(s)) problems.push(`unknown section "${String(s)}" (one of ${TRIAGE_SECTIONS.join(', ')})`);
  }
  if (r.reason !== undefined && (typeof r.reason !== 'string' || !r.reason.trim())) problems.push('reason must be a non-empty string when present');
  for (const k of ['addedAt', 'until'] as const)
    if (r[k] !== undefined && (typeof r[k] !== 'string' || !isDate(r[k] as string))) problems.push(`${k} must be YYYY-MM-DD`);
  if (problems.length) throw new Error(`invalid dismissal rule: ${problems.join('; ')}`);
  return r as unknown as DismissalRule;
}

const sameSections = (a?: Section[], b?: Section[]): boolean =>
  [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',');

/** A rule is live on `today` (YYYY-MM-DD, UTC as analyze computes it) unless its `until` has passed. */
export function isRuleActive(rule: DismissalRule, today: string): boolean {
  return !rule.until || rule.until >= today;
}

/**
 * Append a validated rule (addedAt defaults to `today`). Refuses a rule with
 * the same match (case-insensitive) and the same sections as an existing
 * one: remove it first to change it. Returns the saved list.
 */
export async function addDismissal(
  store: Pick<TriageStore, 'loadDismissals' | 'setDismissals'>,
  input: unknown,
  today: string,
): Promise<DismissalRule[]> {
  const valid = validateDismissalRule(input);
  const rule: DismissalRule = valid.addedAt ? valid : { ...valid, addedAt: today };
  const rules = (await store.loadDismissals()) ?? [];
  const dup = rules.find((r) => r.match.toLowerCase() === rule.match.toLowerCase() && sameSections(r.sections, rule.sections));
  if (dup) throw new Error(`a dismissal for "${dup.match}"${dup.sections ? ` (${dup.sections.join(', ')})` : ''} already exists`);
  const next = [...rules, rule];
  await store.setDismissals(next);
  return next;
}

/**
 * Remove the rules whose match equals `match` (case-insensitive); with
 * `sections`, only the rule with exactly those sections. Throws when nothing
 * matches. Returns the removed rules.
 */
export async function removeDismissal(
  store: Pick<TriageStore, 'loadDismissals' | 'setDismissals'>,
  match: string,
  sections?: Section[],
): Promise<DismissalRule[]> {
  const rules = (await store.loadDismissals()) ?? [];
  const hit = (r: DismissalRule) => r.match.toLowerCase() === match.trim().toLowerCase() && (!sections || sameSections(r.sections, sections));
  const removed = rules.filter(hit);
  if (!removed.length) throw new Error(`no dismissal matches "${match}"${sections ? ` (${sections.join(', ')})` : ''}`);
  await store.setDismissals(rules.filter((r) => !hit(r)));
  return removed;
}
