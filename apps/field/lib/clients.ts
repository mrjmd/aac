/**
 * Lazy-initialized clients for external services.
 *
 * Pattern mirrors apps/middleware/lib/clients.ts. Each getter caches its
 * client across requests (Vercel keeps module state warm within a function
 * instance, so this is effectively a per-instance singleton).
 */

import { GoogleCalendarClient } from '@aac/api-clients/google-calendar';
import { getEnv } from './env';

let _calendar: GoogleCalendarClient | null = null;

export function getCalendar(): GoogleCalendarClient {
  if (!_calendar) {
    const env = getEnv();
    _calendar = new GoogleCalendarClient({
      calendarId: env.google.calendarId,
      oauth: {
        clientId: env.google.clientId,
        clientSecret: env.google.clientSecret,
        refreshToken: env.google.refreshToken,
      },
    });
  }
  return _calendar;
}
