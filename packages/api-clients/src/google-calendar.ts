/**
 * Google Calendar client — event listing, creation, and updates.
 *
 * Used by middleware automation: job reminders, follow-ups, project
 * discovery, stub event creation for approved estimates.
 *
 * Supports two auth modes (same as GA4/GSC clients):
 * - Service account: pass `credentials` (service account JSON)
 * - OAuth2: pass `oauth` with clientId, clientSecret, refreshToken
 *
 * Uses the `googleapis` package.
 */

import { google, type calendar_v3 } from 'googleapis';

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('google-calendar');

// ── Interfaces ───────────────────────────────────────────────────────

export interface GoogleCalendarConfig {
  calendarId: string; // e.g., 'matt@attackacrack.com'
  /** Service account JSON credentials */
  credentials?: Record<string, unknown>;
  /** OAuth2 credentials (alternative to service account) */
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export interface CalendarEvent {
  id: string;
  summary: string;
  location?: string;
  description?: string;
  start: string;
  end: string;
  colorId?: string;
  attendees: string[];
  htmlLink: string;
  attachments: Array<{ fileUrl: string; title: string }>;
}

export interface ListEventsOptions {
  timeMin: string; // ISO datetime
  timeMax: string; // ISO datetime
  /** Max results to return (default 250) */
  maxResults?: number;
  /** Only include events where at least one of these emails is an attendee */
  attendeeEmails?: string[];
  /** Only include events with one of these color IDs */
  colorIds?: string[];
  /** Exclude events whose summary matches any of these keywords (case-insensitive) */
  excludeKeywords?: string[];
  /** Only include events with a location set */
  requireLocation?: boolean;
  /** Only include events with a description set */
  requireDescription?: boolean;
  /** Minimum duration in minutes */
  minDurationMinutes?: number;
}

export interface CreateEventInput {
  summary: string;
  location?: string;
  description?: string;
  start: string;  // ISO datetime
  end: string;    // ISO datetime
  colorId?: string;
  attendees?: string[];
}

export interface UpdateEventInput {
  summary?: string;
  location?: string;
  description?: string;
  start?: string;
  end?: string;
  colorId?: string;
  attendees?: string[];
}

// ── Client ───────────────────────────────────────────────────────────

export class GoogleCalendarClient {
  private _client: calendar_v3.Calendar | null = null;

  constructor(private config: GoogleCalendarConfig) {}

  // ── Private helpers ────────────────────────────────────────────────

  private async getClient(): Promise<calendar_v3.Calendar> {
    if (!this._client) {
      let auth;

      if (this.config.oauth) {
        const oauth2 = new google.auth.OAuth2(
          this.config.oauth.clientId,
          this.config.oauth.clientSecret,
        );
        oauth2.setCredentials({ refresh_token: this.config.oauth.refreshToken });
        auth = oauth2;
      } else if (this.config.credentials) {
        auth = new google.auth.GoogleAuth({
          credentials: this.config.credentials,
          scopes: ['https://www.googleapis.com/auth/calendar'],
        });
      } else {
        throw new Error('GoogleCalendarClient requires either credentials or oauth config');
      }

      this._client = google.calendar({ version: 'v3', auth });
    }
    return this._client;
  }

  private mapEvent(event: calendar_v3.Schema$Event): CalendarEvent {
    return {
      id: event.id || '',
      summary: event.summary || '',
      location: event.location || undefined,
      description: event.description || undefined,
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      colorId: event.colorId || undefined,
      attendees: (event.attendees || [])
        .map((a) => a.email)
        .filter((e): e is string => !!e),
      htmlLink: event.htmlLink || '',
      attachments: (event.attachments || []).map((a) => ({
        fileUrl: a.fileUrl || '',
        title: a.title || '',
      })),
    };
  }

