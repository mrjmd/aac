import { GoogleCalendarClient } from "@aac/api-clients/google-calendar";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** The shared business calendar (same token and calendar as field/middleware). */
export function getCalendar(): GoogleCalendarClient {
  return new GoogleCalendarClient({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "matt@attackacrack.com",
    oauth: {
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refreshToken: requireEnv("GOOGLE_REFRESH_TOKEN"),
    },
  });
}

/** Broad read filter for "Mike is on this event" (current + legacy address), as in middleware/field. */
export function technicianEmails(): string[] {
  return (process.env.TECHNICIAN_EMAILS || "mike@attackacrack.com,harrringtonm@gmail.com")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}
