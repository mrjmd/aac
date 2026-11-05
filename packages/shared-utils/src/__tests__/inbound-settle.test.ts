import { describe, it, expect } from 'vitest';
import { settleDueAt, SETTLE_CAP_MS, SETTLE_QUIET_MS } from '../inbound-settle.js';

const T0 = Date.parse('2026-11-05T15:00:00Z');

describe('settleDueAt', () => {
  it('settles 2 minutes after the last event', () => {
    expect(SETTLE_QUIET_MS).toBe(120_000);
    expect(settleDueAt(T0, T0)).toBe(T0 + 120_000);
    expect(settleDueAt(T0, T0 + 60_000)).toBe(T0 + 180_000);
  });

  it('never later than 10 minutes after the first', () => {
    expect(SETTLE_CAP_MS).toBe(600_000);
    expect(settleDueAt(T0, T0 + 9.5 * 60_000)).toBe(T0 + 600_000);
  });
});
