import { describe, it, expect, vi } from 'vitest';
import { checkWatchdogHeartbeat } from '../lib/watchdog-watch.js';

const NOON_ET = new Date('2026-11-05T17:00:00Z');
const NIGHT_ET = new Date('2026-11-06T07:00:00Z'); // 2am ET

function deps(lastBeat: string | null, now: Date, claim: 'OK' | null = 'OK') {
  const sms = vi.fn().mockResolvedValue(undefined);
  return { sms, d: { redis: { get: vi.fn().mockResolvedValue(lastBeat), set: vi.fn().mockResolvedValue(claim) }, sms, now } };
}

describe('checkWatchdogHeartbeat', () => {
  it('stays quiet while the watchdog beats, or before it ever ran', async () => {
    expect(await checkWatchdogHeartbeat(deps('2026-11-05T16:50:00Z', NOON_ET).d)).toBe('ok');
    expect(await checkWatchdogHeartbeat(deps(null, NOON_ET).d)).toBe('never-ran');
  });

  it('texts once in the daytime when the heartbeat is over 30 min stale', async () => {
    const { d, sms } = deps('2026-11-05T16:00:00Z', NOON_ET);
    expect(await checkWatchdogHeartbeat(d)).toBe('texted');
    expect(sms.mock.calls[0][0]).toMatch(/^⚠️ The pipe watchdog stopped \(last check Thu 11:00 AM\)/);
    expect(await checkWatchdogHeartbeat(deps('2026-11-05T16:00:00Z', NOON_ET, null).d)).toBe('already-sent');
  });

  it('waits for morning instead of texting at night', async () => {
    const { d, sms } = deps('2026-11-06T05:00:00Z', NIGHT_ET);
    expect(await checkWatchdogHeartbeat(d)).toBe('night');
    expect(sms).not.toHaveBeenCalled();
  });
});
