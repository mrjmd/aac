/**
 * System > Automations (docs/plans/command-center/automations-and-big-ideas.md).
 * Reads the grader's records (`grader:drafts`, written daily by the worker)
 * and Matt's hand grades (`grader:hand`); the math is `summarize` in
 * @aac/grader. Display text for each automation and kind of case is here.
 */
import {
  HAND_GRADES,
  QUOTE_KIND_PATH,
  summarize,
  type Automation,
  type AutomationStats,
  type GradedDraft,
  type HandGrade,
  type HandGradeValue,
  type KindPath,
  type KindStats,
} from "@aac/grader";
import { keys } from "@aac/shared-utils/redis";
import { getRedis } from "./redis";

export interface KindMeta {
  name: string;
  sub: string;
  /** How common, from the 11/06 segmentation. */
  share: string;
  path: KindPath;
}

export interface AutomationMeta {
  id: Automation | "scheduling" | "router";
  name: string;
  what: string;
  /** Does it itself already. */
  live?: boolean;
  /** Not graded yet; why. */
  notMeasured?: string;
  /** Kinds of cases, in display order. Kinds seen in the records but not listed here still show. */
  kinds: Record<string, KindMeta>;
  basis?: string;
  flags?: string;
}

const q = (kind: string, name: string, sub: string, share: string): [string, KindMeta] => [kind, { name, sub, share, path: QUOTE_KIND_PATH[kind] }];

export const AUTOMATIONS: AutomationMeta[] = [
  {
    id: "quote",
    name: "Quote drafter",
    what: "Reads the photos and drafts a QuickBooks quote for you to review.",
    kinds: Object.fromEntries([
      q("one-crack", "One crack, poured wall", "Vertical, diagonal or window corner. Median $1,075; half fall between $975 and $1,175.", "21%"),
      q("bulkhead", "Bulkhead injection only", "Price almost never varies.", "4%"),
      q("pipes", "Pipe or tie-hole leaks only", "Sewer, water, conduit, tie holes. Median $775.", "6%"),
      q("cracks", "2+ cracks, poured wall", "Priced per crack; short cracks and the count are the usual misses.", "16%"),
      q("cracks-plus", "Cracks plus extras", "Plus pipes, tie holes or drywall removal. You needed more info on half.", "6%"),
      q("floor", "Floor and slab cracks", "Small jobs, but a wide price range.", "4%"),
      q("steps", "Step resurfacing", "One or two sets of stairs. 27% of jobs had a callback.", "3%"),
      q("flat-resurfacing", "Flat resurfacing", "Patios, walks, garages, pool decks, parging. Half needed more info; 1 in 4 jobs had a callback.", "17%"),
      q("structural", "Structural", "Bowing, displacement, horizontal cracks, carbon fiber. A wrong call costs the most.", "13%"),
      q("masonry", "Stone, brick and block walls", "Photos were enough on only 17% of stone quotes; 37% needed a visit first.", "9%"),
      q("mixed", "Mixed or unusual", "Commercial, multi-unit, one-offs.", "3%"),
    ]),
    basis:
      "Kinds come from all 573 QuickBooks quotes (Sep 2024 to Nov 2026); share is of the last 12 months. Each draft's kind is read from its lines, so wall type and crack direction aren't split out yet. Right means emailed or accepted with the drafted items, quantities, prices and total (the Guarantee line is ignored).",
    flags: "Any quote with a finished wall in the way, no usable photos, a past failed repair, or an open customer question will draft for you, whatever its kind.",
  },
  {
    id: "followup",
    name: "“Just sent your quote” text",
    what: "After a quote email goes out, drafts the heads-up text as a Quo note.",
    kinds: {
      quiet: { name: "Quiet thread", sub: "No open customer question when the quote went out.", share: "", path: "fast" },
      "open-question": { name: "Open customer question", sub: "They asked something you hadn't answered yet.", share: "", path: "human" },
    },
    basis: "Graded against your first text to that number within 3 days of the draft (word match 97%+ is as drafted, 85%+ a light edit).",
  },
  {
    id: "stale-quote",
    name: "Stale-quote follow-ups",
    what: "Checks every open quote daily and drafts one check-in per customer.",
    kinds: {
      T1: { name: "First check-in", sub: "Silent customer, quote under 90 days.", share: "", path: "fast" },
      T2: { name: "Second check-in", sub: "Silent customer, quote under 90 days.", share: "", path: "fast" },
      T3: { name: "Final check-in", sub: "Over 90 days; closes out the file.", share: "", path: "learn" },
    },
    basis: "Graded against your first text to that number within 7 days of the draft.",
  },
  {
    id: "intake",
    name: "New-lead replies",
    what: "Drafts your first reply to a new texter: asks for photos and the address.",
    kinds: {
      "can-help": { name: "Can help", sub: "The reply asks for photos, name, address and email.", share: "", path: "learn" },
      "cant-help": { name: "Can't help", sub: "A kind decline, with a referral when there is one.", share: "", path: "learn" },
    },
    basis: "Graded against your first text within a day of the draft. If you called first, the draft isn't counted.",
  },
  {
    id: "ct-routing",
    name: "CT leads to Luc",
    what: "Drafts the hand-off text when a Connecticut lead writes in.",
    kinds: { all: { name: "CT hand-off", sub: "Connecticut lead to Luc.", share: "", path: "learn" } },
  },
  {
    id: "referral",
    name: "Referrals",
    what: "Drafts a referral mid-conversation when it's work we don't do.",
    kinds: { all: { name: "Referral", sub: "Out-of-scope work, pointed to someone who does it.", share: "", path: "learn" } },
  },
  {
    id: "scheduling",
    name: "Scheduling suggestions",
    what: "When a customer approves or asks to book, picks a slot.",
    notMeasured: "Not graded yet: comparing suggested slots with what you booked comes next.",
    kinds: {},
  },
  {
    id: "router",
    name: "Inbound router",
    what: "Sorts each incoming text and starts the right flow. Already does it itself.",
    live: true,
    notMeasured: "Its actions aren't graded yet: tracking what you undo comes next.",
    kinds: {},
  },
];

