/**
 * Pure rules behind the System health page and the "float to Today when
 * ongoing" hook. No I/O here; lib/system-health.ts reads Redis and the
 * saved CI snapshot and hands the values in.
 *
 * Owner rules (2026-11-05): jobs not invoiced and a red CI never text and
 * never email. They show on System health, and become a Today item only
 * when the problem is ongoing, as defined below.
 */
import type { ItemCandidate } from "@aac/items";
import type { ConditionEntityRecord } from "@aac/shared-utils/health";

/**
 * Jobs not invoiced is "ongoing" at this many distinct jobs within
 * JOBS_NOT_INVOICED_WINDOW_DAYS. invoice-create dedupes per calendar event,
 * so each job is skipped exactly once, on its job day: "the same job two
 * days running" can't happen. One skipped job is a one-off (a new customer
 * not yet linked in QuickBooks) and the page is enough. Three in a week,
 * out of roughly ten jobs, means the Pipedrive / QuickBooks linking is
 * broken and invoices are quietly not going out, which costs real money.
 */
export const JOBS_NOT_INVOICED_ONGOING = 3;
export const JOBS_NOT_INVOICED_WINDOW_DAYS = 7;

/**
 * CI on main is "ongoing" red when the last CI_RED_ONGOING_RUNS completed
 * runs all failed (one red run is often fixed by the next push), or the
 * current red streak started CI_RED_ONGOING_HOURS ago or more (main has
 * been undeployable-in-principle for a day, even with no new pushes).
 */
export const CI_RED_ONGOING_RUNS = 2;
export const CI_RED_ONGOING_HOURS = 24;

// ── Silent-skip counts ──────────────────────────────────────────────────

/** keys.healthConditions(day) as Upstash returns it (numbers, or numeric strings). */
export type ConditionHash = Record<string, number | string> | null;

