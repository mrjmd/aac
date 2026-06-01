import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readRecentHealthErrors, getCronCursor, setCronCursor, claimErrorSurfaceNotification } = vi.hoisted(() => ({
  readRecentHealthErrors: vi.fn(),
  getCronCursor: vi.fn(),
  setCronCursor: vi.fn(),
  claimErrorSurfaceNotification: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  readRecentHealthErrors,
  getCronCursor,
  setCronCursor,
  claimErrorSurfaceNotification,
}));

import { runErrorSurfaceTick, formatErrorSms, errorFingerprint } from '../lib/error-surface.js';
import type { HealthErrorEntry } from '../lib/redis.js';

function makeError(
  ts: string,
  source = 'middleware',
  message = 'boom',
  commitSha = 'deploy-sha-a',
): HealthErrorEntry {
  return { timestamp: ts, source, message, details: { foo: 'bar' }, commitSha };
}

function makeQuo() {
  return { sendMessage: vi.fn().mockResolvedValue({ id: 'sms-1' }) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  readRecentHealthErrors.mockResolvedValue([]);
  getCronCursor.mockResolvedValue(null);
  setCronCursor.mockResolvedValue(undefined);
  // Default: every claim succeeds (no dedup hits). Individual tests
  // override to simulate "already notified".
  claimErrorSurfaceNotification.mockResolvedValue(true);
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

  describe('per-deploy dedup', () => {
    it('skips entries whose fingerprint is already claimed on the same deploy SHA', async () => {
      const errs = [
        makeError('2026-05-28T12:00:02Z', 'quo', 'AI extraction failed: Gemini 404 model retired', 'sha-a'),
        makeError('2026-05-28T12:00:01Z', 'quo', 'AI extraction failed: Gemini 404 model retired', 'sha-a'),
      ];
      readRecentHealthErrors.mockResolvedValue(errs);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      // First claim wins; the duplicate fails to claim.
      claimErrorSurfaceNotification
        .mockResolvedValueOnce(true)   // oldest (12:00:01) wins claim
        .mockResolvedValueOnce(false); // newest (12:00:02) is a dup

      const quo = makeQuo();
      const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

      expect(result.surfaced).toBe(1);
      expect(result.skipped_deduped).toBe(1);
      expect(quo.sendMessage).toHaveBeenCalledTimes(1);
      // Cursor advances past the duplicate so we don't re-scan it next tick.
      expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
    });

    it('resurfaces the same error fingerprint after a new deploy (different commitSha)', async () => {
      // Same fingerprint (source + message), different SHA → claim succeeds again.
      const errs = [
        makeError('2026-05-28T12:00:02Z', 'quo', 'Same error', 'sha-NEW'),
      ];
      readRecentHealthErrors.mockResolvedValue(errs);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      claimErrorSurfaceNotification.mockResolvedValue(true);

      const quo = makeQuo();
      const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

      expect(result.surfaced).toBe(1);
      expect(claimErrorSurfaceNotification).toHaveBeenCalledWith('sha-NEW', expect.any(String));
    });

    it('falls back to SHA "unknown" when commitSha is missing on the entry', async () => {
      const entry: HealthErrorEntry = {
        timestamp: '2026-05-28T12:00:02Z',
        source: 'quo',
        message: 'legacy error without sha',
      };
      readRecentHealthErrors.mockResolvedValue([entry]);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');

      const quo = makeQuo();
      await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

      expect(claimErrorSurfaceNotification).toHaveBeenCalledWith('unknown', expect.any(String));
    });

    it('forwards anyway when the dedup claim itself throws (fail-open)', async () => {
      const errs = [makeError('2026-05-28T12:00:02Z')];
      readRecentHealthErrors.mockResolvedValue(errs);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      claimErrorSurfaceNotification.mockRejectedValueOnce(new Error('redis down'));

      const quo = makeQuo();
      const result = await runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2' });

      expect(result.surfaced).toBe(1);
      expect(quo.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('errorFingerprint', () => {
  it('produces the same fingerprint for entries with same source + message head', () => {
    const a: HealthErrorEntry = {
      timestamp: '2026-05-28T12:00:00Z',
      source: 'quo',
      message: 'AI extraction failed (api_error): Gemini API error 404',
      details: { personId: '1' },
    };
    const b: HealthErrorEntry = {
      timestamp: '2026-05-28T13:00:00Z',
      source: 'quo',
      message: 'AI extraction failed (api_error): Gemini API error 404',
      details: { personId: '99' }, // different ctx, same fingerprint
    };
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it('produces different fingerprints for different sources or messages', () => {
    const base: HealthErrorEntry = {
      timestamp: '2026-05-28T12:00:00Z',
      source: 'quo',
      message: 'Some error',
    };
    expect(errorFingerprint(base)).not.toBe(errorFingerprint({ ...base, source: 'pipedrive' }));
    expect(errorFingerprint(base)).not.toBe(errorFingerprint({ ...base, message: 'Other error' }));
  });
});
