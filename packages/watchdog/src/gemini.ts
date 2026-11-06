/**
 * Gemini degraded: the one counted condition that texts (owner, 2026-11-05).
 *
 * Two signals, both written elsewhere:
 * - the rolling-hour counts of `router.read_failed` and
 *   `dispatch.classifier_rejected` (countCondition keeps them in
 *   keys.healthConditionRecent), i.e. Gemini failing in the live paths;
 * - the hourly worker canary (runGeminiCanary below, /api/gemini-canary),
 *   which stamps keys.heartbeat('gemini-canary') on a pass and counts
 *   `gemini.canary_failed` on a failure.
 *
 * Down when the live paths failed GEMINI_DEGRADED_THRESHOLD+ times in the
 * last GEMINI_WINDOW_MIN minutes, or the canary hasn't passed for
 * CANARY_MAX_AGE_MIN (two hourly runs missed or failed). The usual watchdog
 * rules apply on top: two confirming ticks, a 6h reminder, one recovery text.
 */
import { countCondition, writeHeartbeat, type ConditionName, type ConditionRedis, type HealthRedis } from '@aac/shared-utils/health';
import { keys } from '@aac/shared-utils/redis';
import { fmt, type Condition } from './checks.js';

const MIN = 60_000;

/** Live-path Gemini failures counted over this window. */
export const GEMINI_WINDOW_MIN = 60;
/** This many live-path failures in the window = degraded. */
export const GEMINI_DEGRADED_THRESHOLD = 3;
/** The canary runs hourly; no pass for this long = two runs missed or failed. */
export const CANARY_MAX_AGE_MIN = 135;
/** The canary's cron (apps/worker/vercel.json), for the drift guard. */
export const GEMINI_CANARY_CRON = 'worker:/api/gemini-canary';
/** The canary's pass stamp, keys.heartbeat(CANARY_HEARTBEAT). */
export const CANARY_HEARTBEAT = 'gemini-canary';
/** Rolling-window conditions that mean Gemini is failing in a live path. */
export const GEMINI_LIVE_CONDITIONS: readonly ConditionName[] = ['router.read_failed', 'dispatch.classifier_rejected'];

/** The reads the Gemini check needs. `zcount` is optional so older fakes still type-check; without it there's no count verdict. */
export interface GeminiRedis {
  get<T>(key: string): Promise<T | null>;
  zcount?(key: string, min: number | string, max: number | string): Promise<number>;
}

export interface GeminiSignals {
  now: Date;
  /** condition → occurrences in the window; null when the counts couldn't be read. */
  recent: Record<string, number> | null;
  /** ISO time the canary last passed; null when it never has (fresh deploy) or couldn't be read. */
  canaryOkAt: string | null;
}

export async function gatherGeminiSignals(redis: GeminiRedis, now: Date): Promise<GeminiSignals> {
  const since = now.getTime() - GEMINI_WINDOW_MIN * MIN;
  const [recent, canaryOkAt] = await Promise.all([
    (async () => {
      if (!redis.zcount) return null;
      const counts = await Promise.all(
        GEMINI_LIVE_CONDITIONS.map((n) => redis.zcount!(keys.healthConditionRecent(n), since, now.getTime())),
      );
      return Object.fromEntries(GEMINI_LIVE_CONDITIONS.map((n, i) => [n, counts[i]]));
    })().catch(() => null),
    redis.get<string>(keys.heartbeat(CANARY_HEARTBEAT)).catch(() => null),
  ]);
  return { now, recent, canaryOkAt };
}

/** Null when there's no evidence either way (no counts, canary never passed). */
export function evaluateGemini(s: GeminiSignals): Condition | null {
  if (!s.recent && !s.canaryOkAt) return null;
  const live = s.recent ? Object.values(s.recent).reduce((a, b) => a + b, 0) : 0;
  const liveDown = live >= GEMINI_DEGRADED_THRESHOLD;
  const canaryAt = s.canaryOkAt ? Date.parse(s.canaryOkAt) : NaN;
  const canaryDown = Number.isFinite(canaryAt) && s.now.getTime() - canaryAt > CANARY_MAX_AGE_MIN * MIN;
  const down = liveDown || canaryDown;
  const parts: string[] = [];
  if (s.recent) {
    parts.push(
      `${s.recent['router.read_failed'] ?? 0} inbound router read failure(s) and ${s.recent['dispatch.classifier_rejected'] ?? 0} scheduling classifier failure(s) in the last hour`,
    );
  }
  parts.push(`the hourly canary last passed ${fmt(s.canaryOkAt)}`);
  return {
    id: 'gemini-degraded',
    down,
    // run.ts strips a trailing ' failing' for the recovery text: "Gemini (...) is back".
    title: 'Gemini (drafts, intake replies, scheduling) failing',
    ...(down && canaryDown && !liveDown ? { since: s.canaryOkAt! } : {}),
    impact: `${parts.join('; ')}. Customer replies, intake and follow-up drafts and scheduling classification are failing or falling back to templates.`,
    fix: 'Check the Gemini key and billing in Google AI Studio and whether the gemini-flash-latest alias moved; the worker function logs (gemini-canary, inbound-tick) have the error.',
  };
}

/** The Gemini condition for one watchdog tick ([] when there's no verdict). Never throws. */
export async function geminiConditions(redis: GeminiRedis, now: Date): Promise<Condition[]> {
  try {
    const c = evaluateGemini(await gatherGeminiSignals(redis, now));
    return c ? [c] : [];
  } catch {
    return [];
  }
}

// ── The hourly canary ─────────────────────────────────────────────────

/** One tiny structured call on the client's default model (the -latest alias), same probe as triage's D0. */
export interface CanaryGemini {
  extractEntities(text: string): Promise<{ firstName?: string | null } | null>;
}

export const CANARY_TEXT = 'Hi, my name is Canary Check and my email is canary@example.com.';

export interface CanaryResult {
  ok: boolean;
  detail: string;
}

/** Run the canary: stamp the pass, or count `gemini.canary_failed`. Never throws. */
export async function runGeminiCanary(deps: {
  gemini: CanaryGemini | null;
  redis: Pick<HealthRedis, 'set'> & ConditionRedis;
  now?: () => Date;
}): Promise<CanaryResult> {
  const now = deps.now?.() ?? new Date();
  let result: CanaryResult;
  if (!deps.gemini) {
    result = { ok: false, detail: 'GEMINI_API_KEY not set' };
  } else {
    try {
      const res = await deps.gemini.extractEntities(CANARY_TEXT);
      result =
        res?.firstName === 'Canary'
          ? { ok: true, detail: 'passed' }
          : { ok: false, detail: `unexpected answer: ${JSON.stringify(res)?.slice(0, 120)}` };
    } catch (err) {
      result = { ok: false, detail: (err as Error).message.slice(0, 200) };
    }
  }
  if (result.ok) await writeHeartbeat(deps.redis, CANARY_HEARTBEAT);
  else await countCondition(deps.redis, 'gemini.canary_failed', { now });
  return result;
}
