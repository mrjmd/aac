/**
 * Error-surfacing tick: texts Matt new `health:errors` entries from the
 * agent comms line. Logic lives here (testable in isolation) so the cron
 * handler stays a thin auth + dispatch wrapper. The Walk-phase diagnostic
 * agent will wrap this same flow with LLM-judged diagnosis + proposed fix.
 *
 * Cursor: writers LPUSH onto `health:errors` and LTRIM to 100, so an index
 * would drift; the cursor is the timestamp of the newest entry that is
 * DONE. Each tick reads the whole list and considers entries newer than it.
 * The cursor only moves across a contiguous run of done entries (sent,
 * deduped, or counted in a suppressed line), so a failed send or an
 * overnight-held repeat is retried next tick, never skipped. Entries after
 * one that is not done are re-read next tick and dedupe on their claim.
 *
 * Rules:
 * - Dedup by (deploy SHA, fingerprint), claimed only AFTER the text went out.
 * - A fingerprint's first occurrence texts at any hour; a repeat (texted
 *   in the last 7 days, any deploy) only 8 AM to 9 PM Eastern, held until then.
 * - At most 5 error texts per tick, the newest five; the rest become one
 *   "N more errors suppressed" text naming their sources.
 * - A send that keeps failing is given up after 12h (logged), well inside
 *   the 24h claims, so the cursor can't stall into re-texting old entries.
 *
 * First-run policy: on cold boot (no cursor), stamp the newest timestamp as
 * the cursor and exit (no backlog flood).
 *
 * Every tick that delivered what it owed stamps `cron:error-surface:last-run`;
 * the worker watchdog alerts when that goes stale (25 min).
 */

import { createHash } from 'node:crypto';
import { createLogger } from '@aac/shared-utils/logger';
import { easternMinuteOfDay } from '@aac/shared-utils/eastern';
import { HEALTH_ERRORS_CAP } from '@aac/shared-utils/health';
import { QuoClient } from '@aac/api-clients/quo';
import {
  readRecentHealthErrors,
  getCronCursor,
  setCronCursor,
  claimErrorSurfaceNotification,
  isErrorSurfaceClaimed,
  markErrorFingerprintSurfaced,
  wasErrorFingerprintSurfaced,
  trackCronRun,
  HealthErrorEntry,
} from './redis.js';

const log = createLogger('agent:error-surface');

const JOB_NAME = 'error-surface';

/** Cap per tick: at most this many error texts, plus one "N more suppressed" text. */
export const MAX_SURFACED_PER_TICK = 5;

/** Repeats text only inside this Eastern window [start, end). First occurrences text any hour. */
export const DAY_START_H = 8;
export const DAY_END_H = 21;

/** A send still failing this long after the error was logged is given up (cursor may pass it). */
export const GIVE_UP_AFTER_MS = 12 * 3_600_000;

/**
 * How much of the error message to fold into the dedup fingerprint.
 *
 * Kept SHORT and conservative (60 chars after stripping JSON payloads) so
 * that the dynamic tail of an error — Gemini's varying response body,
 * upstream API error details, request IDs — doesn't defeat dedup. The
 * stable "operation failed" prefix is what we want to fingerprint.
 *
 * Trade-off: occasional false-merge across two genuinely different errors
 * that happen to share a 60-char prefix. Acceptable — false-merge means we
 * MISS one notification (still see the other 99); the alternative is
 * Matt getting blasted.
 */
const FINGERPRINT_MESSAGE_CHARS = 60;

export interface SurfaceResult {
  scanned: number;
  surfaced: number;
  skipped_first_run: number;
  skipped_stale: number;
  skipped_deduped: number;
  /** Repeats held overnight (texted after 8 AM). */
  held_night: number;
  /** Over the per-tick cap, reported in one "N more suppressed" text. */
  suppressed: number;
  /** Sends that kept failing past GIVE_UP_AFTER_MS, dropped. */
  given_up: number;
  errors: number;
  newest_timestamp: string | null;
}

/**
 * Build a stable, short fingerprint for an error entry. Same source +
 * same opening 120 chars → same fingerprint, regardless of details/ctx
 * (which often carry per-event IDs that would defeat dedup).
 */
