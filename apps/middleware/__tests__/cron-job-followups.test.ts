import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockListEvents = vi.fn();
const mockSendMessage = vi.fn();
const mockMarkCronAction = vi.fn();

vi.mock('../lib/clients.js', () => ({
  getCalendar: () => ({ listEvents: mockListEvents }),
  getPipedrive: () => ({}),
  getQuo: () => ({ sendMessage: mockSendMessage }),
  getGemini: () => ({}),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({
    google: {
      technicianEmails: ['mike@attackacrack.com'],
      calendarId: 'matt@attackacrack.com',
    },
    notifications: { alertPhoneNumber: '+15551234567' },
    cron: { secret: 'test-secret' },
    nodeEnv: 'development',
  }),
}));

vi.mock('../lib/cron.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/cron.js')>('../lib/cron.js');
  return { ...actual, verifyCronAuth: () => true };
});

vi.mock('../lib/redis.js', () => ({
  markCronAction: (...args: unknown[]) => mockMarkCronAction(...args),
  trackCronRun: vi.fn().mockResolvedValue(undefined),
  logHealthError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/followup.js', () => ({
  classifyService: vi.fn().mockResolvedValue(null),
  extractCity: vi.fn().mockReturnValue(null),
  formatWhen: vi.fn().mockReturnValue('yesterday'),
  recordVariant: vi.fn().mockResolvedValue(undefined),
  selectVariant: vi.fn().mockReturnValue({ variant: 'mike', prompt: 'Mention Mike!' }),
}));

vi.mock('../lib/job-customer-match.js', () => ({
  matchEventToPerson: vi.fn().mockResolvedValue({
    id: 1,
    name: 'Ed Spooner',
    phone: [{ value: '+15559876543', primary: true }],
    email: [],
  }),
}));

vi.mock('@aac/api-clients/pipedrive', () => ({
  PipedriveClient: { getPrimaryPhone: () => '+15559876543' },
}));

import handler from '../api/cron/job-followups.js';

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

/** Yesterday's job day (what the D-1 query returns). */
const dayOne = {
  id: 'evt-day1',
  summary: 'Ed Spooner',
  location: '188 King Street, Hanover, Massachusetts, 02339',
  description: 'Carbon fiber install day 1',
  start: '2026-09-10T08:00:00-04:00',
  end: '2026-09-10T16:00:00-04:00',
  colorId: '10',
  attendees: ['mike@attackacrack.com'],
  htmlLink: '',
  attachments: [],
};

/** The upcoming continuation ("[cont]" convention). */
const contDay = {
  ...dayOne,
  id: 'evt-cont',
  summary: 'Ed Spooner [cont]',
  start: '2026-09-16T08:00:00-04:00',
  end: '2026-09-16T16:00:00-04:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkCronAction.mockResolvedValue(true);
  mockSendMessage.mockResolvedValue(undefined);
});

// ── Tests ────────────────────────────────────────────────────────────

describe('job-followups multi-day guard', () => {
  it('skips the follow-up when the job continues on a later day', async () => {
    mockListEvents
      .mockResolvedValueOnce([dayOne]) // yesterday's completed jobs
      .mockResolvedValueOnce([contDay]); // upcoming green events

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.summary).toMatchObject({ sent: 0, skipped: 1, errors: 0 });
    expect(body.results[0].status).toBe('skipped_multiday_continuation');
    expect(mockSendMessage).not.toHaveBeenCalled();
    // Dedup must NOT be consumed — the final day sends under its own id.
    expect(mockMarkCronAction).not.toHaveBeenCalled();
  });

  it('skips when the continuation matches by street even without [cont] in the title', async () => {
    const sloppyCont = { ...contDay, summary: 'Spooner day two' };
    mockListEvents.mockResolvedValueOnce([dayOne]).mockResolvedValueOnce([sloppyCont]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.json.mock.calls[0][0].results[0].status).toBe('skipped_multiday_continuation');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('sends normally on the final day (no upcoming continuation)', async () => {
    mockListEvents
      .mockResolvedValueOnce([contDay]) // yesterday = final day of the chain
      .mockResolvedValueOnce([]); // nothing upcoming

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.summary).toMatchObject({ sent: 1, skipped: 0, errors: 0 });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not link unrelated jobs at other addresses', async () => {
    const otherJob = {
      ...contDay,
      id: 'evt-other',
      summary: 'Victor Tuleika',
      location: '272 sheep drive brewster',
    };
    mockListEvents.mockResolvedValueOnce([dayOne]).mockResolvedValueOnce([otherJob]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.json.mock.calls[0][0].summary.sent).toBe(1);
  });

  it('fails open: continuation lookup error → follow-ups still send', async () => {
    mockListEvents
      .mockResolvedValueOnce([dayOne])
      .mockRejectedValueOnce(new Error('calendar 500'));

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.summary).toMatchObject({ sent: 1, errors: 0 });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('makes no continuation lookup when there are no candidate events', async () => {
    mockListEvents.mockResolvedValueOnce([]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockListEvents).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].summary.totalEvents).toBe(0);
  });
});
