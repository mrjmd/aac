/**
 * Readiness math for the command center Automations page: per automation
 * and per kind of case, how many graded drafts were right, proven against
 * the bar Matt set on 11/06 (docs/plans/command-center/automations-and-big-ideas.md).
 */
import type { Automation, GradedDraft, KindPath } from './types.js';

export const BAR = { proven: 90, raw: 95, hurtWindow: 50 } as const;

/** Matt's own grade on a draft. Overrides the grader's; "hurt" exists only here. */
export type HandGradeValue = 'as-is' | 'cosmetic' | 'changed' | 'thrown-out' | 'hurt';
export const HAND_GRADES: readonly HandGradeValue[] = ['as-is', 'cosmetic', 'changed', 'thrown-out', 'hurt'];
export interface HandGrade {
  grade: HandGradeValue;
  at: string;
}

/** right = as-is or cosmetic. unused and waiting are not counted. */
export type Outcome = 'right' | 'changed' | 'thrown-out' | 'hurt' | 'unused' | 'waiting';

export function outcomeOf(d: GradedDraft, hand?: HandGrade): Outcome {
  const g = hand?.grade ?? d.grade;
  if (g === 'as-is' || g === 'cosmetic') return 'right';
  return g;
}

const COUNTED = new Set<Outcome>(['right', 'changed', 'thrown-out', 'hurt']);

/** One-sided 95% Wilson lower bound on k of n, as a whole percent. */
export function provenPct(k: number, n: number): number {
  if (!n) return 0;
  const z = 1.645;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const lo = (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return Math.floor(lo * 100);
}

export interface Tally {
  k: number;
  n: number;
  hurt: number;
  raw: number | null;
  proven: number;
  /** Right in a row from here that would clear the bar, or null if over 500. */
  toBar: number | null;
}

function tally(drafts: Array<{ d: GradedDraft; o: Outcome }>): Tally {
  const graded = drafts.filter((x) => COUNTED.has(x.o)).sort((a, b) => b.d.draftedAt.localeCompare(a.d.draftedAt));
  const k = graded.filter((x) => x.o === 'right').length;
  const n = graded.length;
  const hurt = graded.slice(0, BAR.hurtWindow).filter((x) => x.o === 'hurt').length;
  let toBar: number | null = null;
  for (let m = 0; m <= 500; m++) {
    if (provenPct(k + m, n + m) >= BAR.proven && ((k + m) / (n + m)) * 100 >= BAR.raw) {
      toBar = m;
      break;
    }
  }
  return { k, n, hurt, raw: n ? Math.round((k / n) * 100) : null, proven: provenPct(k, n), toBar };
}

export interface KindStats extends Tally {
  kind: string;
  path: KindPath;
  /** All drafts of this kind, counted or not. */
  drafts: number;
  qualifies: boolean;
}

export interface WeekStats {
  /** Monday, YYYY-MM-DD. */
  week: string;
  right: number;
  changed: number;
  /** thrown-out + hurt. */
  out: number;
}

export interface AutomationStats extends Tally {
  automation: Automation;
  drafts: number;
  waiting: number;
  unused: number;
  handGraded: number;
  since: string | null;
  kinds: KindStats[];
  weeks: WeekStats[];
  /** Newest first, with the outcome after hand grades. */
  recent: Array<GradedDraft & { outcome: Outcome; hand?: HandGrade }>;
}

export function qualifies(t: Tally, path: KindPath): boolean {
  return path !== 'human' && t.n > 0 && t.proven >= BAR.proven && (t.raw ?? 0) >= BAR.raw && t.hurt === 0;
}

function mondayOf(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const PATH_ORDER: Record<KindPath, number> = { fast: 0, learn: 1, human: 2 };

export function summarize(drafts: GradedDraft[], hand: Record<string, HandGrade>): Map<Automation, AutomationStats> {
  const out = new Map<Automation, AutomationStats>();
  const by = new Map<Automation, GradedDraft[]>();
  for (const d of drafts) by.set(d.automation, [...(by.get(d.automation) ?? []), d]);
  for (const [automation, list] of by) {
    const rows = list.map((d) => ({ d, o: outcomeOf(d, hand[d.id]) }));
    const kinds = new Map<string, typeof rows>();
    for (const r of rows) kinds.set(r.d.kind, [...(kinds.get(r.d.kind) ?? []), r]);
    const weeks = new Map<string, WeekStats>();
    for (const { d, o } of rows) {
      if (!COUNTED.has(o)) continue;
      const w = mondayOf(d.draftedAt);
      const s = weeks.get(w) ?? { week: w, right: 0, changed: 0, out: 0 };
      if (o === 'right') s.right++;
      else if (o === 'changed') s.changed++;
      else s.out++;
      weeks.set(w, s);
    }
    const sorted = [...rows].sort((a, b) => b.d.draftedAt.localeCompare(a.d.draftedAt));
    out.set(automation, {
      automation,
      ...tally(rows),
      drafts: rows.length,
      waiting: rows.filter((r) => r.o === 'waiting').length,
      unused: rows.filter((r) => r.o === 'unused').length,
      handGraded: rows.filter((r) => hand[r.d.id]).length,
      since: sorted.at(-1)?.d.draftedAt ?? null,
      kinds: [...kinds.entries()]
        .map(([kind, rs]) => {
          const t = tally(rs);
          const path = rs[0].d.path;
          return { kind, path, drafts: rs.length, ...t, qualifies: qualifies(t, path) };
        })
        .sort((a, b) => PATH_ORDER[a.path] - PATH_ORDER[b.path] || b.drafts - a.drafts),
      weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
      recent: sorted.map(({ d, o }) => ({ ...d, outcome: o, ...(hand[d.id] ? { hand: hand[d.id] } : {}) })),
    });
  }
  return out;
}
