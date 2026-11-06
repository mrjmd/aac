/**
 * The cron marker policy for a failed customer-facing send (owner-approved
 * 2026-11-05): release the marker only when Quo/QuickBooks definitively
 * answered 4xx/5xx; keep it on anything ambiguous.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => ({ set: redisSet, del: redisDel })),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({ redis: { url: 'https://example.test', token: 'test-token' } }),
}));

import { VendorHttpError } from '@aac/api-clients/errors';
import { markCronAction, releaseCronAction } from '../lib/redis.js';
import { isBackstopNoop, releaseUnsent, settleFailedSend } from '../lib/cron-send.js';

beforeEach(() => {
  redisSet.mockReset().mockResolvedValue('OK');
  redisDel.mockReset().mockResolvedValue(1);
});

describe('markCronAction / releaseCronAction keys', () => {
  it('mark and release use the same key string as before (cron:{action}:{id})', async () => {
    await markCronAction('reminder', 'evt-1');
    expect(redisSet).toHaveBeenCalledWith('cron:reminder:evt-1', expect.any(String), { nx: true, ex: 7 * 86_400 });

    await releaseCronAction('reminder', 'evt-1');
    expect(redisDel).toHaveBeenCalledWith('cron:reminder:evt-1');
  });
});

describe('settleFailedSend', () => {
  it.each([400, 429, 500, 503])('releases the marker on a definitive vendor HTTP %i', async (status) => {
    const err = await settleFailedSend('reminder', 'evt-1', new VendorHttpError('quo', status, `Quo API error: ${status} - x`));
    expect(redisDel).toHaveBeenCalledWith('cron:reminder:evt-1');
    expect(err.message).toContain(`Quo API error: ${status}`);
    expect(err.message).toContain('marker released, next run retries');
  });

  it.each([
    ['network error', new TypeError('fetch failed')],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['malformed success', new Error('QuickBooks did not return invoice after creation')],
    ['non-Error throw', 'boom'],
  ])('keeps the marker on an ambiguous failure (%s)', async (_label, thrown) => {
    const err = await settleFailedSend('invoice-create', 'evt-2', thrown);
    expect(redisDel).not.toHaveBeenCalled();
    expect(err.message).toContain('marker kept, NOT retried');
  });

  it('never throws when the release itself fails; reports the marker as kept', async () => {
    redisDel.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await settleFailedSend(
      'invoice-create',
      'evt-3',
      new VendorHttpError('quickbooks', 500, 'QuickBooks API error: 500 - x'),
    );
    expect(err.message).toContain('marker release FAILED, not retried');
  });
});

describe('isBackstopNoop', () => {
  it('is true only when nothing was sent, nothing failed, and something was already marked', () => {
    const dedup = [{ status: 'skipped_dedup' }, { status: 'skipped_no_phone' }];
    expect(isBackstopNoop(dedup, 0, 0)).toBe(true);
    expect(isBackstopNoop(dedup, 1, 0)).toBe(false);
    expect(isBackstopNoop(dedup, 0, 1)).toBe(false);
    expect(isBackstopNoop([{ status: 'skipped_no_phone' }], 0, 0)).toBe(false);
    expect(isBackstopNoop([], 0, 0)).toBe(false);
  });
});

describe('releaseUnsent', () => {
  it('releases the marker and says so', async () => {
    await expect(releaseUnsent('reminder', 'evt-9')).resolves.toContain('marker released, next run retries');
    expect(redisDel).toHaveBeenCalledWith('cron:reminder:evt-9');
  });

  it('never throws when the release fails', async () => {
    redisDel.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(releaseUnsent('reminder', 'evt-9')).resolves.toContain('marker release FAILED');
  });
});