export const KIND_FALLBACK: Record<string, string> = { all: "Not read yet", unknown: "Before the verdict was logged" };

export interface KindRow extends KindMeta {
  kind: string;
  stats: KindStats | null;
}

export interface AutomationView {
  meta: AutomationMeta;
  stats: AutomationStats | null;
  kinds: KindRow[];
  ready: number;
}

export interface AutomationsData {
  views: AutomationView[];
  lastRun: { at?: string; mode?: string; graded?: number; errors?: number } | null;
  handGraded: number;
  gradedThisWeek: number;
}

function parse<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

export async function readAutomations(now = Date.now()): Promise<AutomationsData> {
  const redis = getRedis();
  const [rawDrafts, rawHand, lastRun] = await Promise.all([
    redis.hgetall<Record<string, unknown>>(keys.graderDrafts),
    redis.hgetall<Record<string, unknown>>(keys.graderHand),
    redis.get<AutomationsData["lastRun"]>(keys.graderLastRun),
  ]);
  const drafts = Object.values(rawDrafts ?? {}).map((r) => parse<GradedDraft>(r));
  const hand: Record<string, HandGrade> = {};
  for (const [id, r] of Object.entries(rawHand ?? {})) hand[id] = parse<HandGrade>(r);
  const stats = summarize(drafts, hand);
  const views = AUTOMATIONS.filter((m) => m.id !== "referral" || stats.has("referral")).map((meta) => {
    const s = stats.get(meta.id as Automation) ?? null;
    const seen = new Map((s?.kinds ?? []).map((k) => [k.kind, k]));
    const listed: KindRow[] = Object.entries(meta.kinds).map(([kind, km]) => ({ kind, ...km, stats: seen.get(kind) ?? null }));
    const extra: KindRow[] = (s?.kinds ?? [])
      .filter((k) => !meta.kinds[k.kind])
      .map((k) => ({ kind: k.kind, name: KIND_FALLBACK[k.kind] ?? k.kind, sub: "", share: "", path: k.path, stats: k }));
    const kinds = [...listed, ...extra];
    return { meta, stats: s, kinds, ready: kinds.filter((k) => k.stats?.qualifies).length };
  });
  const week = now - 7 * 86_400_000;
  return {
    views,
    lastRun: parse(lastRun),
    handGraded: Object.keys(hand).length,
    gradedThisWeek: drafts.filter((d) => d.gradedAt && Date.parse(d.gradedAt) >= week).length,
  };
}

export function isHandGrade(v: unknown): v is HandGradeValue {
  return typeof v === "string" && (HAND_GRADES as readonly string[]).includes(v);
}

/** Save (or clear, with null) Matt's grade on one draft. False when the draft id is unknown. */
export async function saveHandGrade(id: string, grade: HandGradeValue | null): Promise<boolean> {
  const redis = getRedis();
  if (!(await redis.hexists(keys.graderDrafts, id))) return false;
  if (grade === null) await redis.hdel(keys.graderHand, id);
  else await redis.hset(keys.graderHand, { [id]: JSON.stringify({ grade, at: new Date().toISOString() } satisfies HandGrade) });
  return true;
}
