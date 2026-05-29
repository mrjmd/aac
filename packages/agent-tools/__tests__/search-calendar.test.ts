import { describe, it, expect, vi } from 'vitest';
import { searchCalendar } from '../src/search-calendar.js';
import type { ToolDeps } from '../src/types.js';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt',
    summary: 'sample',
    description: 'desc',
    location: 'Cambridge MA',
    start: '2026-06-01T13:00:00Z',
    end: '2026-06-01T16:00:00Z',
    attendees: [],
    htmlLink: 'https://cal/evt',
    attachments: [],
    ...overrides,
  };
}

function makeDeps(events: unknown[]): { deps: ToolDeps; listEvents: ReturnType<typeof vi.fn> } {
  const listEvents = vi.fn().mockResolvedValue(events);
  return {
    listEvents,
    deps: {
      pd: {} as never,
      qb: {} as never,
      quo: {} as never,
      cal: { listEvents } as never,
    },
  };
}

describe('searchCalendar', () => {
  it('rejects missing range', async () => {
    const { deps } = makeDeps([]);
    await expect(
      searchCalendar(deps, { rangeStart: '', rangeEnd: '' }),
    ).rejects.toThrow(/rangeStart/);
  });

  it('passes through rangeStart/rangeEnd and skips color filter when "any"', async () => {
    const { deps, listEvents } = makeDeps([]);
    await searchCalendar(deps, {
      rangeStart: '2026-05-01T00:00:00Z',
      rangeEnd: '2026-05-31T00:00:00Z',
      color: 'any',
    });
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        timeMin: '2026-05-01T00:00:00Z',
        timeMax: '2026-05-31T00:00:00Z',
      }),
    );
    expect(listEvents.mock.calls[0][0].colorIds).toBeUndefined();
  });

  it('maps color="job" to colorId 10', async () => {
    const { deps, listEvents } = makeDeps([]);
    await searchCalendar(deps, {
      rangeStart: 'a',
      rangeEnd: 'b',
      color: 'job',
    });
    expect(listEvents.mock.calls[0][0].colorIds).toEqual(['10']);
  });

  it('maps color="assessment" to colorId 3', async () => {
    const { deps, listEvents } = makeDeps([]);
    await searchCalendar(deps, {
      rangeStart: 'a',
      rangeEnd: 'b',
      color: 'assessment',
    });
    expect(listEvents.mock.calls[0][0].colorIds).toEqual(['3']);
  });

  it('maps color="callback" to colorId 5', async () => {
    const { deps, listEvents } = makeDeps([]);
    await searchCalendar(deps, {
      rangeStart: 'a',
      rangeEnd: 'b',
      color: 'callback',
    });
    expect(listEvents.mock.calls[0][0].colorIds).toEqual(['5']);
  });

  it('filters by location keyword case-insensitively', async () => {
    const { deps } = makeDeps([
      makeEvent({ id: 'a', location: 'Cambridge MA' }),
      makeEvent({ id: 'b', location: 'Somerville MA' }),
      makeEvent({ id: 'c', location: undefined }),
    ]);
    const result = await searchCalendar(deps, {
      rangeStart: 'a',
      rangeEnd: 'b',
      locationKeyword: 'cambridge',
    });
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('parses [deal:N] marker into dealId on each summary', async () => {
    const { deps } = makeDeps([
      makeEvent({ id: 'a', description: 'job notes [deal:42]' }),
      makeEvent({ id: 'b', description: 'no marker' }),
    ]);
    const result = await searchCalendar(deps, {
      rangeStart: 'a',
      rangeEnd: 'b',
    });
    expect(result[0].dealId).toBe(42);
    expect(result[1].dealId).toBeNull();
  });
});
