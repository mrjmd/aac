/**
 * The triage pipeline the cron runs, kept apart from the route so a local
 * dry run (tools/src/scratch) can drive it with its own deps:
 * collect(deps) → analyze(snapshot, deps) → triageCandidates(findings,
 * stale lists, { now }). No bot-draft edit labels and no legacy shadow-log:
 * the cloud can't read the laptop files (plan decision 1), so a bot draft
 * Matt already handled can still show as an item until the worker harvests
 * labels from the Redis runlog.
 *
 * Pure compute: nothing is published here. The route publishes only after
 * the whole run finished inside its deadline.
 */
import { analyze, collect, triageCandidates, type FindingsFile } from '@aac/triage';
import type { TriageDeps } from './triage-deps.js';

type ItemCandidate = ReturnType<typeof triageCandidates>[number];

export interface TriageRunResult {
  data: FindingsFile;
  candidates: ItemCandidate[];
  collectMs: number;
  analyzeMs: number;
}

export async function runTriage(deps: Pick<TriageDeps, 'collect' | 'analyze' | 'loadStaleLists'>): Promise<TriageRunResult> {
  const t0 = deps.collect.now();
  const snapshot = await collect(deps.collect);
  const t1 = deps.collect.now();
  const data = await analyze(snapshot, deps.analyze);
  const t2 = deps.collect.now();
  const candidates = triageCandidates(data, await deps.loadStaleLists(), { now: deps.analyze.now() });
  return { data, candidates, collectMs: t1 - t0, analyzeMs: t2 - t1 };
}

/** Counts per key, e.g. findings by section or candidates by detector. */
export function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}

export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`triage run passed its ${Math.round(ms / 1000)}s budget`);
    this.name = 'DeadlineError';
  }
}

/**
 * Settle with `work`, or reject with DeadlineError once `ms` pass. Collect
 * and analyze can't stop mid-run, so the abandoned run keeps going until
 * the function is frozen; the caller just never publishes it.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
