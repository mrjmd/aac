/**
 * Backtest replay — the trust-building Crawl tool.
 *
 * Walks the last N days of QB Estimate acceptances + Quo outbound texts,
 * replays each through the normalizers, and produces a diff table:
 * what *I* would have done vs. what *Matt* actually did.
 *
 * The Crawl scope focuses on the QB-approval path (deterministic — every
 * Accepted estimate produces a directive). The manual-schedule path is
 * stubbed until middleware's Gemini classifier ships its extension.
 *
 * Pure functions. CLI wiring lives in `tools/src/scheduling-backtest.ts`.
 */

import type { GoogleCalendarClient, CalendarEvent } from '@aac/api-clients/google-calendar';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import { normalizeQbApproval } from './normalize-qb-approval.js';
import type { NormalizerDeps, SchedulingDirective } from './types.js';

// ── Public types ──────────────────────────────────────────────────

export type MatchVerdict =
  | 'positive_match'
  | 'directive_no_event'
  | 'event_no_directive'
  | 'directive_filtered'
  | 'unknown';

export interface BacktestRow {
  /** ISO of the source event we replayed. */
  timestamp: string;
  source: string;
  customerName: string;
  customerPhone: string;
  qbEstimateId?: string;
  directive: SchedulingDirective | null;
  actualEvent: { id: string; startIso: string; colorId?: string; summary: string } | null;
  verdict: MatchVerdict;
  notes: string;
}

export interface BacktestSummary {
  rowCount: number;
  positiveMatches: number;
  directivesWithNoEvent: number;
  eventsWithNoDirective: number;
  filteredOut: number;
  agreementRate: number;
}

export interface ReplayQbApprovalsInput {
  /** Inclusive UTC. */
  from: Date;
  to: Date;
  /** Days after acceptance to search for a corresponding calendar event. */
  matchWindowDays?: number;
  /** Optional E.164 to scope to a single customer. */
  phone?: string;
}

export type ReplayDeps = NormalizerDeps & { cal: GoogleCalendarClient };

// ── QB-approval replay ────────────────────────────────────────────

export async function replayQbApprovals(
  deps: ReplayDeps,
  input: ReplayQbApprovalsInput,
): Promise<{ rows: BacktestRow[]; summary: BacktestSummary }> {
  const matchWindowDays = input.matchWindowDays ?? 30;

  const recent = await deps.qb.listRecentEstimates(input.from.toISOString());
  const accepted = recent.filter(
    (e) =>
      e.TxnStatus === 'Accepted' &&
      isInWindow(e.MetaData?.LastUpdatedTime, input.from, input.to),
  );

  const rows: BacktestRow[] = [];
  for (const estimate of accepted) {
    const row = await replayOneEstimate(deps, estimate, matchWindowDays, input.phone);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { rows, summary: summarize(rows) };
}

async function replayOneEstimate(
  deps: ReplayDeps,
  estimate: QBEstimate,
  matchWindowDays: number,
  phoneFilter: string | undefined,
): Promise<BacktestRow | null> {
  const directive = await normalizeQbApproval(deps, { estimate });
  const acceptedAt = estimate.MetaData?.LastUpdatedTime ?? estimate.MetaData?.CreateTime ?? '';

  if (phoneFilter && directive && directive.customerPhone !== phoneFilter) {
    return null;
  }

  const baseRow: Omit<BacktestRow, 'actualEvent' | 'verdict' | 'notes'> = {
    timestamp: acceptedAt,
    source: 'qb_webhook',
    customerName: estimate.CustomerRef.name ?? '(unknown)',
    customerPhone: directive?.customerPhone ?? '',
    qbEstimateId: estimate.Id,
    directive,
  };

  const event = await findMatchingJobEvent(deps.cal, {
    aroundIso: acceptedAt,
    days: matchWindowDays,
    customerName: estimate.CustomerRef.name ?? '',
  });

  if (directive && event) {
    return {
      ...baseRow,
      actualEvent: event,
      verdict: 'positive_match',
      notes: `Job event found within ${matchWindowDays}d of acceptance`,
    };
  }
  if (directive && !event) {
    return {
      ...baseRow,
      actualEvent: null,
      verdict: 'directive_no_event',
      notes: `Directive fired but no matching job event in ${matchWindowDays}d — investigate`,
    };
  }
  if (!directive && event) {
    return {
      ...baseRow,
      actualEvent: event,
      verdict: 'event_no_directive',
      notes: 'Calendar event exists but normalizer produced no directive — classifier miss',
    };
  }
  return {
    ...baseRow,
    actualEvent: null,
    verdict: 'directive_filtered',
    notes: 'Estimate not in Accepted state — filtered by normalizer',
  };
}

async function findMatchingJobEvent(
  cal: GoogleCalendarClient,
  opts: { aroundIso: string; days: number; customerName: string },
): Promise<BacktestRow['actualEvent']> {
  if (!opts.aroundIso || !opts.customerName) return null;
  const start = new Date(opts.aroundIso);
  const end = new Date(start.getTime() + opts.days * 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = await cal.listEvents({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    colorIds: ['10'],
    maxResults: 250,
  });

  const needleTokens = tokenize(opts.customerName);
  const hit = events.find((e) => {
    const haystack = `${e.summary} ${e.description ?? ''}`;
    const hayTokens = new Set(tokenize(haystack));
    return needleTokens.length > 0 && needleTokens.every((t) => hayTokens.has(t));
  });
  if (!hit) return null;
  return {
    id: hit.id,
    startIso: hit.start,
    colorId: hit.colorId,
    summary: hit.summary,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function isInWindow(iso: string | undefined, from: Date, to: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from.getTime() && t <= to.getTime();
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function summarize(rows: BacktestRow[]): BacktestSummary {
  const positiveMatches = rows.filter((r) => r.verdict === 'positive_match').length;
  const directivesWithNoEvent = rows.filter((r) => r.verdict === 'directive_no_event').length;
  const eventsWithNoDirective = rows.filter((r) => r.verdict === 'event_no_directive').length;
  const filteredOut = rows.filter((r) => r.verdict === 'directive_filtered').length;
  const denom = rows.length || 1;
  return {
    rowCount: rows.length,
    positiveMatches,
    directivesWithNoEvent,
    eventsWithNoDirective,
    filteredOut,
    agreementRate: Math.round((positiveMatches / denom) * 1000) / 1000,
  };
}

// ── Manual-schedule path (stub) ───────────────────────────────────

/**
 * Manual-schedule replay is blocked on the middleware Gemini classifier
 * extension. When that ships, this function will:
 *   1. Pull Matt's outbound Quo messages in the date window
 *   2. Run each through the classifier
 *   3. For each detected manual_schedule intent, normalize and diff
 *      against the actual calendar event Mike worked
 * Stub today so the CLI can preview structure.
 */
export function replayManualScheduleStub(): { rows: BacktestRow[]; summary: BacktestSummary } {
  return {
    rows: [],
    summary: {
      rowCount: 0,
      positiveMatches: 0,
      directivesWithNoEvent: 0,
      eventsWithNoDirective: 0,
      filteredOut: 0,
      agreementRate: 0,
    },
  };
}