export function errorFingerprint(entry: HealthErrorEntry): string {
  // Strip JSON/array bodies that vary per occurrence — anything after
  // `: {` or `: [` is a payload, not the error category.
  const stripped = entry.message.split(/:\s*[{[]/, 1)[0] ?? entry.message;
  // Also clip on the first newline (multi-line messages often embed
  // varying upstream response text in subsequent lines).
  const firstLine = stripped.split('\n', 1)[0] ?? stripped;
  const messageHead = firstLine
    .slice(0, FINGERPRINT_MESSAGE_CHARS)
    .replace(/\s+/g, ' ')
    .trim();
  const slug = `${entry.source}|${messageHead}`;
  return createHash('sha1').update(slug).digest('hex').slice(0, 16);
}

interface SurfaceDeps {
  quo: QuoClient;
  /** E.164 number Matt receives SMS on (whitelist target). */
  recipient: string;
  /** E.164 number to send from (agent comms line). */
  sender: string;
  now?: Date;
}

/** 8 AM to 9 PM Eastern. */
export function isDaytime(at: Date): boolean {
  const hour = Math.floor(easternMinuteOfDay(at) / 60);
  return hour >= DAY_START_H && hour < DAY_END_H;
}

/** One text for everything over the cap: count plus sources, busiest first. */
export function formatSuppressedSms(entries: HealthErrorEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  const sources = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => (n > 1 ? `${src} (${n})` : src))
    .join(', ');
  const n = entries.length;
  return `[errors] ${n} more error${n === 1 ? '' : 's'} suppressed (${MAX_SURFACED_PER_TICK}-text cap per run). Sources: ${sources}. Full list: health:errors.`;
}

type Status = 'sent' | 'deduped' | 'suppressed' | 'held' | 'failed' | 'given-up';
const DONE: ReadonlySet<Status> = new Set<Status>(['sent', 'deduped', 'suppressed', 'given-up']);

/**
 * Format a single error entry into an SMS body. Kept terse — readable
 * on a phone, includes the source + truncated message + ISO timestamp.
 * Walk-phase will replace this with diagnostic-agent output.
 */
export function formatErrorSms(entry: HealthErrorEntry): string {
  const ts = entry.timestamp;
  const msg = entry.message.length > 280 ? `${entry.message.slice(0, 277)}...` : entry.message;
  const details =
    entry.details && typeof entry.details === 'object'
      ? `\nctx: ${JSON.stringify(entry.details).slice(0, 200)}`
      : '';
  const app = entry.source.startsWith('worker:') ? 'worker' : 'middleware';
  return `[${app} error]\nsrc: ${entry.source}\nat: ${ts}\n${msg}${details}`;
}

/** Never throws: a Redis read failing is treated as "not claimed / not seen" (text rather than swallow). */
async function safeBool(label: string, fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`${label} failed; treating as false`, { err: (err as Error).message });
    return false;
  }
}

/**
 * Run one tick of the error-surface job (see the file header for the rules).
 */
