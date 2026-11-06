/**
 * Post-Job Follow-Up Cron — Send follow-up SMS after completed jobs.
 *
 * Runs daily at 9 AM Eastern (13:00 UTC) via Vercel Cron, plus a 14:00 UTC
 * second run that retries only what the first left unsent (lib/cron-send.ts).
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
import { hasContinuation, CONTINUATION_WINDOW_DAYS } from '@aac/shared-utils/multiday';
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
import { markCronAction, trackCronRun, logHealthError, countCondition } from '../../lib/redis.js';
import { isBackstopNoop, releaseUnsent, settleFailedSend } from '../../lib/cron-send.js';
import { renderTemplate } from '../../lib/templates.js';
import {
  classifyService,
  extractCity,
  formatWhen,
  recordVariant,
  selectVariant,
  type FollowUpVariant,
} from '../../lib/followup.js';
import { matchEventToPerson } from '@aac/customers';
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
  status:
    | 'sent'
    | 'skipped_dedup'
    | 'skipped_no_person'
    | 'skipped_no_phone'
    | 'skipped_multiday_continuation'
    | 'error';
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

    // Multi-day guard: a job day with an upcoming continuation (same job,
    // later green event — see @aac/shared-utils/multiday) gets NO follow-up;
    // the customer hears from us after the FINAL day only. Lookup failure
    // degrades to the old behavior (follow-ups send) rather than blocking.
    let upcomingJobs: CalendarEvent[] = [];
    if (events.length > 0) {
      try {
        upcomingJobs = await calendar.listEvents({
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + CONTINUATION_WINDOW_DAYS * 86_400_000).toISOString(),
          attendeeEmails: env.google.technicianEmails,
          colorIds: GREEN_COLOR_IDS,
        });
      } catch (err) {
        log.warn('Continuation lookup failed — multi-day skip disabled this run', {
          error: (err as Error).message,
        });
      }
    }

    for (const event of events) {
      if (hasContinuation(event, upcomingJobs)) {
        log.info('Follow-up skipped — job continues on a later day', {
          eventId: event.id,
          summary: event.summary,
        });
        results.push({
          eventId: event.id,
          summary: event.summary,
          jobDate: event.start.split('T')[0],
          location: event.location || '',
          personName: null,
          phone: null,
          variant: null,
          city: null,
          service: null,
          status: 'skipped_multiday_continuation',
        });
        skipped++;
        continue;
      }
      const result = await processFollowUp(event, pipedrive, isDryRun);
      results.push(result);

      if (result.status === 'sent') sent++;
      else if (result.status.startsWith('skipped')) skipped++;
      else errors++;
    }

    if (!isDryRun && !isBackstopNoop(results, sent, errors)) {
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

  // Set once this run owns the marker / once the send has started: a
  // failure or skip in between released the marker (lib/cron-send.ts).
  let claimed = false;
  let sendStarted = false;
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
      claimed = true;
    }

    const person = await matchEventToPerson(event, pipedrive);

    if (!person) {
      log.warn('No Pipedrive person found for follow-up', {
        eventId: event.id,
        summary: event.summary,
      });
      if (!isDryRun) await countCondition('followups.no_person');
      if (claimed) await releaseUnsent('followup', event.id);
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
      if (!isDryRun) await countCondition('followups.no_phone');
      if (claimed) await releaseUnsent('followup', event.id);
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

    // On send failure the marker is released only if Quo definitively
    // rejected it (lib/cron-send.ts).
    const quo = getQuo();
    sendStarted = true;
    try {
      await quo.sendMessage(primaryPhone, message);
    } catch (sendErr) {
      throw await settleFailedSend('followup', event.id, sendErr);
    }
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
      const released = claimed && !sendStarted ? await releaseUnsent('followup', event.id) : '';
      await logHealthError('cron:job-followups', `Failed for ${event.summary}: ${(error as Error).message}${released}`);
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
