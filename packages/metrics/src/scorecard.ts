import type { GoogleAdsClient } from '@aac/api-clients/google-ads';
import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import type { QBEstimate, QBInvoice, QBPayment, QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoClient, QuoMessage } from '@aac/api-clients/quo';
import { EVENT_CLASS_COLOR_IDS, HOLD_TITLE_PREFIX } from '@aac/shared-utils/calendar';
import { easternDate } from '@aac/shared-utils/eastern';
import { isInternalPhone, quickNormalizePhone } from '@aac/shared-utils/phone';
import { buildTechUtilization, WORKDAY_HOURS } from './tech-utilization.js';
import { addDays, mondayOf } from './weeks.js';

/**
 * The weekly scorecard (EOS style, README §3 / round-2 §4): a handful of
 * measures as rows, the last 13 closed weeks as columns, plus this week so
 * far and the same week last year. Every value is computed from the source
 * for any past week, so history needs no accrual; only leads need a cache
 * (first contact per phone), seeded from the funnel study's ledger.
 */

/** First inbound contact and first reply for one phone. `at` null = seen, never inbound yet. */
export interface LeadFact {
  at: string | null;
  replyAt: string | null;
  /** When this phone's activity was last read; refetched when the thread moves after it. */
  checkedAt: string;
  /** Already a customer when they first wrote in (seed only): not a new lead. */
  existing?: boolean;
}

export type RowFormat = 'int' | 'hours' | 'days' | 'pct' | 'usdk' | 'weeks' | 'usd';

export interface ScoreRow {
  key: string;
  name: string;
  fmt: RowFormat;
  /** 1 = higher is better, -1 = lower is better. */
  dir: 1 | -1;
  /** Flat goal, or for a seasonal row the average week's goal. */
  goal: number | null;
  /** Volume rows: each week is judged against goal × that month's seasonal index. */
  seasonal?: boolean;
  /** One per `Scorecard.weeks`: the goal that week is judged against (null = no goal). */
  targets: Array<number | null>;
  lastYearTarget: number | null;
  /** Source, definition and which date it counts by (the ⓘ). */
  info: string;
  /** One per `Scorecard.weeks`; null = no data for that week. */
  values: Array<number | null>;
  /** The same week a year before the last closed week. */
  lastYear: number | null;
}

export interface Scorecard {
  /** Mondays: 13 closed weeks, then the current week (partial). */
  weeks: string[];
  rows: ScoreRow[];
  builtAt: string;
  /** Sources that failed or aren't wired, named on the card. */
  gaps: string[];
}

export const CLOSED_WEEKS = 13;
/** How far ahead "booked weeks out" looks. */
const BOOKED_HORIZON_WEEKS = 8;

/**
 * First-draft goals (11/06), for Matt to edit (README decision 3). Volume
 * rows are average-week goals, scaled each week by SEASONAL_INDEX (round-2
 * §4 hybrid): the Aug-Oct 2026 baselines divided by those months' mean
 * index. Payments in averages the charter's $50k a month (about $11.5k a
 * week) and follows the season half a month late. Rates and speeds are
 * flat. Assessments have
 * no goal (most quotes come from photos), nor Ads spend (the budget moves
 * with the season).
 */
export const SCORECARD_GOALS: Record<string, number> = {
  leads: 27,
  reply: 2,
  quotes: 9,
  quoted: 18,
  close: 55,
  booked: 2,
  jobs: 5,
  collected: 11.5,
  // Matt 11/06: average under two weeks from invoice to payment.
  paylag: 14,
};

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Month index Jan..Dec (1 = an average month), from the funnel study
 * (analysis/02-strategy/funnel-baseline-2026-11.md §6): two seasons of data,
 * shrunk halfway toward 1. Re-fit each January.
 */
export const SEASONAL_INDEX = {
  leads: [0.71, 0.67, 1.03, 0.93, 1.36, 1.23, 1.45, 1.3, 0.88, 1.16, 0.61, 0.63],
  quotes: [0.76, 0.71, 1.19, 0.93, 1.33, 1.24, 1.3, 1.31, 0.89, 1.13, 0.7, 0.66],
  invoiced: [0.63, 0.81, 1.24, 0.9, 1.11, 1.46, 0.91, 1.31, 0.92, 1.34, 0.91, 0.71],
} as const;

/**
 * Payments land about two weeks after the invoice (dollar-weighted mean,
 * QBO Sept 2024-Nov 2026), so a month's payments index is half its own
 * invoiced index and half the month before's.
 */
