import { describe, it, expect, vi, beforeEach } from 'vitest';

const waitUntil = vi.hoisted(() => vi.fn());
vi.mock('@vercel/functions', () => ({ waitUntil }));

import { defer } from '../defer.js';

beforeEach(() => {
  waitUntil.mockReset();
});

describe('defer', () => {
  it('hands the work to waitUntil inside a Vercel request', async () => {
    let ran = false;
    defer((async () => { ran = true; })());
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(ran).toBe(true);
  });

  it('hands waitUntil a promise that never rejects', async () => {
    defer(Promise.reject(new Error('boom')));
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it('still runs the work when waitUntil throws (no request context)', async () => {
    waitUntil.mockImplementation(() => { throw new Error('no context'); });
    let ran = false;
    expect(() => defer((async () => { ran = true; })())).not.toThrow();
    await vi.waitFor(() => expect(ran).toBe(true));
  });

  it('swallows rejections so nothing escapes the ack', async () => {
    waitUntil.mockImplementation(() => undefined);
    expect(() => defer(Promise.reject(new Error('boom')))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10)); // no unhandled rejection
  });
});
