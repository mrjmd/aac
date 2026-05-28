/**
 * Cron job utilities — auth verification, shared constants, and shared
 * date/string helpers used by every cron handler.
 *
 * Vercel Cron calls endpoints with `Authorization: Bearer <CRON_SECRET>`.
 * The shared constants live here so the filter set (color, keyword,
 * duration) is one definition, not three slightly-divergent copies.
 *
 * See: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { getEnv } from './env.js';

const log = createLogger('cron');

// ── Auth ────────────────────────────────────────────────────────

/**
 * Verify that a request came from Vercel Cron (or an authorized caller).
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron invocations.
 * Returns true if authorized, false (and sends 401) if not.
 */
export function verifyCronAuth(req: VercelRequest, res: VercelResponse): boolean {
  const env = getEnv();

  // In development, skip auth if no secret configured
  if (!env.cron.secret) {
    if (env.nodeEnv === 'development') {
      log.debug('Cron auth skipped (development, no CRON_SECRET)');
      return true;
    }
    log.error('CRON_SECRET not configured in production');
    res.status(500).json({ error: 'Cron not configured' });
    return false;
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${env.cron.secret}`) {
    log.warn('Cron auth failed — invalid or missing Authorization header');
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}

// ── Shared filter constants ─────────────────────────────────────

/** Green color = scheduled or completed job. Used by followups + invoicing. */
export const GREEN_COLOR_IDS: string[] = ['10'];

/**
 * Reminder coverage = green (job) + yellow/5 (callback) + purple/3
 * (assessment). Broader than the invoicing set because all of these need
 * day-before reminders.
 */
export const REMINDER_COLOR_IDS: string[] = ['10', '5', '3'];

/** Keywords that mark an event as not a real billable job. */
export const NON_JOB_KEYWORDS: string[] = [
  'callback',
  'lunch',
  'dinner',
  'meeting',
  'estimate-only',
  'consultation-only',
];

/** Real jobs are at least 2 hours; shorter events are stops or check-ins. */
export const MIN_JOB_DURATION_MINUTES = 120;

// ── Shared helpers ──────────────────────────────────────────────

/**
 * Extract the first name from a full name string for SMS templating.
 * "John Smith" → "John", "John" → "John", "" → "there"
 */
export function extractFirstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

/**
 * Get an Eastern-timezone day range as ISO strings, relative to a base
 * date. `offsetDays` shifts from today: -1 = yesterday, 0 = today,
 * +1 = tomorrow.
 *
 * When `runDate` (YYYY-MM-DD) is supplied, it replaces "today" — used to
 * simulate the cron running on a different day during testing or backfill.
 */
export function getDayRangeEastern(
  offsetDays: number,
  runDate?: string,
): { timeMin: string; timeMax: string; dateLabel: string } {
  let base: Date;

  if (runDate && /^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    base = new Date(runDate + 'T12:00:00-04:00'); // Noon Eastern dodges DST edges
  } else {
    base = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  }

  base.setDate(base.getDate() + offsetDays);
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');

  const dateLabel = `${year}-${month}-${day}`;
  return {
    timeMin: `${dateLabel}T00:00:00-04:00`,
    timeMax: `${dateLabel}T23:59:59-04:00`,
    dateLabel,
  };
}

/**
 * ISO date (YYYY-MM-DD) for "N days ago" in UTC — used as a lower bound on
 * QB queries like "any invoice for this customer since". UTC is fine here
 * because QB applies its own timezone tolerance to date filters.
 */
export function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse the `[deal:N]` marker from a calendar event description. Returns
 * the deal ID if present, or null. The marker is the canonical deal↔event
 * link: see docs/projects/apps-agent.md → "Deal model". A single deal can
 * carry many events (assessment + multi-day repair + callbacks) so the
 * marker lives on the event side, not as a deal-side foreign key.
 */
export function parseDealMarker(description: string | null | undefined): number | null {
  if (!description) return null;
  const match = description.match(/\[deal:(\d+)\]/i);
  return match ? parseInt(match[1], 10) : null;
}
