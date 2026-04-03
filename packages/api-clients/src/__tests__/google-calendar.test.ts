import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('googleapis', () => {
  const mockEventsList = vi.fn();
  const mockEventsGet = vi.fn();
  const mockEventsInsert = vi.fn();
  const mockEventsPatch = vi.fn();
  const MockGoogleAuth = vi.fn();
  const MockOAuth2 = vi.fn(() => ({
    setCredentials: vi.fn(),
  }));
  const mockCalendar = vi.fn(() => ({
    events: {
      list: mockEventsList,
      get: mockEventsGet,
      insert: mockEventsInsert,
      patch: mockEventsPatch,
    },
  }));

  return {
    google: {
      auth: { GoogleAuth: MockGoogleAuth, OAuth2: MockOAuth2 },
      calendar: mockCalendar,
    },
    __mocks: {
      mockEventsList,
      mockEventsGet,
      mockEventsInsert,
      mockEventsPatch,
      MockGoogleAuth,
      MockOAuth2,
      mockCalendar,
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mocks: any;

import { GoogleCalendarClient } from '../google-calendar.js';

beforeEach(async () => {
  const googleapis = await import('googleapis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mocks = (googleapis as any).__mocks;
  mocks.mockEventsList.mockReset();
  mocks.mockEventsGet.mockReset();
  mocks.mockEventsInsert.mockReset();
  mocks.mockEventsPatch.mockReset();
  mocks.MockGoogleAuth.mockReset();
  mocks.MockOAuth2.mockClear();
});

function makeClient() {
  return new GoogleCalendarClient({
    calendarId: 'matt@attackacrack.com',
    credentials: { type: 'service_account', project_id: 'test' },
  });
}

function makeOAuthClient() {
  return new GoogleCalendarClient({
    calendarId: 'matt@attackacrack.com',
    oauth: {
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      refreshToken: 'test-refresh',
    },
  });
}

const sampleEvent = {
  id: 'evt-1',
  summary: 'John Smith',
  location: '123 Main St, Boston, MA',
  description: 'Foundation crack repair\nPipedriveID: 12345',
  start: { dateTime: '2026-04-05T08:00:00-04:00' },
  end: { dateTime: '2026-04-05T12:00:00-04:00' },
  colorId: '10',
  attendees: [
    { email: 'matt@attackacrack.com' },
    { email: 'harrringtonm@gmail.com' },
  ],
  htmlLink: 'https://calendar.google.com/event?id=evt-1',
  attachments: [
    { fileUrl: 'https://drive.google.com/file/123', title: 'photo.jpg' },
  ],
};

describe('GoogleCalendarClient', () => {
  describe('auth', () => {
    it('creates auth with calendar scope for service account', async () => {
      const client = makeClient();

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [], nextPageToken: null },
      });

      await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
      });

      expect(mocks.MockGoogleAuth).toHaveBeenCalledWith({
        credentials: { type: 'service_account', project_id: 'test' },
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
    });

    it('creates OAuth2 client when oauth config provided', async () => {
      const client = makeOAuthClient();

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [], nextPageToken: null },
      });

      await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
      });

      expect(mocks.MockOAuth2).toHaveBeenCalledWith('test-client-id', 'test-secret');
    });

    it('throws when no auth config provided', async () => {
      const client = new GoogleCalendarClient({
        calendarId: 'matt@attackacrack.com',
      });

      await expect(
        client.listEvents({
          timeMin: '2026-04-01T00:00:00Z',
          timeMax: '2026-04-08T00:00:00Z',
        })
      ).rejects.toThrow('requires either credentials or oauth');
    });
  });

  describe('listEvents', () => {
    it('returns mapped events from the API', async () => {
      const client = makeClient();

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [sampleEvent], nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        id: 'evt-1',
        summary: 'John Smith',
        location: '123 Main St, Boston, MA',
        description: 'Foundation crack repair\nPipedriveID: 12345',
        start: '2026-04-05T08:00:00-04:00',
        end: '2026-04-05T12:00:00-04:00',
        colorId: '10',
        attendees: ['matt@attackacrack.com', 'harrringtonm@gmail.com'],
        htmlLink: 'https://calendar.google.com/event?id=evt-1',
        attachments: [{ fileUrl: 'https://drive.google.com/file/123', title: 'photo.jpg' }],
      });
    });

    it('paginates through multiple pages', async () => {
      const client = makeClient();

      mocks.mockEventsList
        .mockResolvedValueOnce({
          data: {
            items: [{ ...sampleEvent, id: 'evt-1' }],
            nextPageToken: 'page2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ ...sampleEvent, id: 'evt-2' }],
            nextPageToken: null,
          },
        });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
      });

      expect(events).toHaveLength(2);
      expect(mocks.mockEventsList).toHaveBeenCalledTimes(2);
      expect(mocks.mockEventsList.mock.calls[1][0].pageToken).toBe('page2');
    });

    it('filters by attendee emails', async () => {
      const client = makeClient();

      const noMikeEvent = {
        ...sampleEvent,
        id: 'evt-no-mike',
        attendees: [{ email: 'matt@attackacrack.com' }],
      };

      const newMikeEvent = {
        ...sampleEvent,
        id: 'evt-new-mike',
        attendees: [{ email: 'mike@attackacrack.com' }],
      };

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [sampleEvent, noMikeEvent, newMikeEvent], nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
        attendeeEmails: ['harrringtonm@gmail.com', 'mike@attackacrack.com'],
      });

      expect(events).toHaveLength(2);
      expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-new-mike']);
    });

    it('filters by color IDs', async () => {
      const client = makeClient();

      const yellowEvent = { ...sampleEvent, id: 'evt-yellow', colorId: '5' };
      const purpleEvent = { ...sampleEvent, id: 'evt-purple', colorId: '3' };

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [sampleEvent, yellowEvent, purpleEvent], nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
        colorIds: ['10', '5'],
      });

      expect(events).toHaveLength(2);
      expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-yellow']);
    });

    it('excludes events matching keywords', async () => {
      const client = makeClient();

      const lunchEvent = { ...sampleEvent, id: 'evt-lunch', summary: 'Lunch break' };
      const meetingEvent = { ...sampleEvent, id: 'evt-mtg', summary: 'Team Meeting' };

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [sampleEvent, lunchEvent, meetingEvent], nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
        excludeKeywords: ['lunch', 'meeting'],
      });

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
    });

    it('filters by requireLocation', async () => {
      const client = makeClient();

      const noLocationEvent = {
        ...sampleEvent,
        id: 'evt-no-loc',
        location: undefined,
      };

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [sampleEvent, noLocationEvent], nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
        requireLocation: true,
      });

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
    });

    it('filters by minimum duration', async () => {
      const client = makeClient();

      const shortEvent = {
        ...sampleEvent,
        id: 'evt-short',
        start: { dateTime: '2026-04-05T08:00:00-04:00' },
        end: { dateTime: '2026-04-05T08:30:00-04:00' },
      };

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [sampleEvent, shortEvent], nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
        minDurationMinutes: 120,
      });

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
    });

    it('handles empty response', async () => {
      const client = makeClient();

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: null, nextPageToken: null },
      });

      const events = await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
      });

      expect(events).toEqual([]);
    });

    it('passes singleEvents and orderBy to the API', async () => {
      const client = makeClient();

      mocks.mockEventsList.mockResolvedValueOnce({
        data: { items: [], nextPageToken: null },
      });

      await client.listEvents({
        timeMin: '2026-04-01T00:00:00Z',
        timeMax: '2026-04-08T00:00:00Z',
      });

      const call = mocks.mockEventsList.mock.calls[0][0];
      expect(call.singleEvents).toBe(true);
      expect(call.orderBy).toBe('startTime');
      expect(call.calendarId).toBe('matt@attackacrack.com');
    });
  });

  describe('getEvent', () => {
    it('returns a single event by ID', async () => {
      const client = makeClient();

      mocks.mockEventsGet.mockResolvedValueOnce({ data: sampleEvent });

      const event = await client.getEvent('evt-1');

      expect(event.id).toBe('evt-1');
      expect(event.summary).toBe('John Smith');
      expect(mocks.mockEventsGet).toHaveBeenCalledWith({
        calendarId: 'matt@attackacrack.com',
        eventId: 'evt-1',
      });
    });

    it('propagates API errors', async () => {
      const client = makeClient();
      mocks.mockEventsGet.mockRejectedValueOnce(new Error('Not Found'));

      await expect(client.getEvent('bad-id')).rejects.toThrow('Not Found');
    });
  });

  describe('createEvent', () => {
    it('creates an event and returns the result', async () => {
      const client = makeClient();

      mocks.mockEventsInsert.mockResolvedValueOnce({
        data: {
          ...sampleEvent,
          id: 'new-evt-1',
          htmlLink: 'https://calendar.google.com/event?id=new-evt-1',
        },
      });

      const event = await client.createEvent({
        summary: 'John Smith',
        location: '123 Main St, Boston, MA',
        description: 'Foundation crack repair',
        start: '2026-04-05T08:00:00-04:00',
        end: '2026-04-05T12:00:00-04:00',
        colorId: '10',
        attendees: ['harrringtonm@gmail.com'],
      });

      expect(event.id).toBe('new-evt-1');

      const call = mocks.mockEventsInsert.mock.calls[0][0];
      expect(call.calendarId).toBe('matt@attackacrack.com');
      expect(call.requestBody.summary).toBe('John Smith');
      expect(call.requestBody.location).toBe('123 Main St, Boston, MA');
      expect(call.requestBody.start).toEqual({ dateTime: '2026-04-05T08:00:00-04:00' });
      expect(call.requestBody.attendees).toEqual([{ email: 'harrringtonm@gmail.com' }]);
    });

    it('creates an event without optional fields', async () => {
      const client = makeClient();

      mocks.mockEventsInsert.mockResolvedValueOnce({
        data: { id: 'min-evt', summary: 'Test', start: { dateTime: '2026-04-05T08:00:00Z' }, end: { dateTime: '2026-04-05T09:00:00Z' }, htmlLink: '' },
      });

      const event = await client.createEvent({
        summary: 'Test',
        start: '2026-04-05T08:00:00Z',
        end: '2026-04-05T09:00:00Z',
      });

      expect(event.id).toBe('min-evt');
      const call = mocks.mockEventsInsert.mock.calls[0][0];
      expect(call.requestBody.attendees).toBeUndefined();
      expect(call.requestBody.colorId).toBeUndefined();
    });
  });

  describe('updateEvent', () => {
    it('patches only provided fields', async () => {
      const client = makeClient();

      mocks.mockEventsPatch.mockResolvedValueOnce({
        data: { ...sampleEvent, summary: 'Jane Doe' },
      });

      const event = await client.updateEvent('evt-1', {
        summary: 'Jane Doe',
        colorId: '9',
      });

      expect(event.summary).toBe('Jane Doe');

      const call = mocks.mockEventsPatch.mock.calls[0][0];
      expect(call.calendarId).toBe('matt@attackacrack.com');
      expect(call.eventId).toBe('evt-1');
      expect(call.requestBody.summary).toBe('Jane Doe');
      expect(call.requestBody.colorId).toBe('9');
      // Fields not provided should not be in requestBody
      expect(call.requestBody.location).toBeUndefined();
      expect(call.requestBody.description).toBeUndefined();
    });

    it('propagates API errors', async () => {
      const client = makeClient();
      mocks.mockEventsPatch.mockRejectedValueOnce(new Error('Forbidden'));

      await expect(
        client.updateEvent('evt-1', { summary: 'test' })
      ).rejects.toThrow('Forbidden');
    });
  });
});
