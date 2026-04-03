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
import { getCalendar, getPipedrive, getQuo } from '../../lib/clients.js';
import { getEnv } from '../../lib/env.js';
import { verifyCronAuth } from '../../lib/cron.js';
import { markCronAction, trackCronRun, logHealthError } from '../../lib/redis.js';
import { renderTemplate } from '../../lib/templates.js';
import type { CalendarEvent } from '@aac/api-clients/google-calendar';

const log = createLogger('cron:job-reminders');

/** Color IDs to include: green (job), yellow (callback), purple (assessment) */
const REMINDER_COLOR_IDS = ['10', '5', '3'];

interface ReminderResult {
  eventId: string;
  summary: string;
  time: string;
  location: string;
  personName: string | null;
  phone: string | null;
  status: 'sent' | 'skipped_dedup' | 'skipped_no_person' | 'skipped_no_phone' | 'error';
  error?: string;
}

/**
 * Extract the first name from a full name string.
 * "John Smith" → "John", "John" → "John", "" → "there"
 */
function extractFirstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
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

/**
 * Check if a calendar event description contains a Pipedrive ID.
 * Returns the ID if found, null otherwise.
 */
function extractPipedriveId(description: string | undefined): string | null {
  if (!description) return null;
  const match = description.match(/PipedriveID:\s*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Get a date range in ISO format (Eastern timezone).
 * If dateOverride is provided (YYYY-MM-DD), use that date.
 * Otherwise, use tomorrow.
 */
function getDateRange(dateOverride?: string): { timeMin: string; timeMax: string; dateLabel: string } {
  let year: number, month: string, day: string;

  if (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
    const parts = dateOverride.split('-');
    year = parseInt(parts[0], 10);
    month = parts[1];
    day = parts[2];
  } else {
    const now = new Date();
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    eastern.setDate(eastern.getDate() + 1);
    year = eastern.getFullYear();
    month = String(eastern.getMonth() + 1).padStart(2, '0');
    day = String(eastern.getDate()).padStart(2, '0');
  }

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
  const dateOverride = req.query.date as string | undefined;
  const results: ReminderResult[] = [];
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const env = getEnv();
    const calendar = getCalendar();
    const pipedrive = getPipedrive();

    const { timeMin, timeMax, dateLabel } = getDateRange(dateOverride);

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

    // Deduplicate by summary (customer name) — if multiple events for the
    // same person tomorrow, only remind once
    const seenNames = new Set<string>();

    for (const event of events) {
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

      const result = await processReminder(event, pipedrive, isDryRun, env);
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
  env: ReturnType<typeof getEnv>
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

    // Try to find the Pipedrive person
    // First check for PipedriveID in description, then fall back to name search
    let person = null;
    const pipedriveId = extractPipedriveId(event.description);

    if (pipedriveId) {
      person = await pipedrive.getPerson(parseInt(pipedriveId, 10));
    }

    if (!person) {
      person = await pipedrive.searchPersonByName(event.summary);
    }

    if (!person) {
      log.warn('No Pipedrive person found for event', {
        eventId: event.id,
        summary: event.summary,
      });
      return { ...baseResult, personName: null, phone: null, status: 'skipped_no_person' };
    }

    // Get primary phone number
    const primaryPhone = person.phone.find((p) => p.primary)?.value || person.phone[0]?.value;
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
