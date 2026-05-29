import { describe, it, expect, vi } from 'vitest';
import { searchConversation } from '../src/search-conversation.js';
import type { ToolDeps } from '../src/types.js';

function msg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm',
    to: ['+16176681677'],
    from: '+16175551111',
    text: 'hello',
    phoneNumberId: 'pn-1',
    direction: 'incoming' as const,
    status: 'delivered' as const,
    createdAt: '2026-05-20T12:00:00Z',
    updatedAt: '2026-05-20T12:00:00Z',
    ...overrides,
  };
}

function makeDeps(overrides: {
  getPerson?: ReturnType<typeof vi.fn>;
  listMessages?: ReturnType<typeof vi.fn>;
} = {}): ToolDeps {
  return {
    pd: {
      getPerson: overrides.getPerson ?? vi.fn().mockResolvedValue(null),
    } as never,
    qb: {} as never,
    quo: {
      listMessages: overrides.listMessages ?? vi.fn().mockResolvedValue({ data: [] }),
    } as never,
    cal: {} as never,
  };
}

describe('searchConversation', () => {
  it('throws when neither personId nor phone is provided', async () => {
    const deps = makeDeps();
    await expect(searchConversation(deps, {})).rejects.toThrow(/personId or phone/);
  });

  it('returns empty when personId resolves to no person', async () => {
    const deps = makeDeps({ getPerson: vi.fn().mockResolvedValue(null) });
    const result = await searchConversation(deps, { personId: 999 });
    expect(result).toEqual([]);
  });

  it('uses primary phone from PD person when phone arg is absent', async () => {
    const listMessages = vi.fn().mockResolvedValue({ data: [] });
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue({
        id: 42,
        name: 'Jane',
        phone: [
          { value: '+15555555555', primary: false },
          { value: '+16175551111', primary: true },
        ],
        email: [],
      }),
      listMessages,
    });

    await searchConversation(deps, { personId: 42 });

    expect(listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ participantE164: '+16175551111' }),
    );
  });

  it('falls back to first phone when none is primary', async () => {
    const listMessages = vi.fn().mockResolvedValue({ data: [] });
    const deps = makeDeps({
      getPerson: vi.fn().mockResolvedValue({
        id: 42,
        name: 'Jane',
        phone: [{ value: '+15555555555', primary: false }],
        email: [],
      }),
      listMessages,
    });

    await searchConversation(deps, { personId: 42 });

    expect(listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ participantE164: '+15555555555' }),
    );
  });

  it('returns most recent N messages when no query is given', async () => {
    const deps = makeDeps({
      listMessages: vi.fn().mockResolvedValue({
        data: [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })],
      }),
    });
    const result = await searchConversation(deps, { phone: '+16175551111', limit: 2 });
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('filters by case-insensitive substring query', async () => {
    const deps = makeDeps({
      listMessages: vi.fn().mockResolvedValue({
        data: [
          msg({ id: 'a', text: 'Confirmed for Friday' }),
          msg({ id: 'b', text: 'See you then' }),
          msg({ id: 'c', text: 'fine, FRIDAY works' }),
        ],
      }),
    });

    const result = await searchConversation(deps, {
      phone: '+16175551111',
      query: 'friday',
    });

    expect(result.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('asks Quo for a wider window when filtering by query', async () => {
    const listMessages = vi.fn().mockResolvedValue({ data: [] });
    const deps = makeDeps({ listMessages });

    await searchConversation(deps, {
      phone: '+16175551111',
      query: 'x',
      limit: 10,
    });

    const maxResults = listMessages.mock.calls[0][0].maxResults;
    expect(maxResults).toBeGreaterThanOrEqual(40);
  });
});
