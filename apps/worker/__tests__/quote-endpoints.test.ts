import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDrafter = vi.hoisted(() => ({
  runTick: vi.fn().mockResolvedValue({
    mode: 'live',
    drained: 0,
    due: 0,
    settling: 0,
    drafted: 0,
    records: [],
  }),
  loadAssets: vi.fn().mockResolvedValue({ rulesetText: 'SECTION 0', exemplarLibrary: [] }),
  prepareRun: vi.fn().mockResolvedValue({ itemNames: [], nextDocNumber: 1600 }),
  loadFieldChannel: vi.fn().mockResolvedValue(null),
  draftOne: vi.fn().mockResolvedValue({
    phone: '+15083611747',
    customer: 'John Skinner',
    outcome: 'skipped',
    detail: 'recent estimate #1562',
  }),
}));

vi.mock('@aac/quote-drafter', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mockDrafter,
}));

const redisMock = { set: vi.fn() };
vi.mock('../lib/quote-deps.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getQuoteDeps: vi.fn(() => ({ redis: redisMock })),
}));

import { GET as quoteTick } from '../api/quote-tick.js';
import { POST as quoteDraft } from '../api/quote-draft.js';

function req(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request('https://worker.test/api/x', {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
  process.env.QUOTE_DRAFTER_MODE = 'shadow';
});

describe('quote-tick', () => {
  it('requires cron or middleware auth', async () => {
    expect((await quoteTick(req({ authorization: 'Bearer cron-secret' }))).status).toBe(200);
    expect((await quoteTick(req({ 'x-worker-secret': 'worker-secret' }))).status).toBe(200);
    expect((await quoteTick(req({ authorization: 'Bearer wrong' }))).status).toBe(401);
    expect((await quoteTick(req())).status).toBe(401);
  });

  it('passes the env mode through and reports the summary', async () => {
    const res = await quoteTick(req({ authorization: 'Bearer cron-secret' }));
    expect(mockDrafter.runTick).toHaveBeenCalledWith(expect.anything(), 'shadow');
    expect(await res.json()).toMatchObject({ status: 'ok', mode: 'live' });
  });

  it('defaults to off when QUOTE_DRAFTER_MODE is unset or garbage', async () => {
    delete process.env.QUOTE_DRAFTER_MODE;
    await quoteTick(req({ authorization: 'Bearer cron-secret' }));
    expect(mockDrafter.runTick).toHaveBeenLastCalledWith(expect.anything(), 'off');
    process.env.QUOTE_DRAFTER_MODE = 'LIVE!!';
    await quoteTick(req({ authorization: 'Bearer cron-secret' }));
    expect(mockDrafter.runTick).toHaveBeenLastCalledWith(expect.anything(), 'off');
  });

  it('skips the heartbeat when the drafter is off', async () => {
    mockDrafter.runTick.mockResolvedValueOnce({
      mode: 'off', skipped: 'off', drained: 0, due: 0, settling: 0, drafted: 0, records: [],
    });
    await quoteTick(req({ authorization: 'Bearer cron-secret' }));
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('reports 500 on failure so the cron run is visibly red', async () => {
    mockDrafter.runTick.mockRejectedValueOnce(new Error('redis down'));
    expect((await quoteTick(req({ authorization: 'Bearer cron-secret' }))).status).toBe(500);
  });
});

describe('quote-draft', () => {
  it('requires auth and a valid E.164 phone', async () => {
    expect((await quoteDraft(req({}, { phone: '+15083611747' }))).status).toBe(401);
    expect((await quoteDraft(req({ 'x-worker-secret': 'worker-secret' }, { phone: '5083611747' }))).status).toBe(400);
    expect((await quoteDraft(req({ 'x-worker-secret': 'worker-secret' }, {}))).status).toBe(400);
  });

  it('runs a synchronous draft and returns the record', async () => {
    const res = await quoteDraft(
      req({ 'x-worker-secret': 'worker-secret' }, { phone: '+15083611747', dryRun: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      record: { outcome: 'skipped', customer: 'John Skinner' },
    });
    expect(mockDrafter.draftOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true, hasNewInbound: true }),
    );
  });

  it('409s when no asset manifest exists', async () => {
    mockDrafter.loadAssets.mockResolvedValueOnce(null);
    const res = await quoteDraft(
      req({ 'x-worker-secret': 'worker-secret' }, { phone: '+15083611747' }),
    );
    expect(res.status).toBe(409);
    expect(mockDrafter.draftOne).not.toHaveBeenCalled();
  });
});
