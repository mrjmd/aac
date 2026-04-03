/**
 * Post-Job Follow-Up Cron — Send follow-up SMS after completed jobs.
 *
 * Runs daily at 9 AM Eastern (13:00 UTC) via Vercel Cron.
 * Queries Google Calendar for jobs completed N days ago (default 2),
 * matches to Pipedrive contacts, sends follow-up SMS with Google review link.
 *
 * Supports dry run: GET /api/cron/job-followups?dry=true
 * Override delay: GET /api/cron/job-followups?delay=3
 *
 * Filtering (stricter than reminders — completed jobs only):
 * - Must have a technician as attendee
 * - Must have a location (address)
 * - Green color only (10) — real jobs, not callbacks or assessments
 * - Minimum 2 hours duration
 * - Excludes: callback, lunch, dinner, meeting, estimate-only, consultation-only
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { getCalendar, getPipedrive, getQuo } from '../../lib/clients.js';
import { getEnv } from '../../lib/env.js';
import { verifyCronAuth } from '../../lib/cron.js';
import { markCronAction, trackCronRun, logHealthError } from '../../lib/redis.js';
import { renderTemplate } from '../../lib/templates.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const log = createLogger('cron:job-followups');

/** Only completed jobs (green) get follow-ups */
const FOLLOWUP_COLOR_IDS = ['10'];

/** Same keyword exclusions as project import */
const EXCLUDE_KEYWORDS = ['callback', 'lunch', 'dinner', 'meeting', 'estimate-only', 'consultation-only'];

/** Minimum job duration in minutes */
const MIN_DURATION_MINUTES = 120;

/** Default days after job completion to send follow-up */
const DEFAULT_DELAY_DAYS = 1;

/** Google review URLs by region */
const REVIEW_LINKS: Record<string, string> = {
  // TODO: Replace with real Google review URLs
  MA: 'https://g.page/r/attackacrack-ma/review',
  CT: 'https://g.page/r/attackacrack-ct/review',
  default: 'https://g.page/r/attackacrack/review',
};

interface FollowUpResult {
  eventId: string;
  summary: string;
  jobDate: string;
  location: string;
  personName: string | null;
  phone: string | null;
  status: 'sent' | 'skipped_dedup' | 'skipped_no_person' | 'skipped_no_phone' | 'error';
  error?: string;
}

function extractFirstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

function extractPipedriveId(description: string | undefined): string | null {
  if (!description) return null;
  const match = description.match(/PipedriveID:\s*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Guess the region (MA or CT) from a location string.
 */
function guessRegion(location: string): string {
  const upper = location.toUpperCase();
  if (upper.includes(', CT') || upper.includes('CONNECTICUT')) return 'CT';
  if (upper.includes(', MA') || upper.includes('MASSACHUSETTS')) return 'MA';
  return 'default';
}

/**
 * Get a past date range in Eastern time.
 * If runDate is provided (YYYY-MM-DD), treat that as "today" and
 * look back N days. This simulates running the cron on that date.
 */
function getPastDateRange(daysAgo: number, runDate?: string): { timeMin: string; timeMax: string; dateLabel: string } {
  let base: Date;

  if (runDate && /^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    base = new Date(runDate + 'T12:00:00-04:00');
  } else {
    base = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  }

  base.setDate(base.getDate() - daysAgo);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyCronAuth(req, res)) return;

  const isDryRun = req.query.dry === 'true';
  const delayDays = parseInt(req.query.delay as string, 10) || DEFAULT_DELAY_DAYS;
  const dateOverride = req.query.date as string | undefined;
  const results: FollowUpResult[] = [];
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const env = getEnv();
    const calendar = getCalendar();
    const pipedrive = getPipedrive();

    const { timeMin, timeMax, dateLabel } = getPastDateRange(delayDays, dateOverride);

    log.info('Job follow-ups cron started', { isDryRun, delayDays, dateLabel, timeMin, timeMax });

    const events = await calendar.listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.google.technicianEmails,
      colorIds: FOLLOWUP_COLOR_IDS,
      requireLocation: true,
      excludeKeywords: EXCLUDE_KEYWORDS,
      minDurationMinutes: MIN_DURATION_MINUTES,
    });

    log.info('Completed jobs found', { count: events.length });

    for (const event of events) {
      const result = await processFollowUp(event, pipedrive, isDryRun);
      results.push(result);

      if (result.status === 'sent') sent++;
      else if (result.status.startsWith('skipped')) skipped++;
      else errors++;
    }

    if (!isDryRun) {
      await trackCronRun('job-followups', { sent, skipped, errors });
    }

    log.info('Job follow-ups cron complete', { isDryRun, sent, skipped, errors });

    return res.status(200).json({
      dryRun: isDryRun,
      lookbackDate: dateLabel,
      delayDays,
      summary: { sent, skipped, errors, totalEvents: events.length },
      results,
    });
  } catch (error) {
    log.error('Job follow-ups cron failed', error as Error);
    await logHealthError('cron:job-followups', (error as Error).message);

    return res.status(500).json({
      dryRun: isDryRun,
      error: (error as Error).message,
      summary: { sent, skipped, errors },
      results,
    });
  }
}

