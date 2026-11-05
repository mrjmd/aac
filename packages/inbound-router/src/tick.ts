/**
 * Per-minute router pass (worker /api/inbound-tick). Off by default: it only
 * clears settled bursts so the settle clock never carries a stale burst start
 * into phase 4. Redis `inbound-router:mode` = 'shadow' turns on the shadow
 * pass: for each settled burst it reads the thread once, decides the routes,
 * and logs them to `inbound:shadow` next to what the old paths had done. It
 * posts no notes and touches no drafter state; the old paths run unchanged.
 */
import { keys } from '@aac/shared-utils/redis';
import { AUTO_RE, isDone, VOICEMAIL_GRACE_MIN } from '@aac/message-drafts';
import { getOpenQuote, INTERNAL, POST_SEND_RE, QUOTE_PROMISE_RE } from '@aac/quote-drafter';
import { decide } from './decide.js';
import { loadThread, readInbound, type Thread } from './read.js';
import { SETTLE_CAP_MS, SETTLE_QUIET_MS } from '@aac/shared-utils/inbound-settle';
import type { RouterDeps, ShadowEntry, ThreadState } from './types.js';

/** Bursts read per tick; the rest wait a minute (each read is one Gemini call with photos). */
export const MAX_READS_PER_TICK = 4;
/** Outlives the endpoint's 800s limit, so a crashed tick's lock clears itself. */
const LOCK_TTL_S = 900;
const SHADOW_LOG_MAX = 500;

export type RouterMode = 'off' | 'shadow';

export async function resolveRouterMode(deps: RouterDeps): Promise<RouterMode> {
  return (await deps.redis.get<string>(keys.inboundRouterMode)) === 'shadow' ? 'shadow' : 'off';
}

/** What the thread says has already happened. `burstFromMs` bounds "this burst". */
export function threadState(
  thread: Thread,
  burstFromMs: number,
  extra: { intakeDone: boolean; openQuote: boolean },
): ThreadState {
  const inBurst = (at: string) => new Date(at).getTime() >= burstFromMs;
  const outbound = thread.messages.filter((m) => m.direction === 'outgoing' && !AUTO_RE.test(m.text ?? ''));
  const newest = thread.messages
    .filter((m) => m.direction === 'incoming' || !AUTO_RE.test(m.text ?? ''))
    .reduce<(typeof thread.messages)[number] | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  const dialedAndTalked = thread.calls.some((c) => c.direction === 'outgoing' && (c.duration ?? 0) > 0);
  return {
    mattEngaged: outbound.length > 0 || dialedAndTalked,
    mattRepliedLast: newest?.direction === 'outgoing',
    intakeDone: extra.intakeDone,
    openQuote: extra.openQuote,
    quotePromised: outbound.some(
      (m) => inBurst(m.createdAt) && QUOTE_PROMISE_RE.test(m.text ?? '') && !POST_SEND_RE.test(m.text ?? ''),
    ),
    newPhotos: thread.messages
      .filter((m) => m.direction === 'incoming' && inBurst(m.createdAt))
      .reduce((n, m) => n + (m.media?.length ?? 0), 0),
  };
}

/**
 * Did the customer say anything in this burst: a text, a photo, or a
 * transcribed voicemail? A call that only rang out has nothing to read
 * (Quo's missed-call auto-reply already asks them to text).
 */
export function burstContent(thread: Thread, burstFromMs: number, nowMs: number): 'content' | 'waiting' | 'none' {
  const inBurst = (at: string) => new Date(at).getTime() >= burstFromMs;
  const said = thread.messages.some(
    (m) => m.direction === 'incoming' && inBurst(m.createdAt) && ((m.text ?? '').trim() || m.media?.length),
  );
  const missed = thread.calls.filter((c) => c.direction === 'incoming' && (c.duration ?? 0) === 0 && inBurst(c.createdAt));
  if (said || missed.some((c) => thread.voicemails.has(c.id))) return 'content';
  const lastMissed = Math.max(0, ...missed.map((c) => new Date(c.createdAt).getTime()));
  return lastMissed && nowMs - lastMissed < VOICEMAIL_GRACE_MIN * 60_000 ? 'waiting' : 'none';
}

