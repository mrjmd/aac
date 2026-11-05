import type { ItemCandidate, ItemState } from './types.js';
import { EASTERN_TZ, easternDate } from '@aac/shared-utils/eastern';

/**
 * The Today ranking (Matt, 2026-11-05): hard deadlines and promises first,
 * then how recently a customer has actually been waiting, then dollars.
 * Solicitations sink. Pure; the reasons are shown with the item so Matt
 * can see why something sits where it does, and every drag is logged with
 * `rankFeatures` so the weights can be fit to his corrections later.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SEVERITY_BASE = { red: 120, yellow: 60, info: 20 } as const;

/** Due within this many hours (or overdue) = the deadline tier. */
export const DEADLINE_WINDOW_H = 36;
/** Score at or above which an item is suggested onto Today. */
export const SUGGEST_MIN_SCORE = 300;
/** At most this many suggested items on Today at once. */
export const SUGGEST_MAX = 7;

/** Detectors whose items belong to a batch, not to Matt's one-by-one list. */
const BATCHED = new Set(['D5']); // stale quotes: the follow-up batch owns them

export interface Rank {
  score: number;
  why: string[];
}

export function rankItem(c: ItemCandidate, now: Date): Rank {
  const why: string[] = [];
  if (c.solicitation) return { score: -100, why: ['Someone selling to you'] };

  let score = BATCHED.has(c.detector) ? 0 : SEVERITY_BASE[c.severity];
  if (BATCHED.has(c.detector)) why.push('In the follow-up batch');

  if (c.dueAt) {
    const h = (Date.parse(c.dueAt) - now.getTime()) / HOUR;
    if (Number.isFinite(h)) {
      if (h <= DEADLINE_WINDOW_H) {
        // Sooner (and overdue) ranks higher; overdue stops climbing after two days.
        score += 1000 + (DEADLINE_WINDOW_H - Math.max(h, -48)) * 5;
        why.push(h < 0 ? `Overdue: was due ${dueLabel(c.dueAt, now)}` : `Due ${dueLabel(c.dueAt, now)}`);
      } else if (h <= 7 * 24) {
        score += 100;
        why.push(`Due ${dueLabel(c.dueAt, now)}`);
      }
    }
  }

  if (c.waitingSince) {
    const days = Math.max(0, (now.getTime() - Date.parse(c.waitingSince)) / DAY);
    if (Number.isFinite(days)) {
      // 0d 600, 1d 400, 2d 300, 7d 133, 30d 38: a fresh wait outranks a stale one.
      score += 600 / (1 + days / 2);
      why.push(days < 1 ? 'Customer waiting since today' : `Customer waiting ${Math.round(days)}d`);
    }
  }

  if (c.amount && c.amount > 0 && !BATCHED.has(c.detector)) {
    score += 25 * Math.log10(c.amount + 1);
    if (c.amount >= 2500) why.push(`$${Math.round(c.amount).toLocaleString('en-US')}`);
  }

  return { score: Math.round(score), why };
}

function dueLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const fmt = (o: Intl.DateTimeFormatOptions) => d.toLocaleString('en-US', { timeZone: EASTERN_TZ, ...o });
  const time = fmt({ hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  if (easternDate(d) === easternDate(now)) return `${time} today`;
  if (easternDate(d) === easternDate(now.getTime() + DAY)) return `${time} tomorrow`;
  return fmt({ weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Should the ranking put this open, unpinned item on Today? A deadline in
 * the window always qualifies. Otherwise the score must clear the bar and
 * Matt must not have already placed it, unless the customer wrote again
 * after he did.
 */
export function shouldSuggest(c: ItemCandidate, state: ItemState, score: number, now: Date): boolean {
  if (c.lane !== 'needs-you' || c.solicitation || state.pinnedFor) return false;
  if (c.dueAt && (Date.parse(c.dueAt) - now.getTime()) / HOUR <= DEADLINE_WINDOW_H) return true;
  if (score < SUGGEST_MIN_SCORE) return false;
  if (!state.placedAt) return true;
  return !!c.waitingSince && c.waitingSince > state.placedAt;
}

/** The facts the ranking looked at, logged with each of Matt's drags and verbs. */
export interface RankFeatures {
  key: string;
  detector: string;
  area: string;
  severity: string;
  amount?: number;
  dueInHours?: number;
  waitingDays?: number;
  ageDays: number;
  pinned: boolean;
  rank?: number;
  score: number;
  suggested?: boolean;
}

export function rankFeatures(c: ItemCandidate, state: ItemState | undefined, now: Date, extra: { suggested?: boolean } = {}): RankFeatures {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const f: RankFeatures = {
    key: c.key,
    detector: c.detector,
    area: c.area,
    severity: c.severity,
    ageDays: state ? round1((now.getTime() - Date.parse(state.firstSeenAt)) / DAY) : 0,
    pinned: !!state?.pinnedFor,
    score: rankItem(c, now).score,
  };
  if (c.amount !== undefined) f.amount = c.amount;
  if (c.dueAt) f.dueInHours = round1((Date.parse(c.dueAt) - now.getTime()) / HOUR);
  if (c.waitingSince) f.waitingDays = round1((now.getTime() - Date.parse(c.waitingSince)) / DAY);
  if (state?.rank !== undefined) f.rank = state.rank;
  if (extra.suggested) f.suggested = true;
  return f;
}