const PAYMENTS_INDEX = SEASONAL_INDEX.invoiced.map((v, i) => round((v + SEASONAL_INDEX.invoiced[(i + 11) % 12]!) / 2, 2));

/** Which index scales each seasonal row; rows not listed keep a flat goal. */
const SEASONAL_ROWS: Record<string, keyof typeof SEASONAL_INDEX | 'payments'> = {
  leads: 'leads',
  quotes: 'quotes',
  quoted: 'quotes',
  jobs: 'invoiced',
  collected: 'payments',
};

/** A week's target: the goal scaled by the index of the month its Thursday falls in. */
export function weekTarget(key: string, goal: number | null, monday: string, fmt: RowFormat): number | null {
  const series = SEASONAL_ROWS[key];
  if (goal == null || !series) return goal;
  const index = series === 'payments' ? PAYMENTS_INDEX : SEASONAL_INDEX[series];
  const t = goal * index[Number(addDays(monday, 3).slice(5, 7)) - 1]!;
  return fmt === 'int' ? Math.round(t) : round(t, 1);
}

export interface ScorecardInput {
  now: Date;
  leads: Record<string, LeadFact>;
  estimates: QBEstimate[];
  payments: QBPayment[];
  /** Invoices the payments link to (for days to get paid). */
  invoices: QBInvoice[];
  events: CalendarEvent[];
  techEmails: readonly string[];
  /** Google Ads spend per day; null when Ads isn't wired. */
  spend: Array<{ date: string; cost: number }> | null;
  gaps?: string[];
}

/** The Mondays the card shows, oldest first, and the one a year before the last closed week. */
export function scorecardWeeks(today: string): { weeks: string[]; lastYear: string } {
  const current = mondayOf(today);
  const weeks = Array.from({ length: CLOSED_WEEKS + 1 }, (_, i) => addDays(current, -7 * (CLOSED_WEEKS - i)));
  return { weeks, lastYear: addDays(weeks[CLOSED_WEEKS - 1]!, -364) };
}

/** The earliest day any row reads (close rate looks 7 weeks behind the last-year week). */
export function scorecardFrom(today: string): string {
  const { weeks, lastYear } = scorecardWeeks(today);
  return addDays(lastYear < weeks[0]! ? lastYear : weeks[0]!, -56);
}

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const inWeek = (day: string | null | undefined, monday: string) => !!day && day >= monday && day < addDays(monday, 7);

function p75(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)]!;
}

/** When a quote went out: emailed time, else its date. Pending and never emailed = still a draft, not sent. */
export function quoteSentDay(e: QBEstimate): string | null {
  if (e.DeliveryInfo?.DeliveryTime) return easternDate(e.DeliveryInfo.DeliveryTime);
  if (e.TxnStatus === 'Pending' && e.EmailStatus !== 'EmailSent') return null;
  return e.TxnDate ?? null;
}

/** Won: accepted, converted, or invoiced from the quote. */
export function quoteWon(e: QBEstimate): boolean {
  return e.TxnStatus === 'Accepted' || e.TxnStatus === 'Converted' || !!e.LinkedTxn?.some((t) => t.TxnType === 'Invoice');
}

/** A multi-day job's later days, e.g. "Teddy Watler [cont]". */
const CONT_RE = /\[cont\]/i;
const eventDay = (e: CalendarEvent) => (e.start.length === 10 ? e.start : easternDate(e.start));