/** Read, decide and log one settled phone. Never throws. */
export async function routePhone(deps: RouterDeps, phone: string, burstFromMs: number): Promise<ShadowEntry> {
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();
  if (INTERNAL.has(phone) || !phone.startsWith('+')) return { at, phone, outcome: 'skipped', detail: 'not a customer line' };
  try {
    const thread = await loadThread(deps.quo, phone);
    const content = burstContent(thread, burstFromMs, now);
    if (content === 'waiting') return { at, phone, outcome: 'waiting', detail: 'missed call, voicemail may still be transcribing' };
    if (content === 'none') return { at, phone, outcome: 'skipped', detail: 'no customer words in this burst (call rang out)' };
    const outcome = await readInbound(deps, phone, thread);
    const [intakeMarker, openQuote, quoteDue] = await Promise.all([
      deps.redis.hget<string>(keys.messageDraftIntakeDone, phone),
      getOpenQuote(deps.redis, phone),
      deps.redis.zscore(keys.quoteTriggerDue, phone),
    ]);
    const legacy = { intake: intakeMarker ?? null, quoteSettling: quoteDue !== null && quoteDue !== undefined };
    if (outcome.kind === 'failed') return { at, phone, outcome: 'failed', detail: outcome.reason, legacy };
    const { read } = outcome;
    const state = threadState(outcome.thread, burstFromMs, {
      intakeDone: isDone(intakeMarker ?? null, now),
      openQuote: !!openQuote,
    });
    const referrals = new Map((await deps.canHelp.referrals()).map((r) => [r.id, r]));
    return {
      at,
      phone,
      outcome: outcome.kind === 'unchanged' ? 'unchanged' : 'decided',
      read: {
        classification: read.classification,
        propertyState: read.propertyState,
        intents: read.intents,
        verdict: read.canHelp.verdict,
        ruleIds: read.canHelp.ruleIds,
        referrals: read.canHelp.referralIds.map((id) => {
          const r = referrals.get(id);
          return r ? `${r.name}${r.phone ? ` ${r.phone}` : ''}` : id;
        }),
        reason: read.canHelp.reason,
        photosRead: outcome.kind === 'read' ? outcome.photosRead : 0,
        entities: read.entities,
      },
      state,
      routes: decide(read, state),
      legacy,
    };
  } catch (err) {
    return { at, phone, outcome: 'failed', detail: (err as Error).message };
  }
}

export interface RouterTickSummary {
  mode: RouterMode;
  due: number;
  entries: ShadowEntry[];
}

/**
 * Drain settled phones. The due entry is removed before the thread is
 * loaded, so a text that lands mid-read is either in this read or re-arms
 * the clock for the next one; it is never dropped.
 */
export async function runInboundTick(deps: RouterDeps): Promise<RouterTickSummary> {
  const mode = await resolveRouterMode(deps);
  const now = deps.now?.() ?? Date.now();
  const due = await deps.redis.zrange<string[]>(keys.inboundDue, 0, now, { byScore: true });
  if (mode === 'off') {
    // Clear settled bursts unread, so each one starts fresh.
    if (due.length) {
      await deps.redis.zrem(keys.inboundDue, ...due);
      await deps.redis.hdel(keys.inboundFirst, ...due);
    }
    return { mode, due: due.length, entries: [] };
  }
  const entries: ShadowEntry[] = [];
  for (const phone of due.slice(0, MAX_READS_PER_TICK)) {
    const locked = await deps.redis.set(keys.inboundLock(phone), String(now), { nx: true, ex: LOCK_TTL_S });
    if (!locked) continue;
    try {
      const first = await deps.redis.hget<number | string>(keys.inboundFirst, phone);
      const firstMs = Number(first);
      await deps.redis.zrem(keys.inboundDue, phone);
      await deps.redis.hdel(keys.inboundFirst, phone);
      const burstFrom = Number.isFinite(firstMs) && firstMs > 0 ? firstMs : now - SETTLE_CAP_MS;
      const entry = await routePhone(deps, phone, burstFrom);
      if (entry.outcome === 'waiting') {
        // Check again shortly; keep the burst start so the read covers it all.
        await deps.redis.hset(keys.inboundFirst, { [phone]: burstFrom });
        await deps.redis.zadd(keys.inboundDue, { score: now + SETTLE_QUIET_MS, member: phone });
        continue;
      }
      entries.push(entry);
      try {
        await deps.redis.lpush(keys.inboundShadowLog, JSON.stringify(entry));
        await deps.redis.ltrim(keys.inboundShadowLog, 0, SHADOW_LOG_MAX - 1);
      } catch {
        // the shadow log is observability, never a failure path
      }
    } finally {
      await deps.redis.del(keys.inboundLock(phone));
    }
  }
  return { mode, due: due.length, entries };
}
