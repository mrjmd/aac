/**
 * System health, read straight from Redis (what the middleware, worker,
 * agent and watchdog write through @aac/shared-utils/health), plus the
 * saved CI snapshot. Nothing here calls an outside source on page load;
 * the CI card's source (GitHub) is read only by its snapshot refresh.
 */
import { GitHubClient } from "@aac/api-clients/github";
import { easternDate, shiftDate } from "@aac/shared-utils/eastern";
import { CONDITIONS, type HealthErrorEntry } from "@aac/shared-utils/health";
import { keys } from "@aac/shared-utils/redis";
import type { ItemCandidate } from "@aac/items";
import type { MiddlewareHealth } from "./middleware-health";
import { getRedis } from "./redis";
import { readSnapshot } from "./snapshots";
import {
  ciVerdict,
  JOBS_NOT_INVOICED_WINDOW_DAYS,
  skippedJobs,
  sumConditions,
  systemCandidates,
  type CiRun,
  type CiStatus,
  type CiVerdict,
  type ConditionHash,
  type EntityHash,
  type SkippedJob,
} from "./system-rules";

const MIN = 60_000;

/** Saved snapshot name for the CI card (cards.ci in lib/cards.ts). */
export const CI_CARD = "system:ci";
export const CI_ENV = "GITHUB_TOKEN";
const CI_REPO = { owner: "mrjmd", repo: "aac" } as const;
const CI_WORKFLOW = "ci.yml";
const CI_JOB = "check";

/** One automation's freshness signal and how stale it may get. */
export interface Signal {
  label: string;
  /** Which project runs it. */
  app: "middleware" | "worker" | "agent" | "laptop";
  kind: "heartbeat" | "cron";
  /** keys.heartbeat(name) or keys.cronLastRun(name). */
  name: string;
  maxAgeMin: number;
  /** Plain line: what it does. */
  what: string;
  /** Mode-gated or not yet live: "never" is grey, not red. */
  optional?: boolean;
}

const DAY_MIN = 26 * 60;

export const SIGNALS: Signal[] = [
  { label: "Watchdog", app: "worker", kind: "heartbeat", name: "watchdog", maxAgeMin: 15, what: "Outside-in pipe checks, texts on P1" },
  { label: "Drafts tick", app: "worker", kind: "heartbeat", name: "worker", maxAgeMin: 20, what: "Follow-up and intake drafts" },
  { label: "Quote drafter", app: "worker", kind: "heartbeat", name: "quote-drafter", maxAgeMin: 20, what: "Bot quote drafts" },
  { label: "Gemini canary", app: "worker", kind: "heartbeat", name: "gemini-canary", maxAgeMin: 135, what: "Hourly Gemini test call (last pass)" },
  { label: "Middleware health", app: "middleware", kind: "heartbeat", name: "middleware", maxAgeMin: 15, what: "Stamped when the watchdog checks /api/health" },
  { label: "invoice-create", app: "middleware", kind: "cron", name: "invoice-create", maxAgeMin: DAY_MIN, what: "Invoices today's jobs (7am)" },
  { label: "job-reminders", app: "middleware", kind: "cron", name: "job-reminders", maxAgeMin: DAY_MIN, what: "Day-before reminder texts (8am)" },
  { label: "job-followups", app: "middleware", kind: "cron", name: "job-followups", maxAgeMin: DAY_MIN, what: "Post-job review asks (9am)" },
  { label: "deal-reconcile", app: "middleware", kind: "cron", name: "deal-reconcile", maxAgeMin: DAY_MIN, what: "Pipedrive deal stages (10am)" },
  { label: "qb-reconcile", app: "middleware", kind: "cron", name: "qb-reconcile", maxAgeMin: 75, what: "QuickBooks acceptances, every 30 min" },
  { label: "sweep", app: "worker", kind: "cron", name: "sweep", maxAgeMin: 25, what: "10-minute drafts backstop" },
  { label: "inbound-tick", app: "worker", kind: "cron", name: "inbound-tick", maxAgeMin: 10, what: "Inbound router, every minute" },
  { label: "quote-email-tick", app: "worker", kind: "cron", name: "quote-email-tick", maxAgeMin: 40, what: "Quote email channel, every 15 min", optional: true },
  { label: "stale-quotes", app: "worker", kind: "cron", name: "stale-quotes", maxAgeMin: DAY_MIN, what: "Stale-quote follow-up drafts (daily)", optional: true },
  { label: "triage", app: "worker", kind: "cron", name: "triage", maxAgeMin: DAY_MIN, what: "Daily triage into Today (worker)", optional: true },
  { label: "ads-conversions", app: "worker", kind: "cron", name: "ads-conversions", maxAgeMin: DAY_MIN, what: "Google Ads offline conversions (daily)", optional: true },
  { label: "scorecard", app: "worker", kind: "cron", name: "scorecard", maxAgeMin: DAY_MIN, what: "Weekly scorecard rows (nightly)", optional: true },
  { label: "grader", app: "worker", kind: "cron", name: "grader", maxAgeMin: DAY_MIN, what: "Grades yesterday's drafts (daily)", optional: true },
  { label: "gemini-canary", app: "worker", kind: "cron", name: "gemini-canary", maxAgeMin: 135, what: "Canary run (pass or fail)" },
  { label: "error-surface", app: "agent", kind: "cron", name: "error-surface", maxAgeMin: 25, what: "Texts health errors every 10 min", optional: true },
];

