import { describe, it, expect, vi, beforeEach } from 'vitest';

const redis = vi.hoisted(() => ({
  readRecentHealthErrors: vi.fn(),
  getCronCursor: vi.fn(),
  setCronCursor: vi.fn(),
  claimErrorSurfaceNotification: vi.fn(),
  isErrorSurfaceClaimed: vi.fn(),
  markErrorFingerprintSurfaced: vi.fn(),
  wasErrorFingerprintSurfaced: vi.fn(),
  trackCronRun: vi.fn(),
}));
const {
  readRecentHealthErrors,
  getCronCursor,
  setCronCursor,
  claimErrorSurfaceNotification,
  isErrorSurfaceClaimed,
  markErrorFingerprintSurfaced,
  wasErrorFingerprintSurfaced,
  trackCronRun,
} = redis;

vi.mock('../lib/redis.js', () => redis);

import {
  runErrorSurfaceTick,
  formatErrorSms,
  formatSuppressedSms,
  errorFingerprint,
  isDaytime,
} from '../lib/error-surface.js';
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
  // Default: nothing texted before (no dedup hits, no repeats).
  claimErrorSurfaceNotification.mockResolvedValue(true);
  isErrorSurfaceClaimed.mockResolvedValue(false);
  markErrorFingerprintSurfaced.mockResolvedValue(undefined);
  wasErrorFingerprintSurfaced.mockResolvedValue(false);
  trackCronRun.mockResolvedValue(undefined);
});

