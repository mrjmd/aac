import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readRecentHealthErrors, getCronCursor, setCronCursor } = vi.hoisted(() => ({
  readRecentHealthErrors: vi.fn(),
  getCronCursor: vi.fn(),
  setCronCursor: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  readRecentHealthErrors,
  getCronCursor,
  setCronCursor,
}));

import { runErrorSurfaceTick, formatErrorSms } from '../lib/error-surface.js';
import type { HealthErrorEntry } from '../lib/redis.js';

function makeError(ts: string, source = 'middleware', message = 'boom'): HealthErrorEntry {
  return { timestamp: ts, source, message, details: { foo: 'bar' } };
}

function makeQuo() {
  return { sendMessage: vi.fn().mockResolvedValue({ id: 'sms-1' }) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  readRecentHealthErrors.mockResolvedValue([]);
  getCronCursor.mockResolvedValue(null);
  setCronCursor.mockResolvedValue(undefined);
});

describe('formatErrorSms', () => {
  it('includes source, timestamp, and message', () => {
    const out = formatErrorSms(makeError('2026-05-28T12:00:00Z', 'cron:invoice-create', 'fail x'));
    expect(out).toContain('cron:invoice-create');
    expect(out).toContain('2026-05-28T12:00:00Z');
    expect(out).toContain('fail x');
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(500);
    const out = formatErrorSms(makeError('2026-05-28T12:00:00Z', 'src', long));
    expect(out.length).toBeLessThan(700);
    expect(out).toContain('...');
  });
});

describe('runErrorSurfaceTick', () => {
  it('does nothing when middleware has no errors', async () => {
    const quo = makeQuo();
    const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

    expect(result.scanned).toBe(0);
    expect(result.surfaced).toBe(0);
    expect(quo.sendMessage).not.toHaveBeenCalled();
    expect(setCronCursor).not.toHaveBeenCalled();
  });

  it('on first run, stamps cursor at newest entry and surfaces nothing', async () => {
    const errs = [
      makeError('2026-05-28T12:00:02Z'),
      makeError('2026-05-28T12:00:01Z'),
      makeError('2026-05-28T12:00:00Z'),
    ];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue(null);

    const quo = makeQuo();
    const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

    expect(result.scanned).toBe(3);
    expect(result.surfaced).toBe(0);
    expect(result.skipped_first_run).toBe(3);
    expect(quo.sendMessage).not.toHaveBeenCalled();
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
  });

  it('forwards only entries newer than the cursor, oldest first', async () => {
    // Newest-first as returned by Redis LRANGE
    const errs = [
      makeError('2026-05-28T12:00:05Z', 'a'),
      makeError('2026-05-28T12:00:04Z', 'b'),
      makeError('2026-05-28T12:00:03Z', 'c'), // == cursor; skip
      makeError('2026-05-28T12:00:02Z', 'd'), // < cursor; skip
    ];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:03Z');

    const quo = makeQuo();
    const result = await runErrorSurfaceTick({ quo, recipient: '+18287724836', sender: '+16177660151' });

    expect(result.surfaced).toBe(2);
    expect(result.skipped_stale).toBe(2);

    // Oldest-first delivery
    expect(quo.sendMessage).toHaveBeenNthCalledWith(
      1,
      '+18287724836',
      expect.stringContaining('src: b'),
      '+16177660151'
    );
    expect(quo.sendMessage).toHaveBeenNthCalledWith(
      2,
      '+18287724836',
      expect.stringContaining('src: a'),
      '+16177660151'
    );
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:05Z');
  });

  it('caps surfaced count at MAX_SURFACED_PER_TICK (5) and still advances cursor to newest', async () => {
    const errs = Array.from({ length: 8 }, (_, i) =>
      makeError(`2026-05-28T12:00:0${8 - i}Z`, `src-${8 - i}`)
    );
    // errs[0] is newest (12:00:08), errs[7] is oldest (12:00:01)
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');

    const quo = makeQuo();
    const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

    expect(result.surfaced).toBe(5);
    expect(quo.sendMessage).toHaveBeenCalledTimes(5);
    // Cursor advances to the NEWEST forwarded entry (not the oldest), so the
    // skipped older ones do NOT replay on the next tick.
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:08Z');
  });

  it('counts SMS send failures but keeps going', async () => {
    const errs = [
      makeError('2026-05-28T12:00:02Z', 'a'),
      makeError('2026-05-28T12:00:01Z', 'b'),
    ];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');

    const quo = makeQuo();
    quo.sendMessage
      .mockRejectedValueOnce(new Error('quo down'))
      .mockResolvedValueOnce({ id: 'sms-2' });

    const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

    expect(result.surfaced).toBe(1);
    expect(result.errors).toBe(1);
    // Cursor advances to the timestamp of the LAST SUCCESSFUL send (the
    // newer 'a'). The failed older 'b' is lost — acceptable for Crawl
    // since the entries also remain in middleware's health:errors list
    // and on /api/health for manual review.
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
  });

  it('no-ops when nothing is newer than cursor', async () => {
    const errs = [
      makeError('2026-05-28T12:00:01Z'),
      makeError('2026-05-28T12:00:00Z'),
    ];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:01Z');

    const quo = makeQuo();
    const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

    expect(result.surfaced).toBe(0);
    expect(quo.sendMessage).not.toHaveBeenCalled();
    expect(setCronCursor).not.toHaveBeenCalled();
  });
});
