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
import { getCalendar, getGemini, getPipedrive, getQuo } from '../../lib/clients.js';
import { getEnv } from '../../lib/env.js';
import {
  verifyCronAuth,
  GREEN_COLOR_IDS,
  NON_JOB_KEYWORDS,
  MIN_JOB_DURATION_MINUTES,
  extractFirstName,
  getDayRangeEastern,
} from '../../lib/cron.js';
import { markCronAction, trackCronRun, logHealthError } from '../../lib/redis.js';
import { renderTemplate } from '../../lib/templates.js';
import {
  classifyService,
  extractCity,
  formatWhen,
  recordVariant,
  selectVariant,
  type FollowUpVariant,
} from '../../lib/followup.js';
import { matchEventToPerson } from '../../lib/job-customer-match.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const log = createLogger('cron:job-followups');

/** Default days after job completion to send follow-up */
const DEFAULT_DELAY_DAYS = 1;

/** Google review URL (MA only for now) */
const REVIEW_LINK = 'https://g.page/r/CWHz-4-5ORnJEBM/review';

interface FollowUpResult {
  eventId: string;
  summary: string;
  jobDate: string;
  location: string;
  personName: string | null;
  phone: string | null;
  variant: FollowUpVariant | null;
  city: string | null;
  service: string | null;
  status: 'sent' | 'skipped_dedup' | 'skipped_no_person' | 'skipped_no_phone' | 'error';
  error?: string;
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

    const { timeMin, timeMax, dateLabel } = getDayRangeEastern(-delayDays, dateOverride);

    log.info('Job follow-ups cron started', { isDryRun, delayDays, dateLabel, timeMin, timeMax });

    const events = await calendar.listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.google.technicianEmails,
      colorIds: GREEN_COLOR_IDS,
      requireLocation: true,
      excludeKeywords: NON_JOB_KEYWORDS,
      minDurationMinutes: MIN_JOB_DURATION_MINUTES,
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
        return {
          ...baseResult,
          personName: null,
          phone: null,
          variant: null,
          city: null,
          service: null,
          status: 'skipped_dedup',
        };
      }
    }

    const person = await matchEventToPerson(event, pipedrive);

    if (!person) {
      log.warn('No Pipedrive person found for follow-up', {
        eventId: event.id,
        summary: event.summary,
      });
      return {
        ...baseResult,
        personName: null,
        phone: null,
        variant: null,
        city: null,
        service: null,
        status: 'skipped_no_person',
      };
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
        variant: null,
        city: null,
        service: null,
        status: 'skipped_no_phone',
      };
    }

    const city = extractCity(event.location);
    const service = await classifyService(event.description, getGemini());
    const { variant, prompt } = selectVariant(event.id, city, service);
    const when = formatWhen(event.start);

    const firstName = extractFirstName(person.name);
    const message = renderTemplate('jobFollowUp', {
      firstName,
      reviewLink: REVIEW_LINK,
      when,
      prompt,
    });

    if (isDryRun) {
      return {
        ...baseResult,
        personName: person.name,
        phone: primaryPhone,
        variant,
        city,
        service,
        status: 'sent',
      };
    }

    const quo = getQuo();
    await quo.sendMessage(primaryPhone, message);
    await recordVariant(event.id, variant);

    log.info('Follow-up sent', {
      eventId: event.id,
      personName: person.name,
      phone: primaryPhone,
      variant,
      city,
      service,
    });

    return {
      ...baseResult,
      personName: person.name,
      phone: primaryPhone,
      variant,
      city,
      service,
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
      variant: null,
      city: null,
      service: null,
      status: 'error',
      error: (error as Error).message,
    };
  }
}
