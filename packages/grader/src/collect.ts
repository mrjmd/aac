/**
 * Every draft any automation made, from the logs that recorded it: the
 * quote drafter's runlog, the message-drafts runlog, and the stale-quote
 * state. All three are trimmed or pruned, so the grader copies each draft
 * into its own record the first day it sees it.
 */
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { quoteKind, staleKind } from './kinds.js';
import type { Automation, DraftLine, GradedDraft } from './types.js';

type Json = Record<string, unknown>;

const parse = (raw: unknown): Json | null => {
  if (raw && typeof raw === 'object') return raw as Json;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return null;
  }
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const TEXT_TYPES = new Set<Automation>(['followup', 'intake', 'ct-routing', 'referral']);

/** Quote drafter runlog entries with a live created/updated draft. Later entries win. */
export function quoteDrafts(runlog: unknown[]): GradedDraft[] {
  const byId = new Map<string, GradedDraft>();
  for (const raw of runlog) {
    const e = parse(raw);
    const r = e && parse(e.record);
    if (!e || !r || e.mode !== 'live' || (r.outcome !== 'created' && r.outcome !== 'updated')) continue;
    const estimateId = str(r.estimateId);
    const at = str(e.at);
    if (!estimateId || !at) continue;
    const prior = byId.get(estimateId);
    if (prior && prior.draftedAt > at) continue;
    const lines = (Array.isArray(r.lines) ? r.lines : []) as DraftLine[];
    byId.set(estimateId, {
      id: `quote:${estimateId}`,
      automation: 'quote',
      ...quoteKind(lines),
      draftedAt: at,
      phone: str(r.phone),
      estimateId,
      doc: str(r.docNumber),
      customer: str(r.customer),
      lines,
      total: typeof r.total === 'number' ? r.total : undefined,
      grade: 'waiting',
    });
  }
  return [...byId.values()];
}

/** Message-drafts runlog entries that posted a draft. */
export function messageDrafts(runlog: unknown[]): GradedDraft[] {
  const out: GradedDraft[] = [];
  for (const raw of runlog) {
    const e = parse(raw);
    if (!e || e.outcome !== 'drafted') continue;
    const type = str(e.type) as Automation | undefined;
    const at = str(e.at);
    const phone = str(e.phone);
    const draft = str(e.draft);
    if (!type || !TEXT_TYPES.has(type) || !at || !phone || !draft) continue;
    const estimateId = str(e.estimateId);
    out.push({
      id: type === 'followup' && estimateId ? `followup:${estimateId}` : `${type}:${phone}:${at}`,
      automation: type,
      // followup kind is read from the thread when graded
      ...(type === 'intake' ? { kind: str(e.verdict) ?? 'unknown', path: 'learn' as const } : { kind: 'all', path: 'learn' as const }),
      draftedAt: at,
      phone,
      estimateId,
      doc: str(e.doc),
      draft,
      grade: 'waiting',
    });
  }
  return out;
}

/** Queued stale-quote touches from the stale-quote state hash. */
export function staleDrafts(state: Record<string, unknown> | null): GradedDraft[] {
  const out: GradedDraft[] = [];
  for (const raw of Object.values(state ?? {})) {
    const s = parse(raw);
    if (!s) continue;
    const estimateId = str(s.estimateId);
    for (const t of (Array.isArray(s.touches) ? s.touches : []) as Json[]) {
      const tier = str(t.tier);
      const at = str(t.queuedAt);
      const draft = str(t.draft);
      if (!estimateId || !tier || !at || !draft) continue;
      out.push({
        id: `stale-quote:${estimateId}:${tier}:${at}`,
        automation: 'stale-quote',
        ...staleKind(tier),
        draftedAt: at,
        phone: str(s.phone),
        estimateId,
        doc: str(s.doc),
        customer: str(s.customer),
        draft,
        grade: 'waiting',
      });
    }
  }
  return out;
}

export async function collectDrafts(redis: Redis): Promise<GradedDraft[]> {
  const [quote, message, stale] = await Promise.all([
    redis.lrange<unknown>(keys.quoteDrafterRunlog, 0, -1),
    redis.lrange<unknown>(keys.messageDraftRunlog, 0, -1),
    redis.hgetall<Record<string, unknown>>(keys.staleQuotesState),
  ]);
  return [...quoteDrafts(quote ?? []), ...messageDrafts(message ?? []), ...staleDrafts(stale)];
}
