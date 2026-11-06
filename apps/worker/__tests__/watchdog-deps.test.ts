/**
 * The watchdog's text falls back to a Gmail send when Quo throws; without
 * Google env or a send scope the Quo error stands (the tick fails and the
 * outside pinger catches the stale heartbeat).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const quo = vi.hoisted(() => ({ sendMessage: vi.fn(), listConversations: vi.fn() }));
vi.mock('../lib/deps.js', () => ({ getWorkerDeps: vi.fn(() => ({ deps: { quo }, redis: {} })) }));

const gmail = vi.hoisted(() => ({ sendMessage: vi.fn(), getProfileEmail: vi.fn(), ctor: vi.fn() }));
vi.mock('@aac/api-clients/gmail', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GmailClient: vi.fn((cfg: unknown) => {
    gmail.ctor(cfg);
    return { sendMessage: gmail.sendMessage, getProfileEmail: gmail.getProfileEmail };
  }),
}));

async function load() {
  vi.resetModules();
  return import('../lib/watchdog-deps.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATT_PERSONAL_PHONE_NUMBER = '+15085550100';
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
  delete process.env.WATCHDOG_ALERT_EMAIL;
  quo.sendMessage.mockResolvedValue({ id: 'm1' });
  gmail.sendMessage.mockResolvedValue({ messageId: 'g1' });
  gmail.getProfileEmail.mockResolvedValue('matt@attackacrack.com');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('watchdog sms', () => {
  it('texts through Quo and never touches Gmail when Quo works', async () => {
    const { getWatchdogDeps } = await load();
    await getWatchdogDeps().sms('⚠️ Quo pipe DOWN');
    expect(quo.sendMessage).toHaveBeenCalledWith('+15085550100', '⚠️ Quo pipe DOWN', '+16177660151');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  it('emails the alert to the token mailbox when the Quo send throws', async () => {
    quo.sendMessage.mockRejectedValue(new Error('Quo 401: invalid api key'));
    const { getWatchdogDeps, FALLBACK_SUBJECT } = await load();
    await getWatchdogDeps().sms('⚠️ Quo pipe DOWN');
    expect(gmail.sendMessage).toHaveBeenCalledWith({
      to: ['matt@attackacrack.com'],
      subject: FALLBACK_SUBJECT,
      body: expect.stringContaining('⚠️ Quo pipe DOWN'),
    });
    expect(gmail.sendMessage.mock.calls[0][0].body).toContain('Quo 401');
  });

  it('uses WATCHDOG_ALERT_EMAIL when set', async () => {
    process.env.WATCHDOG_ALERT_EMAIL = 'alerts@example.com';
    quo.sendMessage.mockRejectedValue(new Error('quo down'));
    const { getWatchdogDeps } = await load();
    await getWatchdogDeps().sms('x');
    expect(gmail.getProfileEmail).not.toHaveBeenCalled();
    expect(gmail.sendMessage.mock.calls[0][0].to).toEqual(['alerts@example.com']);
  });

  it('rethrows the Quo error when the token has no send scope', async () => {
    quo.sendMessage.mockRejectedValue(new Error('quo down'));
    gmail.sendMessage.mockRejectedValue(Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403 }));
    const { getWatchdogDeps } = await load();
    await expect(getWatchdogDeps().sms('x')).rejects.toThrow('quo down');
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' '))).toMatch(/no send scope/);
  });

  it('rethrows the Quo error when the worker has no Google env', async () => {
    delete process.env.GOOGLE_REFRESH_TOKEN;
    quo.sendMessage.mockRejectedValue(new Error('quo down'));
    const { getWatchdogDeps } = await load();
    await expect(getWatchdogDeps().sms('x')).rejects.toThrow('quo down');
    expect(gmail.ctor).not.toHaveBeenCalled();
  });
});