/** Pure: every row for the given weeks. */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const today = easternDate(input.now);
  const { weeks, lastYear } = scorecardWeeks(today);
  const nowMs = input.now.getTime();

  const leadList = Object.values(input.leads).filter((l): l is LeadFact & { at: string } => !!l.at && !l.existing);
  const sent = input.estimates.map((e) => ({ e, day: quoteSentDay(e) })).filter((q): q is { e: QBEstimate; day: string } => !!q.day);
  const invoiceDay = new Map(input.invoices.map((i) => [i.Id, i.TxnDate]));
  const paid = input.payments.flatMap((p) =>
    (p.Line ?? []).flatMap((l) =>
      (l.LinkedTxn ?? [])
        .filter((t) => t.TxnType === 'Invoice' && invoiceDay.get(t.TxnId) && p.TxnDate)
        .map((t) => ({ day: p.TxnDate!, amt: l.Amount, days: Math.max(0, dayDiff(invoiceDay.get(t.TxnId)!, p.TxnDate!)) })),
    ),
  );
  const past = input.events.filter((e) => !e.summary.startsWith(HOLD_TITLE_PREFIX) && Date.parse(e.start.length === 10 ? `${e.start}T12:00:00Z` : e.start) <= nowMs);

  const fns: Array<Omit<ScoreRow, 'values' | 'lastYear' | 'targets' | 'lastYearTarget'> & { week: (m: string) => number | null }> = [
    {
      key: 'leads',
      name: 'New contacts in',
      fmt: 'int',
      dir: 1,
      goal: null,
      info: 'Phones that called or texted the business line for the first time (Quo), by the day of that first contact. Includes solicitations and wrong numbers; existing customers are left out where the funnel study knew them.',
      week: (m) => leadList.filter((l) => inWeek(easternDate(l.at), m)).length,
    },
    {
      key: 'reply',
      name: 'First reply, p75 (hours)',
      fmt: 'hours',
      dir: -1,
      goal: null,
      info: "Hours from a new contact's first call or text to our first reply (an answered call, or our first call or text back), 75th percentile, by the week they came in. Only contacts we replied to: solicitations and wrong numbers never get one and would drown it. Leads we dropped show on Sales.",
      week: (m) => {
        const h = p75(
          leadList
            .filter((l) => l.replyAt && inWeek(easternDate(l.at), m))
            .map((l) => (Date.parse(l.replyAt!) - Date.parse(l.at)) / 3_600_000),
        );
        return h == null ? null : round(h, 1);
      },
    },
    {
      key: 'assessments',
      name: 'Assessments done',
      fmt: 'int',
      dir: 1,
      goal: null,
      info: 'Purple (assessment) calendar events, by the day they happened. HOLD placeholders are left out.',
      week: (m) => past.filter((e) => e.colorId === EVENT_CLASS_COLOR_IDS.assessment && inWeek(eventDay(e), m)).length,
    },
    {
      key: 'quotes',
      name: 'Quotes sent',
      fmt: 'int',
      dir: 1,
      goal: null,
      info: 'QBO estimates by the day they were emailed (or their date when sent another way). Pending estimates never emailed are drafts and left out.',
      week: (m) => sent.filter((q) => inWeek(q.day, m)).length,
    },
    {
      key: 'quoted',
      name: 'Quoted ($k)',
      fmt: 'usdk',
      dir: 1,
      goal: null,
      info: 'Total of the quotes sent that week (QBO estimate totals), same dating as Quotes sent.',
      week: (m) => round(sent.filter((q) => inWeek(q.day, m)).reduce((n, q) => n + (q.e.TotalAmt ?? 0), 0) / 1000, 1),
    },
    {
      key: 'close',
      name: 'Close rate, quotes 4-8 wks old (%)',
      fmt: 'pct',
      dir: 1,
      goal: null,
      info: 'Of the quotes sent 4 to 8 weeks before that week ended, the share accepted, converted or invoiced in QBO by now. The lag lets each cohort mature.',
      week: (m) => {
        const cohort = sent.filter((q) => q.day >= addDays(m, -49) && q.day < addDays(m, -21));
        return cohort.length ? Math.round((100 * cohort.filter((q) => quoteWon(q.e)).length) / cohort.length) : null;
      },
    },
    {
      key: 'booked',
      name: 'Weeks of work booked ahead',
      fmt: 'weeks',
      dir: 1,
      goal: null,
      info: `As of that Monday morning: Mike's booked hours in the next ${BOOKED_HORIZON_WEEKS} weeks (calendar events he attends, by event length, counting only events created by then), divided by a ${5 * WORKDAY_HOURS}-hour week.`,
      week: (m) => {
        const cutoff = `${m}T13:00:00Z`;
        const known = input.events.filter((e) => !e.created || e.created < cutoff);
        const tw = buildTechUtilization({ events: known, techEmails: input.techEmails, fromWeek: m, weeks: BOOKED_HORIZON_WEEKS });
        return round(tw.reduce((n, w) => n + w.bookedHours, 0) / (5 * WORKDAY_HOURS), 1);
      },
    },
    {
      key: 'jobs',
      name: 'Jobs done',
      fmt: 'int',
      dir: 1,
      goal: null,
      info: 'Green (job) calendar events, by the day they started. Follow-on days of a multi-day job ("[cont]" in the title) are left out.',
      week: (m) => past.filter((e) => e.colorId === EVENT_CLASS_COLOR_IDS.job && !CONT_RE.test(e.summary) && inWeek(eventDay(e), m)).length,
    },
    {
      key: 'collected',
      name: 'Payments in ($k)',
      fmt: 'usdk',
      dir: 1,
      goal: null,
      info: 'QBO payments received, by payment date. Received is not banked: a check counts the day it was recorded, deposited or not.',
      week: (m) => round(input.payments.filter((p) => inWeek(p.TxnDate, m)).reduce((n, p) => n + p.TotalAmt, 0) / 1000, 1),
    },
    {
      key: 'paylag',
      name: 'Days to get paid, 4-wk avg',
      fmt: 'days',
      dir: -1,
      goal: null,
      info: 'Days from invoice date to payment, averaged by dollars over the payments received in the 4 weeks ending that week (QBO payments linked to an invoice). Payments are dated when they were recorded, so until the books are reconciled a late entry reads as a slow payer.',
      week: (m) => {
        const ps = paid.filter((p) => p.day >= addDays(m, -21) && p.day < addDays(m, 7));
        const total = ps.reduce((n, p) => n + p.amt, 0);
        return total > 0 ? Math.round(ps.reduce((n, p) => n + p.days * p.amt, 0) / total) : null;
      },
    },
    {
      key: 'spend',
      name: 'Google Ads spend',
      fmt: 'usd',
      dir: -1,
      goal: null,
      info: 'Google Ads cost by day (account time zone). Other marketing spend is not included yet.',
      week: (m) => (input.spend ? Math.round(input.spend.filter((d) => inWeek(d.date, m)).reduce((n, d) => n + d.cost, 0)) : null),
    },
  ];

  return {
    weeks,
    builtAt: input.now.toISOString(),
    gaps: [...(input.gaps ?? []), ...(input.spend ? [] : ['Google Ads spend (Ads not configured)'])],
    rows: fns.map(({ week, ...row }) => {
      const goal = SCORECARD_GOALS[row.key] ?? row.goal;
      return {
        ...row,
        goal,
        ...(row.key in SEASONAL_ROWS && goal != null ? { seasonal: true } : {}),
        targets: weeks.map((m) => weekTarget(row.key, goal, m, row.fmt)),
        values: weeks.map(week),
        lastYear: week(lastYear),
        lastYearTarget: weekTarget(row.key, goal, lastYear, row.fmt),
      };
    }),
  };
}

