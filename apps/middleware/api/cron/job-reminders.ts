/**
 * Job Reminders Cron — Send SMS reminders for tomorrow's jobs.
 *
 * Runs daily at 8 AM Eastern (12:00 UTC) via Vercel Cron.
 * Queries Google Calendar for tomorrow's events, matches to Pipedrive
 * contacts, sends reminder SMS via Quo/OpenPhone.
 *
 * Supports dry run: GET /api/cron/job-reminders?dry=true
 * Returns what would be sent without actually sending.
 *
 * Filtering:
 * - Must have a technician as attendee (configurable via TECHNICIAN_EMAILS)
 * - Must have a location (address)
 * - Must have a description
 * - All job types: green (10), yellow/callback (5), purple/assessment (3)
 * - No keyword exclusions (unlike project import)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '@aac/shared-utils/logger';
import {
  isContinuationTitle,
  countContinuationDays,
  CONTINUATION_WINDOW_DAYS,
} from '@aac/shared-utils/multiday';
import { PipedriveClient } from '@aac/api-clients/pipedrive';
import { getCalendar, getPipedrive, getQuo } from '../../lib/clients.js';
import { getEnv } from '../../lib/env.js';
import { verifyCronAuth, REMINDER_COLOR_IDS, extractFirstName, getDayRangeEastern } from '../../lib/cron.js';
import { markCronAction, trackCronRun, logHealthError } from '../../lib/redis.js';
import { renderTemplate } from '../../lib/templates.js';
import { matchEventToPerson } from '../../lib/job-customer-match.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const log = createLogger('cron:job-reminders');

interface ReminderResult {
  eventId: string;
  summary: string;
  time: string;
  location: string;
  personName: string | null;
  phone: string | null;
  status:
    | 'sent'
    | 'skipped_dedup'
    | 'skipped_no_person'
    | 'skipped_no_phone'
    | 'skipped_multiday_continuation'
    | 'error';
  error?: string;
}

/**
 * Reminder sentence for a multi-day job's day-one message. Empty for
 * single-day jobs: the customer gets ONE reminder (before day one, telling
 * them the full booking) and then nothing until the post-job follow-up.
 */
export function multiDayNote(extraDays: number): string {
  if (extraDays <= 0) return '';
  if (extraDays === 1) {
    return ' This job will take more than one day — we also have you booked for the following day to continue the work.';
  }
  return ` This job will take multiple days — we also have you booked for ${extraDays} more days after that to continue the work.`;
}

/**
 * Format a time string for display: "8:00 AM", "2:30 PM"
 */
