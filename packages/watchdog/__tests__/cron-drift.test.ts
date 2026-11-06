/**
 * Drift guard between the Vercel cron schedules and what the watchdog
 * watches. Every cron path in apps/worker/vercel.json and
 * apps/middleware/vercel.json must be either watched (a check in
 * src/checks.ts reads the signal it writes) or listed in NOT_WATCHED with a
 * reason; every watched cron must still exist in a vercel.json.
 *
 * Adding a cron fails this test until you decide: watch it, or list it here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAILY_CRONS, INTERVAL_CRONS, HEARTBEATS } from '../src/checks.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function cronPaths(app: 'worker' | 'middleware'): string[] {
  const json = JSON.parse(readFileSync(`${ROOT}apps/${app}/vercel.json`, 'utf8')) as {
    crons?: Array<{ path: string }>;
  };
  return (json.crons ?? []).map((c) => `${app}:${c.path}`);
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

/**
 * Crons the watchdog deliberately does not check, with why.
 * TODO entries are gaps found when this test was added (2026-11-05); decide
 * per entry whether the watchdog should watch it. Do not add one without a reason.
 */
const NOT_WATCHED: Record<string, string> = {
  // The watchdog itself: it can't report its own death. It writes
  // keys.heartbeat('watchdog'); something outside the worker would have to read it.
  'worker:/api/watchdog': 'self',
  // TODO: 10-minute backstop sweep; writes keys.cronLastRun('sweep') (since 11/05), not read.
  'worker:/api/sweep': 'TODO',
  // TODO: 15-minute T4 email-channel tick; writes keys.cronLastRun('quote-email-tick') when it polls, not read.
  'worker:/api/quote-email-tick': 'TODO',
  // TODO: daily 11:00 UTC; already writes keys.cronLastRun('ads-conversions'), not read.
  'worker:/api/ads-conversions': 'TODO',
  // TODO: per-minute inbound router tick (off by default); writes keys.cronLastRun('inbound-tick'), not read.
  'worker:/api/inbound-tick': 'TODO',
  // TODO: daily stale-quote scan (mode off by default); writes keys.cronLastRun('stale-quotes') after a scan, not read.
  'worker:/api/stale-quotes': 'TODO',
  // TODO: daily triage run (mode off by default); writes keys.cronLastRun('triage') after a run, not read.
  'worker:/api/triage': 'TODO',
};

function watched(): Set<string> {
  const out = new Set<string>();
  for (const c of [...DAILY_CRONS, ...INTERVAL_CRONS]) out.add(`middleware:/api/cron/${c.job}`);
  for (const h of HEARTBEATS) {
    const src = HEARTBEAT_SOURCE[h.name];
    if (src) out.add(src);
  }
  return out;
}

describe('watchdog ↔ vercel.json cron drift', () => {
  const all = [...cronPaths('worker'), ...cronPaths('middleware')];

  it('reads crons from both vercel.json files', () => {
    expect(cronPaths('worker').length).toBeGreaterThan(0);
    expect(cronPaths('middleware').length).toBeGreaterThan(0);
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

  it('daily cron hours match the middleware schedules', () => {
    const json = JSON.parse(readFileSync(`${ROOT}apps/middleware/vercel.json`, 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    for (const c of DAILY_CRONS) {
      const entry = json.crons.find((x) => x.path === `/api/cron/${c.job}`);
      expect(entry?.schedule, c.job).toBe(`0 ${c.hourUtc} * * *`);
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
});
