/**
 * Drift guard between the Vercel cron schedules and what the watchdog
 * watches. Every cron path in apps/worker, apps/middleware and apps/agent
 * vercel.json must be either watched (a check in
 * src/checks.ts reads the signal it writes) or listed in NOT_WATCHED with a
 * reason; every watched cron must still exist in a vercel.json.
 *
 * Adding a cron fails this test until you decide: watch it, or list it here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAILY_CRONS, INTERVAL_CRONS, HEARTBEATS } from '../src/checks.js';
import { GEMINI_CANARY_CRON } from '../src/gemini.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type App = 'worker' | 'middleware' | 'agent';
const APPS: App[] = ['worker', 'middleware', 'agent'];

function crons(app: App): Array<{ path: string; schedule: string }> {
  const json = JSON.parse(readFileSync(`${ROOT}apps/${app}/vercel.json`, 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>;
  };
  return json.crons ?? [];
}

function cronPaths(app: App): string[] {
  return crons(app).map((c) => `${app}:${c.path}`);
}

/** The vercel.json path of a watched job: worker routes are /api/<job>, middleware and agent crons /api/cron/<job>. */
function pathOf(app: App, job: string): string {
  return app === 'worker' ? `worker:/api/${job}` : `${app}:/api/cron/${job}`;
}

function scheduleOf(app: App, job: string): string | undefined {
  return crons(app).find((c) => `${app}:${c.path}` === pathOf(app, job))?.schedule;
}

/**
 * Which cron writes each signal the watchdog reads.
 * Middleware crons call trackCronRun('<job>') → keys.cronLastRun(job), and
 * the job name is the path's last segment (asserted below).
 * Worker heartbeats are written by one endpoint each.
 */
const HEARTBEAT_SOURCE: Record<string, string> = {
  worker: 'worker:/api/tick',
  'quote-drafter': 'worker:/api/quote-tick',
};

/** Worker and agent last-run stamps: the file that writes keys.cronLastRun(job), and the call it makes. */
const STAMP_SOURCE: Record<string, { file: string; needle: string }> = {
  sweep: { file: 'apps/worker/api/sweep.ts', needle: "recordRun('sweep'" },
  'inbound-tick': { file: 'apps/worker/api/inbound-tick.ts', needle: "recordRun('inbound-tick'" },
  'quote-email-tick': { file: 'apps/worker/api/quote-email-tick.ts', needle: "recordRun('quote-email-tick'" },
  'stale-quotes': { file: 'apps/worker/api/stale-quotes.ts', needle: "recordRun('stale-quotes'" },
  triage: { file: 'apps/worker/api/triage.ts', needle: "recordRun('triage'" },
  'ads-conversions': { file: 'packages/ads-conversions/src/run.ts', needle: "keys.cronLastRun('ads-conversions')" },
  'error-surface': { file: 'apps/agent/lib/error-surface.ts', needle: 'trackCronRun(JOB_NAME' },
};

/**
 * Crons the watchdog deliberately does not check, with why.
 * Do not add one without a reason.
 */
const NOT_WATCHED: Record<string, string> = {
  // The watchdog itself: it can't report its own death. It writes
  // keys.heartbeat('watchdog'); the agent's error-surface cron and the
  // outside pinger (worker /api/health) read it.
  'worker:/api/watchdog': 'self',
};

function watched(): Set<string> {
  const out = new Set<string>();
  for (const c of [...DAILY_CRONS, ...INTERVAL_CRONS]) out.add(pathOf(c.app, c.job));
  for (const h of HEARTBEATS) {
    const src = HEARTBEAT_SOURCE[h.name];
    if (src) out.add(src);
  }
  // Gemini degraded (src/gemini.ts) reads the canary's pass stamp.
  out.add(GEMINI_CANARY_CRON);
  return out;
}

/** Minutes between runs of a simple interval schedule ("* * * * *" = 1, "*\/N ..." = N). */
function intervalMin(schedule: string): number {
  const minute = schedule.split(' ')[0];
  if (minute === '*') return 1;
  const m = minute.match(/^\*\/(\d+)$/);
  if (!m) throw new Error(`not an interval schedule: ${schedule}`);
  return Number(m[1]);
}

describe('watchdog ↔ vercel.json cron drift', () => {
  const all = APPS.flatMap(cronPaths);

  it('reads crons from every app vercel.json', () => {
    for (const app of APPS) expect(cronPaths(app).length, app).toBeGreaterThan(0);
  });

  it('every watched heartbeat has a known source cron', () => {
    expect(HEARTBEATS.map((h) => h.name).filter((n) => !HEARTBEAT_SOURCE[n])).toEqual([]);
  });

  it('every cron is watched or explicitly not watched', () => {
    const w = watched();
    expect(all.filter((p) => !w.has(p) && !(p in NOT_WATCHED))).toEqual([]);
  });

  it('every watched cron still exists in a vercel.json', () => {
    expect([...watched()].filter((p) => !all.includes(p))).toEqual([]);
  });

  it('nothing is both watched and on the not-watched list, and the list has no stale entries', () => {
    const w = watched();
    expect(Object.keys(NOT_WATCHED).filter((p) => w.has(p))).toEqual([]);
    expect(Object.keys(NOT_WATCHED).filter((p) => !all.includes(p))).toEqual([]);
  });

  it('daily cron hours match the vercel.json schedules', () => {
    for (const c of DAILY_CRONS) {
      const schedule = scheduleOf(c.app, c.job);
      expect(schedule, c.job).toBeDefined();
      const [, hour, dom, mon, dow] = schedule!.split(' ');
      expect([hour, dom, mon, dow], c.job).toEqual([String(c.hourUtc), '*', '*', '*']);
      if (c.app === 'middleware') expect(schedule, c.job).toBe(`0 ${c.hourUtc} * * *`);
    }
  });

  it('interval windows allow at least two missed runs, so one skipped run never pages', () => {
    for (const c of INTERVAL_CRONS) {
      const schedule = scheduleOf(c.app, c.job);
      expect(schedule, c.job).toBeDefined();
      expect(c.maxAgeMin, c.job).toBeGreaterThanOrEqual(2 * intervalMin(schedule!));
    }
  });

  it('middleware cron job names match their paths', () => {
    // trackCronRun job names are hardcoded per file; the watchdog keys on the
    // path's last segment, so a renamed file would silently stop being watched.
    for (const p of all.filter((x) => x.startsWith('middleware:'))) {
      const job = p.split('/').pop()!;
      const src = readFileSync(`${ROOT}apps/middleware/api/cron/${job}.ts`, 'utf8');
      expect(src, p).toContain(`trackCronRun('${job}'`);
    }
  });

  it('every watched worker and agent job still writes its last-run stamp under the watched name', () => {
    const jobs = [...DAILY_CRONS, ...INTERVAL_CRONS].filter((c) => c.app !== 'middleware').map((c) => c.job);
    expect(jobs.filter((j) => !STAMP_SOURCE[j])).toEqual([]);
    for (const j of jobs) {
      const src = readFileSync(`${ROOT}${STAMP_SOURCE[j].file}`, 'utf8');
      expect(src, j).toContain(STAMP_SOURCE[j].needle);
    }
    expect(readFileSync(`${ROOT}apps/agent/lib/error-surface.ts`, 'utf8')).toContain("JOB_NAME = 'error-surface'");
  });
});
