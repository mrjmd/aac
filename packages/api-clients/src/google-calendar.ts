/**
 * Google Calendar client — OAuth-based event management.
 *
 * TODO: Extract from aac-astro/scripts/lib/project-import-core.js
 * during Phase 3 (website migration).
 */

export interface GoogleCalendarConfig {
  credentials: Record<string, unknown>;
}

export class GoogleCalendarClient {
  constructor(private config: GoogleCalendarConfig) {}

  async listEvents(_calendarId: string, _dateRange: { start: string; end: string }) { return this.stub('listEvents'); }
  async getEvent(_calendarId: string, _eventId: string) { return this.stub('getEvent'); }
  async createEvent(_calendarId: string, _data: Record<string, unknown>) { return this.stub('createEvent'); }

  private stub(method: string): never {
    throw new Error(`GoogleCalendarClient.${method}() not yet extracted`);
  }
}
