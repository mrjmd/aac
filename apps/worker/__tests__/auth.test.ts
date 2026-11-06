import { describe, it, expect, beforeEach } from 'vitest';
import { isCronRequest, isMiddlewareRequest } from '../lib/auth.js';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://worker.test/api/x', { headers });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.WORKER_SHARED_SECRET = 'worker-secret';
});

describe('isCronRequest', () => {
  it('accepts exactly "Bearer <CRON_SECRET>"', () => {
    expect(isCronRequest(req({ authorization: 'Bearer cron-secret' }))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isCronRequest(req())).toBe(false);
    expect(isCronRequest(req({ authorization: 'Bearer nope' }))).toBe(false);
    expect(isCronRequest(req({ authorization: 'bearer cron-secret' }))).toBe(false);
    expect(isCronRequest(req({ authorization: 'cron-secret' }))).toBe(false);
    expect(isCronRequest(req({ 'x-worker-secret': 'cron-secret' }))).toBe(false);
  });

  it('fails closed when CRON_SECRET is unset or empty', () => {
    delete process.env.CRON_SECRET;
    expect(isCronRequest(req({ authorization: 'Bearer undefined' }))).toBe(false);
    expect(isCronRequest(req({ authorization: 'Bearer' }))).toBe(false);
    process.env.CRON_SECRET = '';
    expect(isCronRequest(req({ authorization: 'Bearer' }))).toBe(false);
  });
});

describe('isMiddlewareRequest', () => {
  it('accepts the exact x-worker-secret', () => {
    expect(isMiddlewareRequest(req({ 'x-worker-secret': 'worker-secret' }))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isMiddlewareRequest(req())).toBe(false);
    expect(isMiddlewareRequest(req({ 'x-worker-secret': 'nope' }))).toBe(false);
    expect(isMiddlewareRequest(req({ authorization: 'Bearer worker-secret' }))).toBe(false);
  });

  it('fails closed when WORKER_SHARED_SECRET is unset or empty', () => {
    delete process.env.WORKER_SHARED_SECRET;
    expect(isMiddlewareRequest(req({ 'x-worker-secret': 'undefined' }))).toBe(false);
    process.env.WORKER_SHARED_SECRET = '';
    expect(isMiddlewareRequest(req({ 'x-worker-secret': '' }))).toBe(false);
  });
});
