/**
 * Error-surfacing tick — Crawl-phase logic for routing middleware errors
 * to Matt via SMS from the agent comms line.
 *
 * Logic lives here (testable in isolation) so the cron handler stays a
 * thin auth + dispatch wrapper. The Walk-phase diagnostic agent will
 * wrap this same flow with LLM-judged diagnosis + proposed fix.
 *
 * Cursor semantics: middleware LPUSHes onto `health:errors` and LTRIMs
 * to 100, so a strictly-monotonic numeric index would drift. Instead we
 * track the timestamp of the most-recently-surfaced entry. On each
 * tick we read the head of the list and forward only entries newer
 * than the cursor (or, on first run, just the head entry — see below).
 *
 * First-run policy: on cold boot (no cursor), we DO NOT page-flood Matt
 * with the last 100 errors. We just stamp the latest timestamp as the
 * starting cursor and exit. From the next tick onward, only new errors
 * surface.
 */

import { createLogger } from '@aac/shared-utils/logger';
import { QuoClient } from '@aac/api-clients/quo';
import { readRecentHealthErrors, getCronCursor, setCronCursor, HealthErrorEntry } from './redis.js';

const log = createLogger('agent:error-surface');

const JOB_NAME = 'error-surface';

/** Cap per tick — even if many errors accumulated, don't dump >5 SMS at once. */
const MAX_SURFACED_PER_TICK = 5;

export interface SurfaceResult {
  scanned: number;
  surfaced: number;
  skipped_first_run: number;
  skipped_stale: number;
  errors: number;
  newest_timestamp: string | null;
}

interface SurfaceDeps {
  quo: QuoClient;
  /** E.164 number Matt receives SMS on (whitelist target). */
  recipient: string;
  /** E.164 number to send from (agent comms line). */
  sender: string;
}

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
  return `[middleware error]\nsrc: ${entry.source}\nat: ${ts}\n${msg}${details}`;
}

/**
 * Run one tick of the error-surface job.
 *
 * - Read the head of middleware's health-errors list.
 * - If no cursor exists yet: stamp the cursor at the newest entry and exit
 *   (so we don't dump backlog on first boot).
 * - Otherwise: forward every entry strictly newer than the cursor, up to
 *   MAX_SURFACED_PER_TICK, in chronological order (oldest first), then
 *   advance the cursor to the newest forwarded entry.
 */
export async function runErrorSurfaceTick(deps: SurfaceDeps): Promise<SurfaceResult> {
  const head = await readRecentHealthErrors(50);
  const cursor = await getCronCursor(JOB_NAME);

  const result: SurfaceResult = {
    scanned: head.length,
    surfaced: 0,
    skipped_first_run: 0,
    skipped_stale: 0,
    errors: 0,
    newest_timestamp: cursor,
  };

  if (head.length === 0) {
    log.debug('No errors in middleware health stream');
    return result;
  }

  // First run: stamp the latest timestamp, don't forward any backlog.
  if (cursor === null) {
    const newest = head[0].timestamp;
    await setCronCursor(JOB_NAME, newest);
    result.skipped_first_run = head.length;
    result.newest_timestamp = newest;
    log.info('First run — stamped cursor at newest, no backlog surfaced', {
      newest,
      backlog: head.length,
    });
    return result;
  }

  // New entries are those with timestamp > cursor. head is newest-first,
  // so reverse to get chronological order for SMS delivery.
  const newEntries = head.filter((e) => e.timestamp > cursor).reverse();
  result.skipped_stale = head.length - newEntries.length;

  if (newEntries.length === 0) {
    log.debug('No new errors since last tick', { cursor });
    return result;
  }

  const toSurface = newEntries.slice(-MAX_SURFACED_PER_TICK);
  if (toSurface.length < newEntries.length) {
    log.warn('Capped errors surfaced this tick', {
      pending: newEntries.length,
      surfacing: toSurface.length,
    });
  }

  for (const entry of toSurface) {
    try {
      await deps.quo.sendMessage(deps.recipient, formatErrorSms(entry), deps.sender);
      result.surfaced += 1;
      result.newest_timestamp = entry.timestamp;
    } catch (err) {
      result.errors += 1;
      log.error('Failed to send error-surface SMS', err as Error, { entry });
    }
  }

  if (result.newest_timestamp) {
    await setCronCursor(JOB_NAME, result.newest_timestamp);
  }

  return result;
}
