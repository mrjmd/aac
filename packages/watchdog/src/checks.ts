/**
 * Pure pipe checks: signals + now → one Condition per watched pipe.
 * Thresholds are set so a healthy system never trips them; a trip means
 * real work (customer texts, invoices, drafts) has stopped flowing.
 */

import { keys } from '@aac/shared-utils/redis';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface Signals {
  now: Date;
  /** Newest conversation activity Quo reports for the business line, and the middleware's last processed Quo event. */
  quo: { newestActivityAt: string | null; lastProcessedAt: string | null } | { error: string };
  /** cron job → ISO last run (keys.cronLastRun). */
  crons: Record<string, string | null>;
  /** heartbeat name → ISO last beat (keys.heartbeat). */
  heartbeats: Record<string, string | null>;
  /** Mode-gated daily job → its current mode (Redis key or env), null when unset. */
  modes?: Record<string, string | null>;
  /** Mode-gated daily job → ISO time the watchdog first saw its mode on (keys.watchdogModeOn). */
  modeOnSince?: Record<string, string | null>;
  /** The quote-tick skip streak (keys.quoteDrafterSkip), null when the last tick ran. */
  quoteDrafterSkip?: QuoteDrafterSkip | null;
  /** GET on the middleware's /api/health. */
  middlewareHealth: { ok: boolean; detail: string };
}

export interface Condition {
  id: string;
  down: boolean;
  /** One line: what broke. */
  title: string;
  /** Since when, as evidence (ISO), when known. */
  since?: string;
  impact: string;
  fix: string;
  /** Recovery text, when "<title minus its failure verb> is back" would read wrong. */
  recovered?: string;
}

/** quote-tick's skip streak, as the worker writes it under keys.quoteDrafterSkip. */
export interface QuoteDrafterSkip {
  reason: 'locked' | 'no-assets';
  /** First skipped tick of the streak. */
  since: string;
  /** Latest skipped tick. */
  at: string;
  /** Consecutive skipped ticks. */
  ticks: number;
}

/** Where each app's crons live, for the text's fix line. */
export type CronApp = 'middleware' | 'worker' | 'agent';

/** Where a daily job's on/off switch lives: a Redis key or a worker env var. */
export type ModeSource = { redisKey: string } | { env: string };

/** A Quo activity this old with no processed event after it means the pipe is cut. */
export const QUO_STALE_MIN = 15;
/** Processing finishes seconds after the activity; allow this much clock slack. */
const QUO_SLACK_MS = 2 * MIN;

/**
 * Daily crons (UTC hours from each app's vercel.json) and how late a run may
 * be. A job with `mode` is watched only while that mode is dry or live, and
 * only from the first slot after the watchdog saw it switched on.
 */
export const DAILY_CRONS: Array<{ job: string; app: CronApp; hourUtc: number; label: string; impact: string; mode?: ModeSource }> = [
  { job: 'invoice-create', app: 'middleware', hourUtc: 11, label: 'Middleware cron invoice-create', impact: 'Finished jobs are not being invoiced.' },
  { job: 'job-reminders', app: 'middleware', hourUtc: 12, label: 'Middleware cron job-reminders', impact: 'Customers are not getting their day-before reminders.' },
  { job: 'job-followups', app: 'middleware', hourUtc: 13, label: 'Middleware cron job-followups', impact: 'Post-job review asks are not going out.' },
  { job: 'deal-reconcile', app: 'middleware', hourUtc: 14, label: 'Middleware cron deal-reconcile', impact: 'Pipedrive deal stages are drifting from QuickBooks.' },
  {
    job: 'ads-conversions',
    app: 'worker',
    hourUtc: 11,
    label: 'Google Ads conversions upload',
    impact: 'Google Ads is not getting offline conversions (real leads, quotes, won jobs), so bidding works from stale data.',
    mode: { env: 'ADS_CONVERSIONS_MODE' },
  },
  {
    job: 'stale-quotes',
    app: 'worker',
    hourUtc: 12,
    label: 'Stale-quote follow-up',
    impact: "Today's stale-quote follow-up drafts were not made; yesterday's queue is still showing.",
    mode: { redisKey: keys.staleQuotesMode },
  },
  {
    job: 'triage',
    app: 'worker',
    hourUtc: 13,
    label: 'Daily triage',
    impact: "Today's triage did not run, so the Command Center has no fresh items from it.",
    mode: { redisKey: keys.triageMode },
  },
];
const DAILY_GRACE_MS = 90 * MIN;

