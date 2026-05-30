import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCallbackParent } from '../src/resolve-callback-parent.js';
import type { CalendarEvent, GoogleCalendarClient } from '@aac/api-clients/google-calendar';

const fixedNow = () => new Date('2026-05-30T12:00:00.000Z');

function makeCal(events: CalendarEvent[]): GoogleCalendarClient {
  const listEvents = vi.fn().mockResolvedValue(events);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { listEvents } as any;
}

function ev(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-x',
    summary: 'John Smith — Crack Injection',
    description: '[deal:42] Smith basement crack',
    start: '2025-10-01T13:00:00Z',
    end: '2025-10-01T15:00:00Z',
    colorId: '10',
    attendees: [],
    htmlLink: '',
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCallbackParent', () => {
  it('returns parent dealId from the most recent matching job event', async () => {
    const cal = makeCal([
      ev({ id: 'old', start: '2024-03-15T13:00:00Z', description: '[deal:11]' }),
      ev({ id: 'recent', start: '2025-10-01T13:00:00Z', description: '[deal:42]' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result).not.toBeNull();
    expect(result!.parentDealId).toBe(42);
    expect(result!.callbackSequence).toBe(1);
  });

  it('counts subsequent callback events to compute sequence', async () => {
    const cal = makeCal([
      ev({ id: 'parent', start: '2025-06-01T13:00:00Z', description: '[deal:50]', colorId: '10' }),
      ev({ id: 'cb1', start: '2025-08-15T13:00:00Z', description: 'first callback', colorId: '5' }),
      ev({ id: 'cb2', start: '2026-02-10T13:00:00Z', description: 'second callback', colorId: '5' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result!.parentDealId).toBe(50);
    expect(result!.callbackSequence).toBe(3);
  });

  it('does not count callbacks BEFORE the parent', async () => {
    const cal = makeCal([
      // hypothetical older callback for an even earlier (out of window) job
      ev({ id: 'stale-cb', start: '2025-04-01T13:00:00Z', colorId: '5' }),
      ev({ id: 'parent', start: '2025-06-01T13:00:00Z', description: '[deal:50]', colorId: '10' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result!.callbackSequence).toBe(1);
  });

  it('case-insensitively matches customer name in summary', async () => {
    const cal = makeCal([
      ev({ summary: 'john smith - patio resurfacing', description: '[deal:9]' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result!.parentDealId).toBe(9);
  });

  it('returns null when no events match the customer name', async () => {
    const cal = makeCal([
      ev({ summary: 'Some Other Person — Job' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result).toBeNull();
  });

  it('returns null when matching job has no [deal:N] marker', async () => {
    const cal = makeCal([
      ev({ description: 'Smith basement crack — pre-spine event with no deal marker' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result).toBeNull();
  });

  it('returns null when only callback events match (no parent job in window)', async () => {
    const cal = makeCal([
      ev({ colorId: '5', description: '[deal:99]' }),
      ev({ colorId: '5', description: '[deal:99]' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result).toBeNull();
  });

  it('extracts originalServiceType from "Name — Service" summary', async () => {
    const cal = makeCal([
      ev({ summary: 'John Smith — Crack Injection', description: '[deal:42]' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result!.originalServiceType).toBe('Crack Injection');
  });

  it('omits originalServiceType when summary has nothing after the name', async () => {
    const cal = makeCal([
      ev({ summary: 'John Smith', description: '[deal:42]' }),
    ]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result!.originalServiceType).toBeUndefined();
  });

  it('returns null on calendar API error', async () => {
    const cal = {
      listEvents: vi.fn().mockRejectedValue(new Error('cal API down')),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow },
    );

    expect(result).toBeNull();
  });

  it('returns null on empty customer name', async () => {
    const cal = makeCal([]);

    const result = await resolveCallbackParent(
      { cal },
      { customerName: '   ', now: fixedNow },
    );

    expect(result).toBeNull();
  });

  it('respects custom lookbackDays in the timeMin window', async () => {
    const cal = makeCal([]);

    await resolveCallbackParent(
      { cal },
      { customerName: 'John Smith', now: fixedNow, lookbackDays: 30 },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (cal.listEvents as any).mock.calls[0][0];
    const timeMin = new Date(args.timeMin);
    const timeMax = new Date(args.timeMax);
    const diffDays = (timeMax.getTime() - timeMin.getTime()) / 86_400_000;
    expect(Math.round(diffDays)).toBe(30);
    expect(args.colorIds).toEqual(['10', '5']);
  });
});