/** Sum a set of daily hashes into name → count. */
export function sumConditions(days: ConditionHash[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of days) {
    for (const [name, v] of Object.entries(h ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[name] = (out[name] ?? 0) + n;
    }
  }
  return out;
}

// ── Jobs not invoiced ──────────────────────────────────────────────────

export interface SkippedJob {
  /** Calendar event id. */
  id: string;
  label: string;
  /** The invoice-create.* condition (why). */
  reason: string;
  /** Eastern day it was skipped. */
  day: string;
  at: string;
}

/** keys.healthConditionEntities(day) as Upstash returns it (objects, or JSON strings). */
export type EntityHash = Record<string, ConditionEntityRecord | string> | null;

/** Every invoice-create.* skip across the given days, newest first, one row per job (latest reason wins). */
export function skippedJobs(days: Array<{ day: string; hash: EntityHash }>): SkippedJob[] {
  const byJob = new Map<string, SkippedJob>();
  for (const { day, hash } of days) {
    for (const [field, raw] of Object.entries(hash ?? {})) {
      const sep = field.indexOf("|");
      if (sep < 0) continue;
      const reason = field.slice(0, sep);
      if (!reason.startsWith("invoice-create.")) continue;
      const id = field.slice(sep + 1);
      let rec: ConditionEntityRecord | null = null;
      try {
        rec = typeof raw === "string" ? (JSON.parse(raw) as ConditionEntityRecord) : raw;
      } catch {
        rec = null;
      }
      const row: SkippedJob = { id, label: rec?.label ?? id, reason, day, at: rec?.at ?? `${day}T12:00:00Z` };
      const prev = byJob.get(id);
      if (!prev || prev.at < row.at) byJob.set(id, row);
    }
  }
  return [...byJob.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export function jobsNotInvoicedOngoing(jobs: SkippedJob[]): boolean {
  return jobs.length >= JOBS_NOT_INVOICED_ONGOING;
}

// ── CI ─────────────────────────────────────────────────────────────────

export interface CiRun {
  id: number;
  number: number;
  sha: string;
  title: string;
  /** queued | in_progress | completed */
  status: string | null;
  /** The "check" job's conclusion when known, else the run's. */
  conclusion: string | null;
  createdAt: string;
  url: string;
  /** First failing step of the check job, when it failed. */
  failedStep?: string;
}

/** What the CI card saves (cards.ci). `configured: false` = no token in env. */
export interface CiStatus {
  configured: boolean;
  /** The env var that enables the card. */
  envVar: string;
  /** Newest first, branch main. */
  runs: CiRun[];
}

export interface CiVerdict {
  state: "green" | "red" | "running" | "unknown";
  /** Consecutive failed completed runs, newest first. */
  redStreak: number;
  /** When the oldest run in the current red streak started. */
  redSince: string | null;
  latest: CiRun | null;
  ongoing: boolean;
}

/** Runs that settle nothing: superseded (cancel-in-progress) or skipped. */
const NEUTRAL = new Set(["cancelled", "skipped", "neutral", "stale"]);

export function ciVerdict(status: CiStatus | null, now: Date): CiVerdict {
  const none: CiVerdict = { state: "unknown", redStreak: 0, redSince: null, latest: null, ongoing: false };
  if (!status?.configured || !status.runs.length) return none;
  const latest = status.runs[0];
  const settled = status.runs.filter((r) => r.status === "completed" && !NEUTRAL.has(r.conclusion ?? ""));
  let redStreak = 0;
  let redSince: string | null = null;
  for (const r of settled) {
    if (r.conclusion === "success") break;
    redStreak++;
    redSince = r.createdAt;
  }
  const lastSettled = settled[0];
  const state: CiVerdict["state"] = !lastSettled
    ? latest.status === "completed"
      ? "unknown"
      : "running"
    : lastSettled.conclusion === "success"
      ? "green"
      : "red";
  const ongoing =
    redStreak >= CI_RED_ONGOING_RUNS ||
    (redStreak > 0 && redSince !== null && now.getTime() - Date.parse(redSince) >= CI_RED_ONGOING_HOURS * 3_600_000);
  return { state, redStreak, redSince, latest, ongoing };
}

// ── Today items (only when ongoing) ─────────────────────────────────────

const REASON_SHORT: Record<string, string> = {
  "invoice-create.no_person": "no Pipedrive person",
  "invoice-create.no_qb_customer": "no QuickBooks customer",
  "invoice-create.no_accepted_estimate": "no accepted quote",
  "invoice-create.multi_accepted_estimate": "several accepted quotes",
};

export function reasonShort(reason: string): string {
  return REASON_SHORT[reason] ?? reason;
}

/** The System items that float to Today. Empty unless a problem is ongoing. */
export function systemCandidates(input: { jobs: SkippedJob[]; ci: CiVerdict }): ItemCandidate[] {
  const out: ItemCandidate[] = [];
  if (jobsNotInvoicedOngoing(input.jobs)) {
    const ids = input.jobs.map((j) => j.id).sort();
    out.push({
      key: "sys:jobs-not-invoiced",
      detector: "SYS-INVOICE",
      area: "system",
      lane: "needs-you",
      severity: "red",
      sensitive: "money",
      title: `${input.jobs.length} jobs in ${JOBS_NOT_INVOICED_WINDOW_DAYS} days were not auto-invoiced`,
      detail: input.jobs
        .slice(0, 6)
        .map((j) => `${j.label} (${reasonShort(j.reason)})`)
        .join("; "),
      evidence: `invoice-create skipped ${input.jobs.length} jobs since ${input.jobs.at(-1)?.day}. One is a one-off; ${JOBS_NOT_INVOICED_ONGOING}+ in a week means the Pipedrive / QuickBooks link is broken.`,
      action: "Invoice them by hand in QuickBooks, then fix the customer links",
      link: "/health#jobs-not-invoiced",
      fingerprint: ids.join(","),
    });
  }
  if (input.ci.ongoing && input.ci.latest) {
    const failing = input.ci.latest;
    out.push({
      key: "sys:ci-red",
      detector: "SYS-CI",
      area: "system",
      lane: "needs-you",
      severity: "yellow",
      title: `CI on main has been red for ${input.ci.redStreak} run${input.ci.redStreak === 1 ? "" : "s"}`,
      detail: `Latest: #${failing.number} ${failing.title}${failing.failedStep ? `, failed at "${failing.failedStep}"` : ""}`,
      evidence: `Red since ${input.ci.redSince}. A push to main deploys production, so main should stay green.`,
      action: "Fix the failing check, or revert the change that broke it",
      link: failing.url,
      fingerprint: String(input.ci.redSince),
    });
  }
  return out;
}