export type Level = "green" | "yellow" | "red" | "gray";

export interface SignalRow extends Signal {
  at: string | null;
  level: Level;
  /** Today's (UTC) cron result, crons only. */
  result: { sent: number; skipped: number; errors: number } | null;
}

export function signalLevel(s: Signal, at: string | null, now: Date): Level {
  if (!at) return s.optional ? "gray" : "red";
  const age = now.getTime() - Date.parse(at);
  if (!Number.isFinite(age)) return "gray";
  return age > s.maxAgeMin * MIN ? "red" : "green";
}

export interface WatchdogOpen {
  id: string;
  since: string;
  firstSeenAt: string;
  ticks: number;
  alertedAt?: string;
}

export interface ConditionRow {
  name: string;
  label: string;
  today: number;
  week: number;
}

export interface SystemHealth {
  now: string;
  watchdog: WatchdogOpen[];
  signals: SignalRow[];
  conditions: ConditionRow[];
  jobs: SkippedJob[];
  errors: HealthErrorEntry[];
  errorCount: number;
  ci: { snap: { data: CiStatus; fetchedAt: string } | null; verdict: CiVerdict };
  middleware: MiddlewareHealth;
}

function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/** The last `n` Eastern days, newest first. */
export function lastDays(now: Date, n: number): string[] {
  const today = easternDate(now);
  return Array.from({ length: n }, (_, i) => shiftDate(today, -i));
}

/** Silent-skip counts (today + 7 days) and the jobs not invoiced. Redis only. */
export async function readConditions(now: Date): Promise<{ conditions: ConditionRow[]; jobs: SkippedJob[] }> {
  const redis = getRedis();
  const days = lastDays(now, JOBS_NOT_INVOICED_WINDOW_DAYS);
  const [counts, entities] = await Promise.all([
    Promise.all(days.map((d) => redis.hgetall<Record<string, number | string>>(keys.healthConditions(d)))),
    Promise.all(days.map((d) => redis.hgetall<Record<string, string>>(keys.healthConditionEntities(d)))),
  ]);
  const today = sumConditions([counts[0] as ConditionHash]);
  const week = sumConditions(counts as ConditionHash[]);
  const conditions = Object.keys(week)
    .map((name) => ({
      name,
      label: (CONDITIONS as Record<string, string>)[name] ?? name,
      today: today[name] ?? 0,
      week: week[name],
    }))
    .sort((a, b) => b.today - a.today || b.week - a.week);
  const jobs = skippedJobs(days.map((day, i) => ({ day, hash: entities[i] as EntityHash })));
  return { conditions, jobs };
}

/** The saved CI snapshot and its verdict (never fetched here). */
export async function readCi(now: Date): Promise<SystemHealth["ci"]> {
  const snap = await readSnapshot<CiStatus>(CI_CARD).catch(() => null);
  return { snap, verdict: ciVerdict(snap?.data ?? null, now) };
}