/** Interval crons: job → max age of its last-run stamp before it counts as stopped. */
export const INTERVAL_CRONS: Array<{ job: string; app: CronApp; maxAgeMin: number; label: string; impact: string }> = [
  {
    job: 'qb-reconcile',
    app: 'middleware',
    maxAgeMin: 75,
    label: 'Middleware cron qb-reconcile',
    impact: 'Quote acceptances and QuickBooks changes are not syncing (the 30-minute reconcile).',
  },
  {
    job: 'sweep',
    app: 'worker',
    maxAgeMin: 35,
    label: 'Drafts backstop sweep',
    impact: 'The 10-minute sweep has stopped, so follow-up and intake drafts the fast paths missed are not being caught.',
  },
  {
    job: 'inbound-tick',
    app: 'worker',
    maxAgeMin: 20,
    label: 'Inbound router',
    impact: 'Settled customer texts are not being read, so no intake, quote or referral drafts.',
  },
  {
    job: 'quote-email-tick',
    app: 'worker',
    maxAgeMin: 50,
    label: 'Quote email channel',
    impact: 'Customer emails about open quotes are not reaching the quote drafter. If the route answers skipped: no-gmail-scope, the Google token lost Gmail read access.',
  },
  {
    job: 'error-surface',
    app: 'agent',
    maxAgeMin: 25,
    label: 'Error alerts (agent error-surface)',
    impact: 'Error texts have stopped: failures anywhere in the system are not reaching you.',
  },
];

/** Worker heartbeats (every minute when healthy). */
export const HEARTBEATS: Array<{ name: string; maxAgeMin: number; label: string; impact: string }> = [
  { name: 'worker', maxAgeMin: 20, label: 'Drafts worker', impact: 'Intake and follow-up drafts have stopped.' },
  { name: 'quote-drafter', maxAgeMin: 20, label: 'Quote drafter', impact: 'Bot quote drafts have stopped.' },
];

/** quote-tick skipped on the run lock this many ticks (minutes) in a row: something holds it. */
export const QUOTE_LOCKED_TICKS = 15;
/** A skip streak whose last tick is older than this is not current (the tick itself stopped; the heartbeat says so). */
const SKIP_CURRENT_MS = 10 * MIN;

const VERCEL_FIX = 'Check the project in Vercel (deployments, cron logs) and the latest deploy.';
const WORKER_FIX = 'Check aac-worker-monorepo in Vercel (cron runs, function errors, env vars).';
const FIX: Record<CronApp, string> = {
  middleware: VERCEL_FIX,
  worker: WORKER_FIX,
  agent: 'Check the agent project in Vercel (cron runs for /api/cron/error-surface, CRON_SECRET, function errors).',
};

/** A daily job's mode counts as on when it is dry or live (unset or anything else is off, as the routes read it). */
export function modeOn(mode: string | null | undefined): boolean {
  return mode === 'dry' || mode === 'live';
}

/** The most recent HH:00 UTC at or before `t`. */
function lastScheduled(t: number, hourUtc: number): number {
  const d = new Date(t);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  return at <= t ? at : at - 24 * HOUR;
}

