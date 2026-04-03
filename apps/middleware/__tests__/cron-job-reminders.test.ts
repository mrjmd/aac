import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockListEvents = vi.fn();
const mockSearchPersonByName = vi.fn();
const mockGetPerson = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('../lib/clients.js', () => ({
  getCalendar: () => ({ listEvents: mockListEvents }),
  getPipedrive: () => ({
    searchPersonByName: mockSearchPersonByName,
    getPerson: mockGetPerson,
  }),
  getQuo: () => ({ sendMessage: mockSendMessage }),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({
    google: {
      technicianEmails: ['mike@attackacrack.com', 'harrringtonm@gmail.com'],
      calendarId: 'matt@attackacrack.com',
    },
    notifications: { alertPhoneNumber: '+15551234567' },
    cron: { secret: 'test-secret' },
    nodeEnv: 'development',
  }),
}));

vi.mock('../lib/cron.js', () => ({
  verifyCronAuth: () => true,
}));

vi.mock('../lib/redis.js', () => ({
  markCronAction: vi.fn().mockResolvedValue(true),
  trackCronRun: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
}));

import handler from '../api/cron/job-reminders.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeReq(query: Record<string, string> = {}) {
  return { method: 'GET', query, headers: { authorization: 'Bearer test-secret' } } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const sampleEvent = {
  id: 'evt-1',
  summary: 'John Smith',
  location: '123 Main St, Boston, MA',
  description: 'Foundation crack repair',
  start: '2026-04-05T08:00:00-04:00',
  end: '2026-04-05T12:00:00-04:00',
  colorId: '10',
  attendees: ['mike@attackacrack.com'],
  htmlLink: 'https://calendar.google.com/event?id=evt-1',
  attachments: [],
};

const samplePerson = {
  id: 1,
  name: 'John Smith',
  phone: [{ value: '+15559876543', primary: true }],
  email: [],
};

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockListEvents.mockResolvedValue([]);
  mockSearchPersonByName.mockResolvedValue(null);
  mockGetPerson.mockResolvedValue(null);
  mockSendMessage.mockResolvedValue({ id: 'msg-1' });
});

describe('cron/job-reminders', () => {
  it('returns 405 for non-GET requests', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns empty results when no events found', async () => {
    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.dryRun).toBe(true);
    expect(body.summary.totalEvents).toBe(0);
  });

  it('dry run finds events and matches persons without sending', async () => {
    mockListEvents.mockResolvedValue([sampleEvent]);
    mockSearchPersonByName.mockResolvedValue(samplePerson);
    mockGetPerson.mockResolvedValue(samplePerson);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.dryRun).toBe(true);
    expect(body.summary.sent).toBe(1);
    expect(body.results[0].personName).toBe('John Smith');
    expect(body.results[0].phone).toBe('+15559876543');

    // Should NOT have actually sent a message
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('sends SMS in non-dry mode', async () => {
    mockListEvents.mockResolvedValue([sampleEvent]);
    mockSearchPersonByName.mockResolvedValue(samplePerson);
    mockGetPerson.mockResolvedValue(samplePerson);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [phone, message] = mockSendMessage.mock.calls[0];
    expect(phone).toBe('+15559876543');
    expect(message).toContain('Hi John');
    expect(message).toContain('Attack A Crack');
  });

  it('skips events with no matching Pipedrive person', async () => {
    mockListEvents.mockResolvedValue([sampleEvent]);
    mockSearchPersonByName.mockResolvedValue(null);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.summary.skipped).toBe(1);
    expect(body.results[0].status).toBe('skipped_no_person');
  });

  it('skips person with no phone number', async () => {
    mockListEvents.mockResolvedValue([sampleEvent]);
    mockSearchPersonByName.mockResolvedValue(samplePerson);
    mockGetPerson.mockResolvedValue({
      ...samplePerson,
      phone: [],
    });

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.results[0].status).toBe('skipped_no_phone');
  });

  it('deduplicates events for the same person', async () => {
    const event2 = { ...sampleEvent, id: 'evt-2' }; // Same summary (name)
    mockListEvents.mockResolvedValue([sampleEvent, event2]);
    mockSearchPersonByName.mockResolvedValue(samplePerson);
    mockGetPerson.mockResolvedValue(samplePerson);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    const body = res.json.mock.calls[0][0];
    // First event processed, second deduped by name
    expect(body.results[0].status).toBe('sent');
    expect(body.results[1].status).toBe('skipped_dedup');
  });

  it('uses PipedriveID from description when available', async () => {
    const eventWithId = {
      ...sampleEvent,
      description: 'Foundation repair\nPipedriveID: 42',
    };
    mockListEvents.mockResolvedValue([eventWithId]);
    mockGetPerson.mockResolvedValue(samplePerson);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(mockGetPerson).toHaveBeenCalledWith(42);
    // Should not fall back to name search
    expect(mockSearchPersonByName).not.toHaveBeenCalled();
  });

  it('falls back to name search when PipedriveID not found', async () => {
    const eventWithBadId = {
      ...sampleEvent,
      description: 'Foundation repair\nPipedriveID: 999',
    };
    mockListEvents.mockResolvedValue([eventWithBadId]);
    // First call (by PipedriveID 999) fails, second call (re-fetch after name search) succeeds
    mockGetPerson.mockResolvedValueOnce(null).mockResolvedValueOnce(samplePerson);
    mockSearchPersonByName.mockResolvedValue(samplePerson);

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(mockGetPerson).toHaveBeenCalledWith(999);
    expect(mockSearchPersonByName).toHaveBeenCalledWith('John Smith');
    expect(res.json.mock.calls[0][0].results[0].status).toBe('sent');
  });
});