async function processFollowUp(
  event: CalendarEvent,
  pipedrive: ReturnType<typeof getPipedrive>,
  isDryRun: boolean
): Promise<FollowUpResult> {
  const baseResult = {
    eventId: event.id,
    summary: event.summary,
    jobDate: event.start.split('T')[0],
    location: event.location || '',
  };

  try {
    // Check dedup — did we already send a follow-up for this event?
    if (!isDryRun) {
      const isNew = await markCronAction('followup', event.id);
      if (!isNew) {
        return { ...baseResult, personName: null, phone: null, status: 'skipped_dedup' };
      }
    }

    // Find the Pipedrive person — always re-fetch full record by ID
    let person = null;
    const pipedriveId = extractPipedriveId(event.description);

    if (pipedriveId) {
      person = await pipedrive.getPerson(parseInt(pipedriveId, 10));
    }

    if (!person) {
      const searchResult = await pipedrive.searchPersonByName(event.summary);
      if (searchResult) {
        person = await pipedrive.getPerson(searchResult.id);
      }
    }

    if (!person) {
      log.warn('No Pipedrive person found for follow-up', {
        eventId: event.id,
        summary: event.summary,
      });
      return { ...baseResult, personName: null, phone: null, status: 'skipped_no_person' };
    }

    const primaryPhone = PipedriveClient.getPrimaryPhone(person);
    if (!primaryPhone) {
      log.warn('Pipedrive person has no phone number', {
        eventId: event.id,
        personId: person.id,
      });
      return {
        ...baseResult,
        personName: person.name,
        phone: null,
        status: 'skipped_no_phone',
      };
    }

    // Pick the right review link based on location
    const region = guessRegion(event.location || '');
    const reviewLink = REVIEW_LINKS[region] || REVIEW_LINKS.default;

    const firstName = extractFirstName(person.name);
    const message = renderTemplate('jobFollowUp', {
      firstName,
      reviewLink,
    });

    if (isDryRun) {
      return {
        ...baseResult,
        personName: person.name,
        phone: primaryPhone,
        status: 'sent',
      };
    }

    const quo = getQuo();
    await quo.sendMessage(primaryPhone, message);

    log.info('Follow-up sent', {
      eventId: event.id,
      personName: person.name,
      phone: primaryPhone,
      region,
    });

    return {
      ...baseResult,
      personName: person.name,
      phone: primaryPhone,
      status: 'sent',
    };
  } catch (error) {
    log.error('Failed to process follow-up', {
      eventId: event.id,
      summary: event.summary,
      error: (error as Error).message,
    });

    if (!isDryRun) {
      await logHealthError('cron:job-followups', `Failed for ${event.summary}: ${(error as Error).message}`);
    }

    return {
      ...baseResult,
      personName: null,
      phone: null,
      status: 'error',
      error: (error as Error).message,
    };
  }
}