  private applyFilters(events: CalendarEvent[], options: ListEventsOptions): CalendarEvent[] {
    let filtered = events;

    if (options.attendeeEmails && options.attendeeEmails.length > 0) {
      const emails = options.attendeeEmails.map((e) => e.toLowerCase());
      filtered = filtered.filter((evt) =>
        evt.attendees.some((a) => emails.includes(a.toLowerCase()))
      );
    }

    if (options.colorIds && options.colorIds.length > 0) {
      filtered = filtered.filter((e) =>
        e.colorId != null && options.colorIds!.includes(e.colorId)
      );
    }

    if (options.excludeKeywords && options.excludeKeywords.length > 0) {
      const keywords = options.excludeKeywords.map((k) => k.toLowerCase());
      filtered = filtered.filter((e) =>
        !keywords.some((kw) => e.summary.toLowerCase().includes(kw))
      );
    }

    if (options.requireLocation) {
      filtered = filtered.filter((e) => !!e.location);
    }

    if (options.requireDescription) {
      filtered = filtered.filter((e) => !!e.description);
    }

    if (options.minDurationMinutes != null) {
      const minMs = options.minDurationMinutes * 60 * 1000;
      filtered = filtered.filter((e) => {
        const start = new Date(e.start).getTime();
        const end = new Date(e.end).getTime();
        return (end - start) >= minMs;
      });
    }

    return filtered;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * List events from the calendar within a date range.
   *
   * Fetches all events from the API, then applies client-side filters
   * (attendee, color, keywords, location, description, duration).
   */
  async listEvents(options: ListEventsOptions): Promise<CalendarEvent[]> {
    const client = await this.getClient();
    const allEvents: CalendarEvent[] = [];
    let pageToken: string | undefined;

    log.debug('Listing calendar events', {
      calendarId: this.config.calendarId,
      timeMin: options.timeMin,
      timeMax: options.timeMax,
    });

    do {
      const response = await client.events.list({
        calendarId: this.config.calendarId,
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        maxResults: options.maxResults || 250,
        singleEvents: true,
        orderBy: 'startTime',
        pageToken,
      });

      const events = (response.data.items || []).map((e) => this.mapEvent(e));
      allEvents.push(...events);
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    const filtered = this.applyFilters(allEvents, options);

    log.debug('Calendar events filtered', {
      total: allEvents.length,
      afterFilter: filtered.length,
    });

    return filtered;
  }

  /**
   * Get a single event by ID.
   */
  async getEvent(eventId: string): Promise<CalendarEvent> {
    const client = await this.getClient();

    log.debug('Getting calendar event', { eventId });

    const response = await client.events.get({
      calendarId: this.config.calendarId,
      eventId,
    });

    return this.mapEvent(response.data);
  }

  /**
   * Create a new calendar event. Returns the created event with ID and HTML link.
   */
  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const client = await this.getClient();

    log.info('Creating calendar event', {
      summary: input.summary,
      start: input.start,
    });

    const response = await client.events.insert({
      calendarId: this.config.calendarId,
      requestBody: {
        summary: input.summary,
        location: input.location,
        description: input.description,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        colorId: input.colorId,
        attendees: input.attendees?.map((email) => ({ email })),
      },
    });

    const event = this.mapEvent(response.data);
    log.info('Calendar event created', { eventId: event.id, htmlLink: event.htmlLink });
    return event;
  }

  /**
   * Update an existing calendar event. Only provided fields are changed.
   */
  async updateEvent(eventId: string, input: UpdateEventInput): Promise<CalendarEvent> {
    const client = await this.getClient();

    log.info('Updating calendar event', { eventId });

    const requestBody: calendar_v3.Schema$Event = {};
    if (input.summary !== undefined) requestBody.summary = input.summary;
    if (input.location !== undefined) requestBody.location = input.location;
    if (input.description !== undefined) requestBody.description = input.description;
    if (input.start !== undefined) requestBody.start = { dateTime: input.start };
    if (input.end !== undefined) requestBody.end = { dateTime: input.end };
    if (input.colorId !== undefined) requestBody.colorId = input.colorId;
    if (input.attendees !== undefined) {
      requestBody.attendees = input.attendees.map((email) => ({ email }));
    }

    const response = await client.events.patch({
      calendarId: this.config.calendarId,
      eventId,
      requestBody,
    });

    const event = this.mapEvent(response.data);
    log.info('Calendar event updated', { eventId: event.id });
    return event;
  }
}
