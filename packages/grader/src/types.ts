/** Which automation made the draft. */
export type Automation = 'quote' | 'followup' | 'intake' | 'ct-routing' | 'referral' | 'stale-quote';

/**
 * What Matt did with a draft. as-is and cosmetic count as right; changed and
 * thrown-out as misses. unused (nothing went out in the window, or he called
 * instead) is shown but not counted. "Would have hurt" is a hand grade only.
 */
export type Grade = 'waiting' | 'as-is' | 'cosmetic' | 'changed' | 'thrown-out' | 'unused';

/** fast: earns auto-send first. learn: slower. human: always drafts. */
export type KindPath = 'fast' | 'learn' | 'human';

export interface DraftLine {
  item: string;
  qty: number;
  unitPrice: number;
}

/** One draft and its grade. Stored as JSON in the `grader:drafts` hash. */
export interface GradedDraft {
  id: string;
  automation: Automation;
  /** Kind of case (docs/plans/command-center/automations-and-big-ideas.md). */
  kind: string;
  path: KindPath;
  draftedAt: string;
  phone?: string;
  estimateId?: string;
  doc?: string;
  customer?: string;
  /** Text drafts: what the bot wrote. */
  draft?: string;
  /** Quote drafts: the bot's lines (no Guarantee) and total. */
  lines?: DraftLine[];
  total?: number;
  grade: Grade;
  gradedAt?: string;
  /** Text drafts: what Matt sent, and its word similarity to the draft (0-1). */
  sent?: string;
  sentAt?: string;
  similarity?: number;
  /** Quote drafts: what Matt changed, owner-relative ("owner ADDED ..."). */
  changes?: string[];
  /** Total on the quote when graded. */
  sentTotal?: number;
  note?: string;
}

export const GRADES: readonly Grade[] = ['waiting', 'as-is', 'cosmetic', 'changed', 'thrown-out', 'unused'];
