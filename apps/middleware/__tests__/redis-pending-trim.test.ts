/**
 * writePendingDirective caps each pending list at 500 ids. LTRIM alone left
 * the trimmed ids' blobs behind (781 orphans by 11/06), reachable only by
 * id. The trim now DELs the blobs of the ids that fell off, unless the id
 * is still on either list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lists: Record<string, string[]> = {};
const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(() => ({
    set: redisSet,
    del: redisDel,
    lpush: vi.fn(async (k: string, v: string) => {
      (lists[k] ??= []).unshift(v);
    }),
    lrange: vi.fn(async (k: string, start: number, stop: number) =>
      (lists[k] ?? []).slice(start, stop === -1 ? undefined : stop + 1),
    ),
    ltrim: vi.fn(async (k: string, start: number, stop: number) => {
      lists[k] = (lists[k] ?? []).slice(start, stop + 1);
    }),
  })),
}));

vi.mock('../lib/env.js', () => ({
  getEnv: () => ({ redis: { url: 'https://example.test', token: 'test-token' } }),
}));

vi.mock('../lib/clients.js', () => ({ getCalendar: vi.fn() }));

import { keys } from '@aac/shared-utils/redis';
import { PENDING_LIST_CAP, writePendingDirective } from '../lib/redis.js';

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('writePendingDirective list trim', () => {
  beforeEach(() => {
    for (const k of Object.keys(lists)) delete lists[k];
    redisSet.mockReset();
    redisDel.mockReset();
  });

  it('deletes nothing while the list is under the cap', async () => {
    lists[keys.schedulingPendingList] = ids(PENDING_LIST_CAP - 1, 'old');
    await writePendingDirective({ id: 'new', confidence: { score: 0.9 } });
    expect(lists[keys.schedulingPendingList]).toHaveLength(PENDING_LIST_CAP);
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('deletes the blob of the id trimmed off the end', async () => {
    const old = ids(PENDING_LIST_CAP, 'old');
    lists[keys.schedulingPendingList] = [...old];
    await writePendingDirective({ id: 'new', confidence: { score: 0.9 } });
    expect(lists[keys.schedulingPendingList]).toHaveLength(PENDING_LIST_CAP);
    expect(lists[keys.schedulingPendingList][0]).toBe('new');
    expect(redisDel).toHaveBeenCalledTimes(1);
    expect(redisDel).toHaveBeenCalledWith(keys.schedulingPending(old[PENDING_LIST_CAP - 1]));
  });

  it('trims the review list for a low-confidence directive', async () => {
    const old = ids(PENDING_LIST_CAP, 'rev');
    lists[keys.schedulingPendingReviewList] = [...old];
    await writePendingDirective({ id: 'new', confidence: { score: 0.1 } });
    expect(lists[keys.schedulingPendingReviewList][0]).toBe('new');
    expect(redisDel).toHaveBeenCalledWith(keys.schedulingPending(old[PENDING_LIST_CAP - 1]));
  });

  it('keeps the blob of a trimmed id that is still listed', async () => {
    const old = ids(PENDING_LIST_CAP, 'old');
    const last = old[PENDING_LIST_CAP - 1];
    old[3] = last; // same id written twice: once near the top, once at the tail
    lists[keys.schedulingPendingList] = [...old];
    lists[keys.schedulingPendingReviewList] = ['other'];
    await writePendingDirective({ id: 'new', confidence: { score: 0.9 } });
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('keeps the blob of a trimmed id that sits on the other list', async () => {
    const old = ids(PENDING_LIST_CAP, 'old');
    lists[keys.schedulingPendingList] = [...old];
    lists[keys.schedulingPendingReviewList] = [old[PENDING_LIST_CAP - 1]];
    await writePendingDirective({ id: 'new', confidence: { score: 0.9 } });
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('leaves the estimate reverse index in place', async () => {
    lists[keys.schedulingPendingList] = ids(PENDING_LIST_CAP, 'old');
    await writePendingDirective({ id: 'new', qbEstimateId: '1500', confidence: { score: 0.9 } });
    expect(redisSet).toHaveBeenCalledWith(keys.schedulingDirectiveByEstimate('1500'), 'new');
    for (const call of redisDel.mock.calls) {
      for (const k of call) expect(String(k)).toMatch(/^scheduling:pending:/);
    }
  });
});