/** Noon Eastern on the day the fixture errors were logged (12:00Z = 8 AM ET). */
const NOON = new Date('2026-05-28T16:00:00Z');
/** 2 AM Eastern the next night. */
const NIGHT = new Date('2026-05-29T06:00:00Z');
const tick = (quo: ReturnType<typeof makeQuo>, now = NOON) =>
  runErrorSurfaceTick({ quo, recipient: '+1', sender: '+2', now });

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
    const result = await runErrorSurfaceTick({ quo, recipient: '+18287724836', sender: '+16177660151', now: NOON });

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

  it('reads the whole 100-entry list', async () => {
    await tick(makeQuo());
    expect(readRecentHealthErrors).toHaveBeenCalledWith(100);
  });

  it('over the cap: texts the newest five, then one line with the rest and their sources, and advances past all', async () => {
    const errs = Array.from({ length: 8 }, (_, i) =>
      makeError(`2026-05-28T12:00:0${8 - i}Z`, `src-${8 - i}`)
    );
    // errs[0] is newest (12:00:08), errs[7] is oldest (12:00:01)
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');

    const quo = makeQuo();
    const result = await tick(quo);

    expect(result.surfaced).toBe(5);
    expect(result.suppressed).toBe(3);
    expect(quo.sendMessage).toHaveBeenCalledTimes(6);
    const bodies = quo.sendMessage.mock.calls.map((c: unknown[]) => c[1] as string);
    expect(bodies.slice(0, 5).map((b: string) => b.match(/src: (\S+)/)![1])).toEqual(['src-4', 'src-5', 'src-6', 'src-7', 'src-8']);
    expect(bodies[5]).toMatch(/^\[errors\] 3 more errors suppressed/);
    expect(bodies[5]).toContain('src-1');
    expect(bodies[5]).toContain('src-3');
    // The suppressed ones were reported, so the cursor passes them all.
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:08Z');
    // Suppressed entries are not claimed: a recurrence texts in full.
    expect(claimErrorSurfaceNotification).toHaveBeenCalledTimes(5);
  });

  it('a failed suppressed line keeps the cursor before the suppressed entries', async () => {
    const errs = Array.from({ length: 7 }, (_, i) => makeError(`2026-05-28T12:00:0${7 - i}Z`, `src-${7 - i}`));
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
    const quo = makeQuo();
    quo.sendMessage.mockImplementation(async (_to: string, body: string) => {
      if (body.startsWith('[errors]')) throw new Error('quo down');
      return { id: 'x' };
    });
    const result = await tick(quo);
    expect(result.surfaced).toBe(5);
    expect(result.errors).toBe(1);
    expect(setCronCursor).not.toHaveBeenCalled();
    expect(trackCronRun).not.toHaveBeenCalled();
  });

  it('never advances the cursor past a failed send, and does not claim it', async () => {
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

    const result = await tick(quo);

    expect(result.surfaced).toBe(1);
    expect(result.errors).toBe(1);
    // 'b' (older) failed: the cursor stays put so it retries next tick.
    expect(setCronCursor).not.toHaveBeenCalled();
    // Only the delivered 'a' is claimed.
    expect(claimErrorSurfaceNotification).toHaveBeenCalledTimes(1);
    expect(claimErrorSurfaceNotification).toHaveBeenCalledWith('deploy-sha-a', errorFingerprint(errs[0]));
    // A tick that owed a text it couldn't send is not a successful run.
    expect(trackCronRun).not.toHaveBeenCalled();
  });

  it('retries the failed entry next tick; the already-sent newer one dedupes on its claim', async () => {
    const errs = [makeError('2026-05-28T12:00:02Z', 'a'), makeError('2026-05-28T12:00:01Z', 'b')];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
    isErrorSurfaceClaimed.mockImplementation(async (_sha: string, fp: string) => fp === errorFingerprint(errs[0]));
    const quo = makeQuo();
    const result = await tick(quo);
    expect(quo.sendMessage).toHaveBeenCalledTimes(1);
    expect(quo.sendMessage.mock.calls[0][1]).toContain('src: b');
    expect(result.skipped_deduped).toBe(1);
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
  });

  it('gives up on a send still failing 12h after the error, so the cursor cannot stall', async () => {
    const errs = [makeError('2026-05-28T12:00:01Z', 'b')];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
    const quo = makeQuo();
    quo.sendMessage.mockRejectedValue(new Error('400 bad body'));
    const result = await tick(quo, new Date('2026-05-29T00:30:00Z'));
    expect(result.given_up).toBe(1);
    expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:01Z');
  });

  it('stamps the error-surface last-run after a tick with nothing to send', async () => {
    const result = await tick(makeQuo());
    expect(result.scanned).toBe(0);
    expect(trackCronRun).toHaveBeenCalledWith('error-surface', { sent: 0, skipped: 0, errors: 0 });
  });

  it('stamps the last-run with what it sent', async () => {
    readRecentHealthErrors.mockResolvedValue([makeError('2026-05-28T12:00:01Z', 'b')]);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
    await tick(makeQuo());
    expect(trackCronRun).toHaveBeenCalledWith('error-surface', { sent: 1, skipped: 0, errors: 0 });
  });

  it('no-ops when nothing is newer than cursor', async () => {
    const errs = [
      makeError('2026-05-28T12:00:01Z'),
      makeError('2026-05-28T12:00:00Z'),
    ];
    readRecentHealthErrors.mockResolvedValue(errs);
    getCronCursor.mockResolvedValue('2026-05-28T12:00:01Z');

    const quo = makeQuo();
    const result = await tick(quo);

    expect(result.surfaced).toBe(0);
    expect(quo.sendMessage).not.toHaveBeenCalled();
    expect(setCronCursor).not.toHaveBeenCalled();
  });

  describe('daytime rule', () => {
    it('isDaytime is 8 AM to 9 PM Eastern', () => {
      expect(isDaytime(new Date('2026-05-28T11:59:00Z'))).toBe(false); // 7:59 AM EDT
      expect(isDaytime(new Date('2026-05-28T12:00:00Z'))).toBe(true); // 8:00 AM
      expect(isDaytime(new Date('2026-05-29T00:59:00Z'))).toBe(true); // 8:59 PM
      expect(isDaytime(new Date('2026-05-29T01:00:00Z'))).toBe(false); // 9:00 PM
    });

    it('a first occurrence texts at night; a repeat is held and blocks the cursor', async () => {
      const repeat = makeError('2026-05-29T05:00:00Z', 'quo', 'Pipedrive 502', 'sha-new');
      const fresh = makeError('2026-05-29T05:30:00Z', 'worker:sweep', 'sweep failed');
      readRecentHealthErrors.mockResolvedValue([fresh, repeat]);
      getCronCursor.mockResolvedValue('2026-05-29T04:00:00Z');
      wasErrorFingerprintSurfaced.mockImplementation(async (fp: string) => fp === errorFingerprint(repeat));
      const quo = makeQuo();
      const result = await tick(quo, NIGHT);
      expect(result.held_night).toBe(1);
      expect(result.surfaced).toBe(1);
      expect(quo.sendMessage.mock.calls[0][1]).toContain('worker:sweep');
      expect(markErrorFingerprintSurfaced).toHaveBeenCalledWith(errorFingerprint(fresh));
      // The held repeat is older than the sent one: the cursor stays before it.
      expect(setCronCursor).not.toHaveBeenCalled();
      expect(trackCronRun).toHaveBeenCalled();
    });

    it('the held repeat texts once it is daytime', async () => {
      const repeat = makeError('2026-05-29T05:00:00Z', 'quo', 'Pipedrive 502', 'sha-new');
      readRecentHealthErrors.mockResolvedValue([repeat]);
      getCronCursor.mockResolvedValue('2026-05-29T04:00:00Z');
      wasErrorFingerprintSurfaced.mockResolvedValue(true);
      const quo = makeQuo();
      const result = await tick(quo, new Date('2026-05-29T12:10:00Z'));
      expect(result.surfaced).toBe(1);
      expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-29T05:00:00Z');
    });
  });

  describe('per-deploy dedup', () => {
    it('texts one of several identical errors in a tick and passes the rest', async () => {
      const errs = [
        makeError('2026-05-28T12:00:02Z', 'quo', 'AI extraction failed: Gemini 404 model retired', 'sha-a'),
        makeError('2026-05-28T12:00:01Z', 'quo', 'AI extraction failed: Gemini 404 model retired', 'sha-a'),
      ];
      readRecentHealthErrors.mockResolvedValue(errs);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');

      const quo = makeQuo();
      const result = await tick(quo);

      expect(result.surfaced).toBe(1);
      expect(result.skipped_deduped).toBe(1);
      expect(quo.sendMessage).toHaveBeenCalledTimes(1);
      expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
    });

    it('skips an entry already texted on this deploy and advances past it', async () => {
      readRecentHealthErrors.mockResolvedValue([makeError('2026-05-28T12:00:02Z', 'quo', 'x', 'sha-a')]);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      isErrorSurfaceClaimed.mockResolvedValue(true);
      const quo = makeQuo();
      const result = await tick(quo);
      expect(quo.sendMessage).not.toHaveBeenCalled();
      expect(result.skipped_deduped).toBe(1);
      expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
    });

    it('claims only after the text went out', async () => {
      readRecentHealthErrors.mockResolvedValue([makeError('2026-05-28T12:00:02Z', 'quo', 'Same error', 'sha-NEW')]);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      const order: string[] = [];
      const quo = makeQuo();
      quo.sendMessage.mockImplementation(async () => {
        order.push('send');
        return { id: 'x' };
      });
      claimErrorSurfaceNotification.mockImplementation(async () => {
        order.push('claim');
        return true;
      });
      await tick(quo);
      expect(order).toEqual(['send', 'claim']);
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

      await tick(makeQuo());

      expect(isErrorSurfaceClaimed).toHaveBeenCalledWith('unknown', expect.any(String));
      expect(claimErrorSurfaceNotification).toHaveBeenCalledWith('unknown', expect.any(String));
    });

    it('texts anyway when the dedup check itself throws (fail-open)', async () => {
      readRecentHealthErrors.mockResolvedValue([makeError('2026-05-28T12:00:02Z')]);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      isErrorSurfaceClaimed.mockRejectedValueOnce(new Error('redis down'));

      const quo = makeQuo();
      const result = await tick(quo);

      expect(result.surfaced).toBe(1);
      expect(quo.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('a claim failing after the send still counts the text as sent', async () => {
      readRecentHealthErrors.mockResolvedValue([makeError('2026-05-28T12:00:02Z')]);
      getCronCursor.mockResolvedValue('2026-05-28T12:00:00Z');
      claimErrorSurfaceNotification.mockRejectedValueOnce(new Error('redis down'));
      const result = await tick(makeQuo());
      expect(result.surfaced).toBe(1);
      expect(setCronCursor).toHaveBeenCalledWith('error-surface', '2026-05-28T12:00:02Z');
    });
  });
});

describe('formatSuppressedSms', () => {
  it('counts and lists sources, busiest first', () => {
    const e = (source: string) => makeError('t', source);
    expect(formatSuppressedSms([e('a'), e('b'), e('b')])).toBe(
      '[errors] 3 more errors suppressed (5-text cap per run). Sources: b (2), a. Full list: health:errors.',
    );
    expect(formatSuppressedSms([e('a')])).toMatch(/^\[errors\] 1 more error suppressed/);
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

  it('strips JSON payloads after ": {" so varying response bodies dedupe to one fingerprint', () => {
    const a: HealthErrorEntry = {
      timestamp: 't1',
      source: 'quo',
      message: 'Scheduling classifier failed: Intent JSON parse failed: {\n"intent": null,\n"rationale": "first response varies here"\n}',
    };
    const b: HealthErrorEntry = {
      timestamp: 't2',
      source: 'quo',
      message: 'Scheduling classifier failed: Intent JSON parse failed: {\n"intent": null,\n"rationale": "wildly different second response"\n}',
    };
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it('strips array payloads after ": [" too', () => {
    const a: HealthErrorEntry = {
      timestamp: 't1', source: 'pd', message: 'Persons fetch failed: [{ id: 1, oops: true }]',
    };
    const b: HealthErrorEntry = {
      timestamp: 't2', source: 'pd', message: 'Persons fetch failed: [{ id: 999, oops: false }]',
    };
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it('only takes the first line so multi-line tracebacks dedupe to the headline', () => {
    const a: HealthErrorEntry = {
      timestamp: 't1', source: 'q', message: 'Quo send failed\nat Quo.send (file:1:1)\n    at next (file:2:2)',
    };
    const b: HealthErrorEntry = {
      timestamp: 't2', source: 'q', message: 'Quo send failed\nat Quo.send (other:9:9)',
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
