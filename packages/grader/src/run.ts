/**
 * The daily grader run: copy new drafts into their records, then grade every
 * one still waiting. Reads QBO, Quo and Redis; writes only `grader:drafts`
 * (and nothing at all on a dry run). Sends nothing to anyone.
 */
import type { Redis } from '@upstash/redis';
import type { QBEstimate, QuickBooksClient } from '@aac/api-clients/quickbooks';
import type { QuoCall, QuoClient, QuoMessage } from '@aac/api-clients/quo';
import { keys } from '@aac/shared-utils/redis';
import { collectDrafts } from './collect.js';
import { gradeQuote, gradeText, hasOpenQuestion } from './grade.js';
import { followupKind } from './kinds.js';
import { GRADES, type Grade, type GradedDraft } from './types.js';

export interface GraderDeps {
  redis: Redis;
  qb: Pick<QuickBooksClient, 'getEstimate'>;
  quo: Pick<QuoClient, 'listMessages' | 'listCalls'>;
  log?: (line: string) => void;
}

export interface GraderResult {
  /** Drafts in the logs this run. */
  found: number;
  /** New records. */
  added: number;
  /** Records that got a final grade this run. */
  graded: number;
  /** Records whose grading threw (left waiting, tried again tomorrow). */
  errors: number;
  /** Stopped at the deadline with drafts still to grade. */
  partial: boolean;
  /** Every record by grade, after this run. */
  byGrade: Record<Grade, number>;
}

const HSET_CHUNK = 50;

export async function runGrader(
  deps: GraderDeps,
  opts: { dryRun: boolean; deadlineMs: number; now?: number },
): Promise<GraderResult> {
  const now = opts.now ?? Date.now();
  const log = deps.log ?? (() => {});
  const stored = (await deps.redis.hgetall<Record<string, unknown>>(keys.graderDrafts)) ?? {};
  const records = new Map<string, GradedDraft>();
  for (const [id, raw] of Object.entries(stored)) {
    records.set(id, (typeof raw === 'string' ? JSON.parse(raw) : raw) as GradedDraft);
  }

  const changed = new Set<string>();
  const found = await collectDrafts(deps.redis);
  let added = 0;
  for (const d of found) {
    const prior = records.get(d.id);
    // An updated quote draft replaces the one it superseded, until graded.
    if (prior && (prior.grade !== 'waiting' || prior.draftedAt >= d.draftedAt)) continue;
    if (!prior) added++;
    records.set(d.id, d);
    changed.add(d.id);
  }

  const thread = new Map<string, Promise<{ messages: QuoMessage[]; calls: QuoCall[] }>>();
  const threadOf = (phone: string) => {
    let t = thread.get(phone);
    if (!t) {
      t = Promise.all([
        deps.quo.listMessages({ participantE164: phone, maxResults: 100 }),
        deps.quo.listCalls({ participantE164: phone, maxResults: 30 }),
      ]).then(([m, c]) => ({ messages: m.data, calls: c.data }));
      thread.set(phone, t);
    }
    return t;
  };

  let graded = 0;
  let errors = 0;
  let partial = false;
  const waiting = [...records.values()].filter((r) => r.grade === 'waiting').sort((a, b) => a.draftedAt.localeCompare(b.draftedAt));
  for (const r of waiting) {
    if (Date.now() > opts.deadlineMs) {
      partial = true;
      break;
    }
    try {
      const next = await grade(deps, r, now, threadOf);
      if (next.grade !== 'waiting' || next.kind !== r.kind) {
        records.set(r.id, next);
        changed.add(r.id);
        if (next.grade !== 'waiting') graded++;
      }
    } catch (err) {
      errors++;
      log(`grade ${r.id} failed: ${(err as Error).message}`);
    }
  }

  if (!opts.dryRun && changed.size) {
    const ids = [...changed];
    for (let i = 0; i < ids.length; i += HSET_CHUNK) {
      const chunk: Record<string, string> = {};
      for (const id of ids.slice(i, i + HSET_CHUNK)) chunk[id] = JSON.stringify(records.get(id));
      await deps.redis.hset(keys.graderDrafts, chunk);
    }
  }

  const byGrade = Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>;
  for (const r of records.values()) byGrade[r.grade]++;
  log(`grader: ${found.length} in logs, ${added} new, ${graded} graded, ${errors} errors${partial ? ', partial' : ''}`);
  return { found: found.length, added, graded, errors, partial, byGrade };
}

/** QBO answers a deleted estimate with 400 / 610 Object Not Found, not the 404 getEstimate maps to null. */
async function getEstimate(deps: GraderDeps, id: string): Promise<QBEstimate | null> {
  try {
    return await deps.qb.getEstimate(id);
  } catch (err) {
    if (/\b610\b|Object Not Found/i.test((err as Error).message)) return null;
    throw err;
  }
}

async function grade(
  deps: GraderDeps,
  r: GradedDraft,
  now: number,
  threadOf: (phone: string) => Promise<{ messages: QuoMessage[]; calls: QuoCall[] }>,
): Promise<GradedDraft> {
  const gradedAt = new Date(now).toISOString();
  if (r.automation === 'quote') {
    if (!r.estimateId) return { ...r, grade: 'unused', gradedAt, note: 'no estimate id' };
    const current = await getEstimate(deps, r.estimateId);
    const g = gradeQuote({ current, lines: r.lines ?? [], total: r.total, draftedAt: r.draftedAt, now });
    return g.grade === 'waiting' ? r : { ...r, ...g, gradedAt };
  }
  if (!r.phone || !r.draft) return { ...r, grade: 'unused', gradedAt, note: 'no phone or draft text' };
  const { messages, calls } = await threadOf(r.phone);
  const kind = r.automation === 'followup' ? followupKind(hasOpenQuestion(messages, r.draftedAt)) : { kind: r.kind, path: r.path };
  const g = gradeText({ automation: r.automation, draft: r.draft, draftedAt: r.draftedAt, messages, calls, now });
  return g.grade === 'waiting' ? { ...r, ...kind } : { ...r, ...kind, ...g, gradedAt };
}