export function evaluate(s: Signals): Condition[] {
  const now = s.now.getTime();
  const out: Condition[] = [];

  // 1. Quo → middleware pipe (the 2026-10-19 class: Quo auto-disabled the webhook).
  if ('error' in s.quo) {
    // Can't see Quo right now: not evidence of a broken pipe, so no verdict either way.
  } else {
    const newest = s.quo.newestActivityAt ? Date.parse(s.quo.newestActivityAt) : NaN;
    const processed = s.quo.lastProcessedAt ? Date.parse(s.quo.lastProcessedAt) : 0;
    const down =
      Number.isFinite(newest) && now - newest >= QUO_STALE_MIN * MIN && processed < newest - QUO_SLACK_MS;
    out.push({
      id: 'quo-pipe',
      down,
      title: 'Quo → middleware pipe DOWN',
      ...(down ? { since: s.quo.newestActivityAt! } : {}),
      impact: `Quo shows activity at ${fmt(s.quo.newestActivityAt)} but the middleware last processed an event at ${fmt(s.quo.lastProcessedAt)}. Incoming texts and calls are not syncing (no Pipedrive, no drafts, no scheduling).`,
      fix: 'Most likely Quo auto-disabled the webhook. Quo → Settings → Webhooks → re-enable the middleware webhook. If it is enabled, check the middleware deploy in Vercel.',
    });
  }

  // 2. Crons: daily ones by their slot, interval ones by age.
  for (const c of DAILY_CRONS) {
    const due = lastScheduled(now - DAILY_GRACE_MS, c.hourUtc);
    const last = s.crons[c.job] ? Date.parse(s.crons[c.job]!) : 0;
    let down = last < due;
    if (c.mode) {
      // Off: not expected to run. Switched on after the slot: not late yet.
      const onSince = s.modeOnSince?.[c.job] ? Date.parse(s.modeOnSince[c.job]!) : now;
      down = down && modeOn(s.modes?.[c.job]) && onSince <= due;
    }
    out.push({
      id: `cron:${c.job}`,
      down,
      title: `${c.label} missed its run`,
      ...(down ? { since: new Date(due).toISOString() } : {}),
      impact: `${c.impact} Last run: ${fmt(s.crons[c.job])}.`,
      fix: FIX[c.app],
    });
  }
  for (const c of INTERVAL_CRONS) {
    const last = s.crons[c.job] ? Date.parse(s.crons[c.job]!) : 0;
    const down = now - last > c.maxAgeMin * MIN;
    out.push({
      id: `cron:${c.job}`,
      down,
      title: `${c.label} stopped`,
      ...(down && last ? { since: new Date(last).toISOString() } : {}),
      impact: `${c.impact} Last run: ${fmt(s.crons[c.job])}.`,
      fix: FIX[c.app],
    });
  }

  // 3. Quote drafter skip streaks: a held run lock, or no asset manifest.
  const skip = s.quoteDrafterSkip ?? null;
  const skipCurrent = !!skip && now - Date.parse(skip.at) <= SKIP_CURRENT_MS;
  const locked = skipCurrent && skip!.reason === 'locked' && skip!.ticks >= QUOTE_LOCKED_TICKS;
  out.push({
    id: 'quote-drafter:locked',
    down: locked,
    title: 'Quote drafter stuck on its run lock',
    recovered: 'Quote drafter run lock is free again',
    ...(locked ? { since: skip!.since } : {}),
    impact: `Every quote tick for ${skip?.ticks ?? 0} minutes found the run lock taken, so no bot quote drafts are being made.`,
    fix: 'Look for a quote-tick or manual quote-draft run that is still going in aac-worker-monorepo logs. The lock (quote-drafter:run-lock) expires 15 min after it was taken; if it keeps coming back, something keeps re-taking it.',
  });
  const noAssets = !!skip && skip.reason === 'no-assets';
  out.push({
    id: 'quote-drafter:no-assets',
    down: noAssets,
    title: 'Quote drafter has no asset manifest',
    recovered: 'Quote drafter asset manifest is back',
    ...(noAssets ? { since: skip!.since } : {}),
    impact: 'The pricing ruleset and exemplars are missing from Redis, so quote requests are consumed without a draft.',
    fix: 'Run sync-assets (tools) to republish the ruleset and exemplars to Blob and the manifest to Redis.',
  });

  // 4. Worker heartbeats. A quote drafter stuck on its lock is already reported above.
  for (const h of HEARTBEATS) {
    const last = s.heartbeats[h.name] ? Date.parse(s.heartbeats[h.name]!) : 0;
    const down = now - last > h.maxAgeMin * MIN && !(h.name === 'quote-drafter' && locked);
    out.push({
      id: `heartbeat:${h.name}`,
      down,
      title: `${h.label} stopped`,
      ...(down && last ? { since: new Date(last).toISOString() } : {}),
      impact: `${h.impact} Last heartbeat: ${fmt(s.heartbeats[h.name])}.`,
      fix: WORKER_FIX,
    });
  }

  // 5. Middleware reachable.
  out.push({
    id: 'middleware-health',
    down: !s.middlewareHealth.ok,
    title: 'Middleware health check failing',
    impact: `The middleware is not answering its health check (${s.middlewareHealth.detail}). Webhooks are probably failing too.`,
    fix: 'Check the middleware project in Vercel and vercel-status.com.',
  });

  return out;
}

/** "Thu 3:42 PM" in Eastern, or "never". */
export function fmt(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