export async function runErrorSurfaceTick(deps: SurfaceDeps): Promise<SurfaceResult> {
  const now = deps.now ?? new Date();
  const head = await readRecentHealthErrors(HEALTH_ERRORS_CAP);
  const cursor = await getCronCursor(JOB_NAME);

  const result: SurfaceResult = {
    scanned: head.length,
    surfaced: 0,
    skipped_first_run: 0,
    skipped_stale: 0,
    skipped_deduped: 0,
    held_night: 0,
    suppressed: 0,
    given_up: 0,
    errors: 0,
    newest_timestamp: cursor,
  };

  const finish = async (): Promise<SurfaceResult> => {
    // "Work happened" means every text this tick owed went out.
    if (result.errors === 0) {
      await trackCronRun(JOB_NAME, { sent: result.surfaced, skipped: result.skipped_deduped + result.held_night, errors: 0 });
    }
    return result;
  };

  if (head.length === 0) {
    log.debug('No errors in the health stream');
    return finish();
  }

  // First run: stamp the latest timestamp, don't forward any backlog.
  if (cursor === null) {
    const newest = head[0].timestamp;
    await setCronCursor(JOB_NAME, newest);
    result.skipped_first_run = head.length;
    result.newest_timestamp = newest;
    log.info('First run: stamped cursor at newest, no backlog surfaced', { newest, backlog: head.length });
    return finish();
  }

  // head is newest-first; work oldest-first.
  const entries = head.filter((e) => e.timestamp > cursor).reverse();
  result.skipped_stale = head.length - entries.length;
  if (entries.length === 0) {
    log.debug('No new errors since last tick', { cursor });
    return finish();
  }

  const daytime = isDaytime(now);
  const status: Array<Status | undefined> = new Array(entries.length);
  /** In-tick duplicates follow their first entry's outcome. */
  const dupOf: Array<number | undefined> = new Array(entries.length);
  const firstByKey = new Map<string, number>();
  const candidates: number[] = [];

  // 1. Classify: already texted, a repeat held overnight, or a candidate.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const sha = entry.commitSha || 'unknown';
    const fingerprint = errorFingerprint(entry);
    const key = `${sha}:${fingerprint}`;
    const first = firstByKey.get(key);
    if (first !== undefined) {
      dupOf[i] = first;
      continue;
    }
    firstByKey.set(key, i);
    if (await safeBool('Dedup check', () => isErrorSurfaceClaimed(sha, fingerprint))) {
      status[i] = 'deduped';
    } else if (!daytime && (await safeBool('Repeat check', () => wasErrorFingerprintSurfaced(fingerprint)))) {
      status[i] = 'held';
    } else {
      candidates.push(i);
    }
  }

  // 2. Cap: the newest five text; the rest go in one suppressed line.
  const toSend = candidates.slice(-MAX_SURFACED_PER_TICK);
  const overCap = candidates.slice(0, Math.max(0, candidates.length - MAX_SURFACED_PER_TICK));

  // 3. Send oldest-first; claim only after the text went out.
  for (const i of toSend) {
    const entry = entries[i];
    const sha = entry.commitSha || 'unknown';
    const fingerprint = errorFingerprint(entry);
    try {
      await deps.quo.sendMessage(deps.recipient, formatErrorSms(entry), deps.sender);
    } catch (err) {
      result.errors += 1;
      status[i] = 'failed';
      log.error('Failed to send error-surface SMS', err as Error, { entry });
      continue;
    }
    status[i] = 'sent';
    result.surfaced += 1;
    try {
      await claimErrorSurfaceNotification(sha, fingerprint);
      await markErrorFingerprintSurfaced(fingerprint);
    } catch (err) {
      // Sent but unclaimed: the worst case is the same error texting again.
      log.warn('Dedup claim after send failed', { err: (err as Error).message });
    }
  }

  // 4. One text for everything over the cap (in-tick duplicates included).
  if (overCap.length) {
    const over = new Set(overCap);
    const covered = entries.filter((_, i) => over.has(i) || (dupOf[i] !== undefined && over.has(dupOf[i]!)));
    log.warn('Capped errors surfaced this tick', { candidates: candidates.length, suppressed: covered.length });
    let ok = true;
    try {
      await deps.quo.sendMessage(deps.recipient, formatSuppressedSms(covered), deps.sender);
    } catch (err) {
      ok = false;
      result.errors += 1;
      log.error('Failed to send suppressed-errors SMS', err as Error, { suppressed: covered.length });
    }
    for (const i of overCap) status[i] = ok ? 'suppressed' : 'failed';
  }

  // 5. Resolve duplicates, give up on old failures, count.
  for (let i = 0; i < entries.length; i++) {
    if (dupOf[i] !== undefined) {
      const s = status[dupOf[i]!];
      status[i] = s === 'sent' ? 'deduped' : s;
    }
    if (status[i] === 'failed' && now.getTime() - Date.parse(entries[i].timestamp) > GIVE_UP_AFTER_MS) {
      status[i] = 'given-up';
      result.given_up += 1;
      log.error('Error-surface giving up on an entry whose send keeps failing', undefined, { entry: entries[i] });
    }
    if (status[i] === 'deduped') result.skipped_deduped += 1;
    if (status[i] === 'held') result.held_night += 1;
    if (status[i] === 'suppressed') result.suppressed += 1;
  }

  // 6. Advance the cursor across the contiguous done prefix only.
  let advanced: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    if (!DONE.has(status[i]!)) break;
    advanced = entries[i].timestamp;
  }
  if (advanced) {
    await setCronCursor(JOB_NAME, advanced);
    result.newest_timestamp = advanced;
  }

  return finish();
}
