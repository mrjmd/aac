/**
 * Pure grading: what Matt did with one draft, from the quote as it stands in
 * QBO or the texts he sent after it.
 */
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoMessage } from '@aac/api-clients/quo';
import { diffDraftLines } from '@aac/quoting';
import { AUTO_RE } from '@aac/message-drafts';
import type { Automation, DraftLine, Grade } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Quotes ───────────────────────────────────────────────────────────

/** draft-quote.ts appends the Guarantee line itself, so it is never an owner edit. */
const AUTO_LINE = /^guarantee$/i;

/** A quote is decided once it was emailed or accepted. */
const DECIDED_STATUS = new Set(['Accepted', 'Converted']);
/** Never emailed and closed out: the draft wasn't used. */
const DROPPED_STATUS = new Set(['Rejected', 'Closed']);
/** A Pending, never-emailed draft this old wasn't used. */
const QUOTE_UNUSED_AFTER_MS = 30 * DAY;

/**
 * What the owner changed on a bot quote draft, owner-relative
 * ("owner ADDED ...", "owner REMOVED ...", "owner CHANGED ..."), ignoring
 * the Guarantee line the drafter adds itself.
 */
export function ownerChanges(current: QBEstimate, draftLines: DraftLine[]): string[] {
  const filtered: QBEstimate = {
    ...current,
    Line: (current.Line ?? []).filter((l) => !AUTO_LINE.test(l.SalesItemLineDetail?.ItemRef?.name ?? '')),
  };
  // diffDraftLines(current, draft) yields draft-relative signs; invert them.
  return diffDraftLines(filtered, draftLines.filter((l) => !AUTO_LINE.test(l.item))).map((c) =>
    c.startsWith('+') ? `owner REMOVED ${c.slice(2)}` :
    c.startsWith('−') ? `owner ADDED ${c.slice(2).replace(' removed', '')}` :
    c.replace('~', 'owner CHANGED').replace('→', '←'),
  );
}

export interface QuoteGrade {
  grade: Grade;
  changes?: string[];
  sentTotal?: number;
  note?: string;
}

/**
 * Grade a quote draft from its lines and total. Not the SyncToken: emailing
 * or saving in QBO bumps it with nothing changed.
 */
export function gradeQuote(args: {
  current: QBEstimate | null;
  lines: DraftLine[];
  total?: number;
  draftedAt: string;
  now: number;
}): QuoteGrade {
  const { current, lines } = args;
  if (!current) return { grade: 'thrown-out', note: 'deleted in QBO' };
  const status = current.TxnStatus ?? 'Pending';
  const decided = current.EmailStatus === 'EmailSent' || DECIDED_STATUS.has(status);
  if (!decided) {
    if (DROPPED_STATUS.has(status)) return { grade: 'unused', note: `marked ${status} without emailing` };
    if (args.now - new Date(args.draftedAt).getTime() > QUOTE_UNUSED_AFTER_MS) {
      return { grade: 'unused', note: 'not emailed within 30 days' };
    }
    return { grade: 'waiting' };
  }
  const changes = ownerChanges(current, lines);
  const sentTotal = current.TotalAmt;
  if (changes.length) return { grade: 'changed', changes, sentTotal };
  // diffDraftLines keys lines by item name, so two lines of one item can hide a change.
  if (args.total !== undefined && sentTotal !== undefined && Math.abs(sentTotal - args.total) >= 0.01) {
    return { grade: 'changed', changes: [], sentTotal, note: `total ${args.total} → ${sentTotal}` };
  }
  return { grade: 'as-is', sentTotal };
}

// ── Texts ────────────────────────────────────────────────────────────

/** How long after a text draft Matt's first text still answers it. */
export const TEXT_WINDOW_MS: Record<Exclude<Automation, 'quote'>, number> = {
  followup: 3 * DAY,
  intake: 1 * DAY,
  'ct-routing': 2 * DAY,
  referral: 2 * DAY,
  'stale-quote': 7 * DAY,
};

/** Texts this soon after Matt's first one are the same reply, split up. */
const SAME_REPLY_MS = 20 * 60_000;
/** A connected call this long, before any text, means he called instead. */
const CALL_MIN_S = 40;

export const AS_IS_MIN = 0.97;
export const COSMETIC_MIN = 0.85;

const SIGNATURE = /^\s*-+\s*matt at attack a crack\s*$/gim;

export function words(s: string): string[] {
  return s
    .replace(SIGNATURE, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9$]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** 1 − word edit distance ÷ the longer length. 1 = same words in the same order. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const n = Math.max(x.length, y.length);
  if (n === 0) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[y.length] / n;
}

export interface TextGrade {
  grade: Grade;
  sent?: string;
  sentAt?: string;
  similarity?: number;
  note?: string;
}

/** Grade a text draft against Matt's texts and calls to that number after it. */
export function gradeText(args: {
  automation: Exclude<Automation, 'quote'>;
  draft: string;
  draftedAt: string;
  messages: QuoMessage[];
  calls: QuoCall[];
  now: number;
}): TextGrade {
  const from = new Date(args.draftedAt).getTime();
  const window = TEXT_WINDOW_MS[args.automation];
  const until = from + window;
  const at = (x: { createdAt: string }) => new Date(x.createdAt).getTime();
  const outs = args.messages
    .filter((m) => m.direction === 'outgoing' && (m.text ?? '').trim() && !AUTO_RE.test(m.text) && at(m) >= from && at(m) <= until)
    .sort((a, b) => at(a) - at(b));
  const call = args.calls
    .filter((c) => (c.duration ?? 0) >= CALL_MIN_S && at(c) >= from && at(c) <= until)
    .sort((a, b) => at(a) - at(b))[0];
  if (call && (!outs.length || at(call) < at(outs[0]))) {
    return { grade: 'unused', note: `${call.direction === 'outgoing' ? 'called them' : 'they called'} before any text` };
  }
  if (!outs.length) {
    return args.now < until ? { grade: 'waiting' } : { grade: 'unused', note: `nothing texted within ${Math.round(window / HOUR)}h` };
  }
  const first = at(outs[0]);
  const sent = outs.filter((m) => at(m) - first <= SAME_REPLY_MS).map((m) => m.text.trim()).join('\n');
  const sim = Math.round(similarity(args.draft, sent) * 1000) / 1000;
  const grade: Grade = sim >= AS_IS_MIN ? 'as-is' : sim >= COSMETIC_MIN ? 'cosmetic' : 'changed';
  return { grade, sent, sentAt: outs[0].createdAt, similarity: sim };
}

/** The customer asked something after Matt's last real text, before the draft. */
export function hasOpenQuestion(messages: QuoMessage[], draftedAt: string): boolean {
  const before = messages
    .filter((m) => new Date(m.createdAt).getTime() < new Date(draftedAt).getTime())
    .filter((m) => m.direction === 'incoming' || !AUTO_RE.test(m.text ?? ''))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const m of before) {
    if (m.direction === 'outgoing') return false;
    if ((m.text ?? '').includes('?')) return true;
  }
  return false;
}