/** The Upstash calls the lead cache uses. */
export interface LeadRedis {
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hset<T>(key: string, kv: { [field: string]: T }): Promise<number>;
}

/**
 * Pure: a phone's first inbound contact and our first reply after it, from
 * its messages and calls. An answered incoming call is a reply at answer.
 */
export function leadFactOf(messages: QuoMessage[], calls: QuoCall[], now: Date, knownAt?: string | null): LeadFact {
  const inbound = [
    ...messages.filter((m) => m.direction === 'incoming').map((m) => m.createdAt),
    ...calls.filter((c) => c.direction === 'incoming').map((c) => c.createdAt),
  ].sort();
  const at = knownAt ?? inbound[0] ?? null;
  if (!at) return { at: null, replyAt: null, checkedAt: now.toISOString() };
  const replies = [
    ...messages.filter((m) => m.direction === 'outgoing' && m.createdAt > at).map((m) => m.createdAt),
    ...calls.filter((c) => c.direction === 'outgoing' && c.createdAt > at).map((c) => c.createdAt),
    ...calls.filter((c) => c.direction === 'incoming' && c.answeredAt && c.createdAt >= at).map((c) => c.answeredAt!),
  ].sort();
  return { at, replyAt: replies[0] ?? null, checkedAt: now.toISOString() };
}

/**
 * Bring the lead cache up to date: every 1:1 thread on the business line
 * that moved since `since`, for phones not settled yet (unknown, or no
 * reply yet and the thread moved after we last looked). Returns the facts
 * after the update.
 */
