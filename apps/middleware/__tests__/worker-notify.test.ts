import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const envMock = vi.hoisted(() => ({
  worker: { baseUrl: 'https://worker.test', sharedSecret: 's3cret' } as {
    baseUrl: string | null;
    sharedSecret: string | null;
  },
}));
vi.mock('../lib/env.js', () => ({ getEnv: vi.fn(() => envMock) }));

import { notifyWorkerFollowup } from '../lib/worker-notify.js';
import { defer } from '../lib/defer.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
  envMock.worker = { baseUrl: 'https://worker.test', sharedSecret: 's3cret' };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('notifyWorkerFollowup', () => {
  it('POSTs the estimate to the worker fast lane with the shared secret', async () => {
    await notifyWorkerFollowup('2828');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://worker.test/api/draft-followup');
    expect(init.headers['x-worker-secret']).toBe('s3cret');
    expect(JSON.parse(init.body)).toEqual({ estimateId: '2828' });
  });

  it('is a no-op when the worker env is not configured', async () => {
    envMock.worker = { baseUrl: null, sharedSecret: null };
    await notifyWorkerFollowup('2828');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the worker is unreachable (queue is the backstop)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(notifyWorkerFollowup('2828')).resolves.toBeUndefined();
  });

  it('never throws on a non-202 response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(notifyWorkerFollowup('2828')).resolves.toBeUndefined();
  });
});

describe('defer', () => {
  it('still runs the work outside a Vercel request context', async () => {
    let ran = false;
    defer((async () => { ran = true; })());
    await vi.waitFor(() => expect(ran).toBe(true));
  });

  it('swallows rejections so nothing escapes the ack', async () => {
    expect(() => defer(Promise.reject(new Error('boom')))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10)); // no unhandled rejection
  });
});