/** Webhook counts and recent errors, from the keys the middleware writes (no call to its /api/health). */
export async function readMiddlewareHealth(now = new Date()): Promise<MiddlewareHealth> {
  const redis = getRedis();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const webhook = async (source: string) => {
    const [a, b, last] = await Promise.all([
      redis.get<number>(keys.webhookCount(source, today)),
      redis.get<number>(keys.webhookCount(source, yesterday)),
      redis.get<string>(keys.webhookLast(source)),
    ]);
    return { processed24h: Number(a ?? 0) + Number(b ?? 0), lastProcessed: last ?? null };
  };
  try {
    const [pipedrive, quo, googleAds, raw] = await Promise.all([
      webhook("pipedrive"),
      webhook("quo"),
      webhook("google-ads"),
      redis.lrange<unknown>(keys.healthErrors, 0, 49),
    ]);
    const errors = raw
      .map((e) => parseJson<HealthErrorEntry>(e))
      .filter((e): e is HealthErrorEntry => !!e && !e.source.startsWith("worker:"))
      .map((e) => ({
        timestamp: e.timestamp,
        source: e.source,
        message: e.message,
        ...(e.details ? { details: Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, String(v)])) } : {}),
      }));
    return { status: "healthy", timestamp: now.toISOString(), metrics: { webhooks: { pipedrive, quo, googleAds }, errors } };
  } catch (err) {
    return { status: "unreachable", timestamp: now.toISOString(), error: `Redis: ${(err as Error).message}` };
  }
}

/** Everything the System health page shows. Redis + saved snapshot only. */
export async function readSystemHealth(now = new Date()): Promise<SystemHealth> {
  const redis = getRedis();
  const utcDay = now.toISOString().slice(0, 10);
  const [state, stamps, results, rawErrors, errorCount, cond, ci, middleware] = await Promise.all([
    redis.hgetall<Record<string, unknown>>(keys.watchdogState),
    Promise.all(SIGNALS.map((s) => redis.get<string>(s.kind === "heartbeat" ? keys.heartbeat(s.name) : keys.cronLastRun(s.name)))),
    Promise.all(SIGNALS.map((s) => (s.kind === "cron" ? redis.get<unknown>(keys.cronResult(s.name, utcDay)) : Promise.resolve(null)))),
    redis.lrange<unknown>(keys.healthErrors, 0, 19),
    redis.llen(keys.healthErrors),
    readConditions(now),
    readCi(now),
    readMiddlewareHealth(now),
  ]);
  const watchdog = Object.entries(state ?? {})
    .map(([id, v]) => {
      const o = parseJson<Omit<WatchdogOpen, "id">>(v);
      return o ? { id, ...o } : null;
    })
    .filter((o): o is WatchdogOpen => !!o)
    .sort((a, b) => a.since.localeCompare(b.since));
  return {
    now: now.toISOString(),
    watchdog,
    signals: SIGNALS.map((s, i) => ({
      ...s,
      at: stamps[i] ?? null,
      level: signalLevel(s, stamps[i] ?? null, now),
      result: parseJson<SignalRow["result"]>(results[i]),
    })),
    conditions: cond.conditions,
    jobs: cond.jobs,
    errors: rawErrors.map((e) => parseJson<HealthErrorEntry>(e)).filter((e): e is HealthErrorEntry => !!e),
    errorCount,
    ci,
    middleware,
  };
}

/** System items for Today, only when ongoing. Never throws (Today must render). */
export async function loadSystemCandidates(now = new Date()): Promise<ItemCandidate[]> {
  try {
    const [{ jobs }, ci] = await Promise.all([readConditions(now), readCi(now)]);
    return systemCandidates({ jobs, ci: ci.verdict });
  } catch {
    return [];
  }
}

// ── CI card source (read by the snapshot refresh only) ─────────────────

export async function fetchCiStatus(): Promise<CiStatus> {
  const token = process.env[CI_ENV];
  if (!token) return { configured: false, envVar: CI_ENV, runs: [] };
  const gh = new GitHubClient({ token, ...CI_REPO });
  const runs = await gh.listWorkflowRuns(CI_WORKFLOW, { branch: "main", perPage: 10 });
  const out: CiRun[] = [];
  let looked = 0;
  for (const r of runs) {
    const row: CiRun = {
      id: r.id,
      number: r.run_number,
      sha: r.head_sha.slice(0, 7),
      title: r.display_title ?? r.name ?? "",
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      url: r.html_url,
    };
    // The job verdict, for completed runs up to the first green one (the red streak), at most 5 lookups.
    if (r.status === "completed" && r.conclusion !== "cancelled" && looked < 5) {
      looked++;
      const job = (await gh.listRunJobs(r.id)).find((j) => j.name === CI_JOB);
      if (job) {
        row.conclusion = job.conclusion;
        const step = job.steps?.find((s) => s.conclusion === "failure");
        if (step) row.failedStep = step.name;
        if (job.html_url) row.url = job.html_url;
      }
      if (row.conclusion === "success") looked = 5;
    }
    out.push(row);
  }
  return { configured: true, envVar: CI_ENV, runs: out };
}

export const CI_MAX_AGE_MS = 15 * MIN;