export async function refreshLeadFacts(
  deps: { quo: Pick<QuoClient, 'listConversations' | 'listMessages' | 'listCalls'>; redis: LeadRedis; ownLine: string; leadsKey: string },
  opts: { since: Date; now: Date; deadlineMs: number },
): Promise<{ facts: Record<string, LeadFact>; checked: number; added: number; partial: boolean }> {
  const facts = (await deps.redis.hgetall<Record<string, LeadFact>>(deps.leadsKey)) ?? {};
  const todo = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const res = await deps.quo.listConversations({ maxResults: 100, pageToken, updatedAfter: opts.since });
    for (const c of res.data ?? []) {
      const external = c.participants.filter((p) => !isInternalPhone(p, deps.ownLine));
      if (external.length !== 1 || c.participants.length > 2) continue;
      const phone = quickNormalizePhone(external[0]);
      if (!phone) continue;
      const f = facts[phone];
      if (f?.at && (f.replyAt || f.existing)) continue;
      if (f && c.lastActivityAt <= f.checkedAt) continue;
      todo.set(phone, c.lastActivityAt);
    }
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);

  let checked = 0;
  let added = 0;
  let partial = false;
  for (const phone of todo.keys()) {
    if (Date.now() > opts.deadlineMs) {
      partial = true;
      break;
    }
    const [messages, calls] = await Promise.all([
      deps.quo.listMessages({ participantE164: phone, maxResults: 100 }),
      deps.quo.listCalls({ participantE164: phone, maxResults: 50 }),
    ]);
    const prev = facts[phone];
    const fact = leadFactOf(messages.data ?? [], calls.data ?? [], opts.now, prev?.at);
    // A first contact already on record (the seed) stays put; only the reply can fill in.
    const next = prev?.at ? { ...prev, replyAt: prev.replyAt ?? fact.replyAt, checkedAt: fact.checkedAt } : fact;
    if (!prev?.at && next.at) added++;
    facts[phone] = next;
    await deps.redis.hset(deps.leadsKey, { [phone]: next });
    checked++;
  }
  return { facts, checked, added, partial };
}

/** The Upstash calls a scorecard run uses. */
export interface ScorecardRedis extends LeadRedis {
  set(key: string, value: string): Promise<unknown>;
}

/**
 * Nightly: bring the lead cache up to date, read QBO, the calendar and Ads
 * for the card's window, build every row, save it under `scorecardKey`. A
 * source that fails becomes a named gap (its rows show no data); QBO and
 * the calendar failing fails the run.
 */
export async function runScorecard(
  deps: {
    redis: ScorecardRedis;
    qb: Pick<QuickBooksClient, 'listEstimatesUpdatedSince' | 'listPaymentsSince' | 'listInvoicesSince'>;
    quo: Pick<QuoClient, 'listConversations' | 'listMessages' | 'listCalls'>;
    calendar: Pick<GoogleCalendarClient, 'listEvents'>;
    ads: Pick<GoogleAdsClient, 'dailySpend'> | null;
    techEmails: readonly string[];
    ownLine: string;
    keys: { scorecard: string; leads: string };
  },
  opts: { now: Date; leadsSince: Date; deadlineMs: number },
): Promise<{ scorecard: Scorecard; leadsChecked: number; leadsAdded: number; partial: boolean }> {
  const today = easternDate(opts.now);
  const from = scorecardFrom(today);
  const gaps: string[] = [];
  const leads = await refreshLeadFacts(
    { quo: deps.quo, redis: deps.redis, ownLine: deps.ownLine, leadsKey: deps.keys.leads },
    { since: opts.leadsSince, now: opts.now, deadlineMs: opts.deadlineMs },
  ).catch((err: Error) => {
    gaps.push(`Quo leads not refreshed (${err.message})`);
    return null;
  });
  const facts = leads?.facts ?? (await deps.redis.hgetall<Record<string, LeadFact>>(deps.keys.leads)) ?? {};
  const [estimates, payments, invoices, events, spend] = await Promise.all([
    deps.qb.listEstimatesUpdatedSince(`${from}T00:00:00Z`),
    deps.qb.listPaymentsSince(from),
    // A payment can settle an invoice months older than it.
    deps.qb.listInvoicesSince(addDays(from, -180)),
    deps.calendar.listEvents({
      timeMin: new Date(`${from}T00:00:00Z`).toISOString(),
      // Far enough ahead for the last week's booked-ahead window.
      timeMax: new Date(opts.now.getTime() + (BOOKED_HORIZON_WEEKS + 1) * 7 * 86_400_000).toISOString(),
    }),
    deps.ads
      ? deps.ads.dailySpend(from, today).catch((err: Error) => {
          gaps.push(`Google Ads spend (${err.message})`);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const scorecard = buildScorecard({ now: opts.now, leads: facts, estimates, payments, invoices, events, techEmails: deps.techEmails, spend, gaps });
  // A configured Ads source that failed is already named; don't also call it unconfigured.
  if (deps.ads && !spend) scorecard.gaps = scorecard.gaps.filter((g) => !g.includes('not configured'));
  await deps.redis.set(deps.keys.scorecard, JSON.stringify(scorecard));
  return { scorecard, leadsChecked: leads?.checked ?? 0, leadsAdded: leads?.added ?? 0, partial: leads?.partial ?? true };
}
