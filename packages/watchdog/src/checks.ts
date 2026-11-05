/**
 * Pure pipe checks: signals + now → one Condition per watched pipe.
 * Thresholds are set so a healthy system never trips them; a trip means
 * real work (customer texts, invoices, drafts) has stopped flowing.
 */

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
}

/** A Quo activity this old with no processed event after it means the pipe is cut. */
export const QUO_STALE_MIN = 15;
/** Processing finishes seconds after the activity; allow this much clock slack. */
const QUO_SLACK_MS = 2 * MIN;

/** Middleware daily crons (apps/middleware/vercel.json, UTC hours) and how late a run may be. */
export const DAILY_CRONS: Array<{ job: string; hourUtc: number; impact: string }> = [
  { job: 'invoice-create', hourUtc: 11, impact: 'Finished jobs are not being invoiced.' },
  { job: 'job-reminders', hourUtc: 12, impact: 'Customers are not getting their day-before reminders.' },
  { job: 'job-followups', hourUtc: 13, impact: 'Post-job review asks are not going out.' },
  { job: 'deal-reconcile', hourUtc: 14, impact: 'Pipedrive deal stages are drifting from QuickBooks.' },
];
const DAILY_GRACE_MS = 90 * MIN;

/** Interval crons: job → max age before it counts as stopped. */
export const INTERVAL_CRONS: Array<{ job: string; maxAgeMin: number; impact: string }> = [
  { job: 'qb-reconcile', maxAgeMin: 75, impact: 'Quote acceptances and QuickBooks changes are not syncing (the 30-minute reconcile).' },
];

/** Worker heartbeats (every minute when healthy). */
export const HEARTBEATS: Array<{ name: string; maxAgeMin: number; label: string; impact: string }> = [
  { name: 'worker', maxAgeMin: 20, label: 'Drafts worker', impact: 'Intake and follow-up drafts have stopped.' },
  { name: 'quote-drafter', maxAgeMin: 20, label: 'Quote drafter', impact: 'Bot quote drafts have stopped.' },
];

const VERCEL_FIX = 'Check the project in Vercel (deployments, cron logs) and the latest deploy.';

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

  // 2. Middleware crons.
  for (const c of DAILY_CRONS) {
    const due = lastScheduled(now - DAILY_GRACE_MS, c.hourUtc);
    const last = s.crons[c.job] ? Date.parse(s.crons[c.job]!) : 0;
    const down = last < due;
    out.push({
      id: `cron:${c.job}`,
      down,
      title: `Middleware cron ${c.job} missed its run`,
      ...(down ? { since: new Date(due).toISOString() } : {}),
      impact: `${c.impact} Last run: ${fmt(s.crons[c.job])}.`,
      fix: VERCEL_FIX,
    });
  }
  for (const c of INTERVAL_CRONS) {
    const last = s.crons[c.job] ? Date.parse(s.crons[c.job]!) : 0;
    const down = now - last > c.maxAgeMin * MIN;
    out.push({
      id: `cron:${c.job}`,
      down,
      title: `Middleware cron ${c.job} stopped`,
      ...(down && last ? { since: new Date(last).toISOString() } : {}),
      impact: `${c.impact} Last run: ${fmt(s.crons[c.job])}.`,
      fix: VERCEL_FIX,
    });
  }

  // 3. Worker heartbeats.
  for (const h of HEARTBEATS) {
    const last = s.heartbeats[h.name] ? Date.parse(s.heartbeats[h.name]!) : 0;
    const down = now - last > h.maxAgeMin * MIN;
    out.push({
      id: `heartbeat:${h.name}`,
      down,
      title: `${h.label} stopped`,
      ...(down && last ? { since: new Date(last).toISOString() } : {}),
      impact: `${h.impact} Last heartbeat: ${fmt(s.heartbeats[h.name])}.`,
      fix: 'Check aac-worker-monorepo in Vercel (cron runs, function errors, env vars).',
    });
  }

  // 4. Middleware reachable.
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
