import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDrain = vi.hoisted(() => ({
  drainFollowupQueue: vi.fn().mockResolvedValue([]),
  drainIntakeDue: vi.fn().mockResolvedValue([]),
  sweepFollowups: vi.fn().mockResolvedValue([]),
  sweepIntake: vi.fn().mockResolvedValue([]),
  processFollowupById: vi.fn().mockResolvedValue({ outcome: 'drafted' }),
}));

vi.mock('@aac/message-drafts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mockDrain,
}));

const mockState = {
  getFirstRunAt: vi.fn().mockResolvedValue('2026-10-19T11:00:00Z'),
  setFirstRunAt: vi.fn(),
};
vi.mock('../lib/deps.js', () => ({
  getWorkerDeps: vi.fn(() => ({
    deps: { state: mockState },
    redis: { set: vi.fn() },
  })),
}));

import { GET as tick } from '../api/tick.js';
import { GET as sweep } from '../api/sweep.js';
import { POST as draftFollowup } from '../api/draft-followup.js';

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
});

describe('auth', () => {
  it('tick/sweep accept the Vercel cron bearer and reject everything else', async () => {
    expect((await tick(req({ authorization: 'Bearer cron-secret' }))).status).toBe(200);
    expect((await tick(req({ authorization: 'Bearer wrong' }))).status).toBe(401);
    expect((await tick(req())).status).toBe(401);
    expect((await sweep(req({ authorization: 'Bearer cron-secret' }))).status).toBe(200);
    expect((await sweep(req())).status).toBe(401);
  });

  it('fails closed when secrets are unset', async () => {
    delete process.env.CRON_SECRET;
    delete process.env.WORKER_SHARED_SECRET;
    expect((await tick(req({ authorization: 'Bearer undefined' }))).status).toBe(401);
    expect((await draftFollowup(req({ 'x-worker-secret': 'undefined' }, { estimateId: '1' }))).status).toBe(401);
  });

  it('draft-followup requires the middleware shared secret', async () => {
    expect((await draftFollowup(req({ 'x-worker-secret': 'worker-secret' }, { estimateId: '2828' }))).status).toBe(202);
    expect((await draftFollowup(req({ 'x-worker-secret': 'nope' }, { estimateId: '2828' }))).status).toBe(401);
  });
});

describe('behavior', () => {
  it('tick drains both fast queues', async () => {
    await tick(req({ authorization: 'Bearer cron-secret' }));
    expect(mockDrain.drainFollowupQueue).toHaveBeenCalledTimes(1);
    expect(mockDrain.drainIntakeDue).toHaveBeenCalledTimes(1);
  });

  it('sweep runs both backstop passes without re-marking firstRun', async () => {
    await sweep(req({ authorization: 'Bearer cron-secret' }));
    expect(mockDrain.sweepFollowups).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ firstRun: false }));
    expect(mockDrain.sweepIntake).toHaveBeenCalledTimes(1);
    expect(mockState.setFirstRunAt).not.toHaveBeenCalled();
  });

  it('draft-followup acks 202 immediately and still runs the draft', async () => {
    const res = await draftFollowup(req({ 'x-worker-secret': 'worker-secret' }, { estimateId: '2828' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'accepted', estimateId: '2828' });
    await vi.waitFor(() => expect(mockDrain.processFollowupById).toHaveBeenCalledWith(expect.anything(), '2828'));
  });

  it('draft-followup sync mode waits and reports the outcome', async () => {
    const res = await draftFollowup(req({ 'x-worker-secret': 'worker-secret' }, { estimateId: '2828', sync: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', outcome: 'drafted' });
  });

  it('draft-followup rejects a missing estimateId', async () => {
    expect((await draftFollowup(req({ 'x-worker-secret': 'worker-secret' }, {}))).status).toBe(400);
  });

  it('tick reports 500 on failure so the cron run is visibly red', async () => {
    mockDrain.drainFollowupQueue.mockRejectedValueOnce(new Error('redis down'));
    expect((await tick(req({ authorization: 'Bearer cron-secret' }))).status).toBe(500);
  });
});