function formatTime(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

/**
 * Format a date string for display: "Friday, April 4"
 */
function formatDate(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyCronAuth(req, res)) return;

  const isDryRun = req.query.dry === 'true';
  const dateOverride = req.query.date as string | undefined;
  const results: ReminderResult[] = [];
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const env = getEnv();
    const calendar = getCalendar();
    const pipedrive = getPipedrive();

    const { timeMin, timeMax, dateLabel } = getDayRangeEastern(1, dateOverride);

    log.info('Job reminders cron started', { isDryRun, dateLabel, timeMin, timeMax });

    // Fetch tomorrow's events with technician filtering
    const events = await calendar.listEvents({
      timeMin,
      timeMax,
      attendeeEmails: env.google.technicianEmails,
      colorIds: REMINDER_COLOR_IDS,
      requireLocation: true,
      requireDescription: true,
    });

    log.info('Calendar events found', { count: events.length });

    // Multi-day jobs get ONE reminder, before day one, which announces the
    // full booking (note below). Continuation days ("NAME [cont]") get no
    // reminder of their own. Chain lookup failure degrades to a plain
    // single-day reminder rather than blocking.
    let upcomingJobs: CalendarEvent[] = [];
    if (events.some((e) => e.colorId === '10' && !isContinuationTitle(e.summary))) {
      try {
        upcomingJobs = await calendar.listEvents({
          timeMin,
          timeMax: new Date(
            new Date(timeMax).getTime() + 3 * CONTINUATION_WINDOW_DAYS * 86_400_000
          ).toISOString(),
          attendeeEmails: env.google.technicianEmails,
          colorIds: ['10'],
        });
      } catch (err) {
        log.warn('Continuation lookup failed — multi-day note disabled this run', {
          error: (err as Error).message,
        });
      }
    }

    // Deduplicate by summary (customer name) — if multiple events for the
    // same person tomorrow, only remind once
    const seenNames = new Set<string>();

    for (const event of events) {
      if (isContinuationTitle(event.summary)) {
        log.info('Reminder skipped — continuation day of a multi-day job', {
          eventId: event.id,
          summary: event.summary,
        });
        results.push({
          eventId: event.id,
          summary: event.summary,
          time: formatTime(event.start),
          location: event.location || '',
          personName: null,
          phone: null,
          status: 'skipped_multiday_continuation',
        });
        skipped++;
        continue;
      }

      const nameKey = event.summary.toLowerCase().trim();
      if (seenNames.has(nameKey)) {
        results.push({
          eventId: event.id,
          summary: event.summary,
          time: formatTime(event.start),
          location: event.location || '',
          personName: null,
          phone: null,
          status: 'skipped_dedup',
        });
        skipped++;
        continue;
      }
      seenNames.add(nameKey);

      const result = await processReminder(
        event,
        pipedrive,
        isDryRun,
        env,
        multiDayNote(countContinuationDays(event, upcomingJobs))
      );
      results.push(result);

      if (result.status === 'sent') sent++;
      else if (result.status.startsWith('skipped')) skipped++;
      else errors++;
    }

    // Track the cron run
    if (!isDryRun) {
      await trackCronRun('job-reminders', { sent, skipped, errors });
    }

    log.info('Job reminders cron complete', { isDryRun, sent, skipped, errors });

    return res.status(200).json({
      dryRun: isDryRun,
      date: dateLabel,
      summary: { sent, skipped, errors, totalEvents: events.length },
      results,
    });
  } catch (error) {
    log.error('Job reminders cron failed', error as Error);
    await logHealthError('cron:job-reminders', (error as Error).message);

    return res.status(500).json({
      dryRun: isDryRun,
      error: (error as Error).message,
      summary: { sent, skipped, errors },
      results,
    });
  }
}

async function processReminder(
  event: CalendarEvent,
  pipedrive: ReturnType<typeof getPipedrive>,
  isDryRun: boolean,
  env: ReturnType<typeof getEnv>,
  multiDayNoteText: string
): Promise<ReminderResult> {
  const baseResult = {
    eventId: event.id,
    summary: event.summary,
    time: formatTime(event.start),
    location: event.location || '',
  };

  try {
    // Check dedup — did we already send a reminder for this event?
    if (!isDryRun) {
      const isNew = await markCronAction('reminder', event.id);
      if (!isNew) {
        return { ...baseResult, personName: null, phone: null, status: 'skipped_dedup' };
      }
    }

    const person = await matchEventToPerson(event, pipedrive);

    if (!person) {
      log.warn('No Pipedrive person found for event', {
        eventId: event.id,
        summary: event.summary,
      });
      return { ...baseResult, personName: null, phone: null, status: 'skipped_no_person' };
    }

    // Get primary phone number using the static helper
    const primaryPhone = PipedriveClient.getPrimaryPhone(person);
    if (!primaryPhone) {
      log.warn('Pipedrive person has no phone number', {
        eventId: event.id,
        personId: person.id,
        personName: person.name,
      });
      return {
        ...baseResult,
        personName: person.name,
        phone: null,
        status: 'skipped_no_phone',
      };
    }

    // Render the message
    const firstName = extractFirstName(person.name);
    const message = renderTemplate('jobReminder', {
      firstName,
      time: formatTime(event.start),
      date: formatDate(event.start),
      multiDayNote: multiDayNoteText,
    });

    if (isDryRun) {
      return {
        ...baseResult,
        personName: person.name,
        phone: primaryPhone,
        status: 'sent', // Would be sent
      };
    }

    // Send the SMS
    const quo = getQuo();
    await quo.sendMessage(primaryPhone, message);

    log.info('Reminder sent', {
      eventId: event.id,
      personName: person.name,
      phone: primaryPhone,
    });

    return {
      ...baseResult,
      personName: person.name,
      phone: primaryPhone,
      status: 'sent',
    };
  } catch (error) {
    log.error('Failed to process reminder', {
      eventId: event.id,
      summary: event.summary,
      error: (error as Error).message,
    });

    if (!isDryRun) {
      await logHealthError('cron:job-reminders', `Failed for ${event.summary}: ${(error as Error).message}`);
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
