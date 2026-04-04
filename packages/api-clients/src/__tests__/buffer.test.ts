import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BufferClient } from '../buffer.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeClient(orgId?: string) {
  return new BufferClient({
    accessToken: 'test-token',
    organizationId: orgId,
  });
}

function mockGraphQL(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['x-ratelimit-remaining', '50']]),
    json: () => Promise.resolve({ data }),
    text: () => Promise.resolve(JSON.stringify({ data })),
  });
}

function mockGraphQLError(errors: Array<{ message: string }>) {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: new Map([['x-ratelimit-remaining', '50']]),
    json: () => Promise.resolve({ data: null, errors }),
    text: () => Promise.resolve(JSON.stringify({ data: null, errors })),
  });
}

function mockHTTPError(status: number, body: string) {
  return Promise.resolve({
    ok: false,
    status,
    headers: new Map(),
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

function getLastRequestBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return JSON.parse(call[1].body as string);
}

function getLastRequestHeaders(): Record<string, string> {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return call[1].headers;
}

describe('BufferClient', () => {
  describe('authentication', () => {
    it('sends bearer token in Authorization header', async () => {
      const client = makeClient('org-1');
      mockFetch.mockReturnValueOnce(
        mockGraphQL({ account: { organizations: [] } })
      );

      await client.getOrganizations();
      const headers = getLastRequestHeaders();
      expect(headers.Authorization).toBe('Bearer test-token');
    });

    it('sends requests to the GraphQL endpoint', async () => {
      const client = makeClient('org-1');
      mockFetch.mockReturnValueOnce(
        mockGraphQL({ account: { organizations: [] } })
      );

      await client.getOrganizations();
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.buffer.com');
    });
  });

  describe('getOrganizations', () => {
    it('returns organizations for the account', async () => {
      const client = makeClient();
      const orgs = [
        { id: 'org-1', name: 'My Org', ownerEmail: 'test@example.com' },
      ];
      mockFetch.mockReturnValueOnce(
        mockGraphQL({ account: { organizations: orgs } })
      );

      const result = await client.getOrganizations();
      expect(result).toEqual(orgs);
    });
  });

  describe('getChannels', () => {
    it('returns channels for an organization', async () => {
      const client = makeClient('org-1');
      const channels = [
        {
          id: 'ch-1',
          name: 'Instagram',
          displayName: '@mypage',
          service: 'instagram',
          avatar: null,
          isQueuePaused: false,
        },
      ];
      mockFetch.mockReturnValueOnce(mockGraphQL({ channels }));

      const result = await client.getChannels();
      expect(result).toEqual(channels);

      const body = getLastRequestBody();
      expect(body.variables).toEqual({ orgId: 'org-1' });
    });

    it('uses explicit orgId over config', async () => {
      const client = makeClient('org-1');
      mockFetch.mockReturnValueOnce(mockGraphQL({ channels: [] }));

      await client.getChannels('org-override');
      const body = getLastRequestBody();
      expect(body.variables).toEqual({ orgId: 'org-override' });
    });

    it('throws if no organizationId available', async () => {
      const client = makeClient();
      await expect(client.getChannels()).rejects.toThrow('organizationId required');
    });
  });

  describe('getScheduledPosts', () => {
    it('returns scheduled posts for a channel', async () => {
      const client = makeClient('org-1');
      const posts = [
        { id: 'post-1', text: 'Hello world', dueAt: '2026-04-10T09:00:00Z', status: 'scheduled' },
      ];
      mockFetch.mockReturnValueOnce(
        mockGraphQL({ posts: { edges: posts.map((p) => ({ node: p })) } })
      );

      const result = await client.getScheduledPosts('ch-1');
      expect(result).toEqual(posts);
    });

    it('returns empty array when no posts', async () => {
      const client = makeClient('org-1');
      mockFetch.mockReturnValueOnce(mockGraphQL({ posts: null }));

      const result = await client.getScheduledPosts('ch-1');
      expect(result).toEqual([]);
    });

    it('throws if no organizationId in config', async () => {
      const client = makeClient();
      await expect(client.getScheduledPosts('ch-1')).rejects.toThrow(
        'organizationId required'
      );
    });
  });

  describe('createPost', () => {
    it('creates a basic text post', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-1', text: 'Hello world' } },
        })
      );

      const result = await client.createPost('ch-1', 'Hello world');
      expect(result).toEqual({ id: 'post-1', text: 'Hello world' });

      const body = getLastRequestBody();
      expect(body.variables).toMatchObject({
        text: 'Hello world',
        channelId: 'ch-1',
      });
    });

    it('creates a post with image', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-2', text: 'With image' } },
        })
      );

      await client.createPost('ch-1', 'With image', {
        imageUrl: 'https://example.com/photo.jpg',
      });

      const body = getLastRequestBody();
      expect(body.variables).toMatchObject({
        imageUrl: 'https://example.com/photo.jpg',
      });
      expect(body.query).toContain('assets');
    });

    it('creates a scheduled post with dueAt', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-3', text: 'Scheduled' } },
        })
      );

      await client.createPost('ch-1', 'Scheduled', {
        dueAt: '2026-04-10T09:00:00Z',
      });

      const body = getLastRequestBody();
      expect(body.variables).toMatchObject({
        dueAt: '2026-04-10T09:00:00Z',
      });
      expect(body.query).toContain('dueAt');
    });

    it('creates a GBP post with whats_new metadata', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-4', text: 'GBP post' } },
        })
      );

      await client.createPost('ch-gbp', 'GBP post', {
        gbpMetadata: {
          type: 'whats_new',
          button: 'learn_more',
          link: 'https://attackacrack.com',
        },
      });

      const body = getLastRequestBody();
      expect(body.query).toContain('whats_new');
      expect(body.query).toContain('learn_more');
      expect(body.variables).toMatchObject({
        linkUrl: 'https://attackacrack.com',
      });
    });

    it('creates a GBP post with event metadata', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-5', text: 'Event post' } },
        })
      );

      await client.createPost('ch-gbp', 'Event post', {
        gbpMetadata: { type: 'event', button: 'book' },
      });

      const body = getLastRequestBody();
      expect(body.query).toContain('type: event');
      expect(body.query).toContain('book');
    });

    it('defaults to customScheduled mode', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-6', text: 'Default mode' } },
        })
      );

      await client.createPost('ch-1', 'Default mode');

      const body = getLastRequestBody();
      expect(body.query).toContain('customScheduled');
    });

    it('supports addToQueue mode', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { post: { id: 'post-7', text: 'Queued' } },
        })
      );

      await client.createPost('ch-1', 'Queued', { mode: 'addToQueue' });

      const body = getLastRequestBody();
      expect(body.query).toContain('addToQueue');
    });

    it('throws on mutation error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createPost: { message: 'Channel not found' },
        })
      );

      await expect(
        client.createPost('ch-bad', 'Will fail')
      ).rejects.toThrow('Buffer post creation failed: Channel not found');
    });
  });

  describe('deletePost', () => {
    it('deletes a post', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          deletePost: { post: { id: 'post-1' } },
        })
      );

      await expect(client.deletePost('post-1')).resolves.toBeUndefined();
    });

    it('throws on mutation error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          deletePost: { message: 'Post not found' },
        })
      );

      await expect(client.deletePost('post-bad')).rejects.toThrow(
        'Buffer post deletion failed: Post not found'
      );
    });
  });

  describe('createIdea', () => {
    it('creates a basic idea', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createIdea: { idea: { id: 'idea-1', content: 'My idea' } },
        })
      );

      const result = await client.createIdea('My idea');
      expect(result).toEqual({ id: 'idea-1', content: 'My idea' });
    });

    it('creates an idea with tags and target date', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createIdea: { idea: { id: 'idea-2', content: 'Tagged idea' } },
        })
      );

      await client.createIdea('Tagged idea', {
        tagIds: ['tag-1'],
        targetDate: '2026-04-15T00:00:00Z',
      });

      const body = getLastRequestBody();
      expect(body.variables).toMatchObject({
        tagIds: ['tag-1'],
        targetDate: '2026-04-15T00:00:00Z',
      });
    });

    it('throws on mutation error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQL({
          createIdea: { message: 'Unauthorized' },
        })
      );

      await expect(client.createIdea('Fail')).rejects.toThrow(
        'Buffer idea creation failed: Unauthorized'
      );
    });
  });

  describe('error handling', () => {
    it('throws on HTTP error', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(mockHTTPError(500, 'Internal Server Error'));

      await expect(client.getOrganizations()).rejects.toThrow(
        'Buffer API request failed (500): Internal Server Error'
      );
    });

    it('throws on GraphQL errors', async () => {
      const client = makeClient();
      mockFetch.mockReturnValueOnce(
        mockGraphQLError([{ message: 'Unauthorized' }])
      );

      await expect(client.getOrganizations()).rejects.toThrow(
        'Buffer GraphQL error: Unauthorized'
      );
    });

    it('retries on 429 with exponential backoff', async () => {
      const client = makeClient();

      // First call: 429, second call: success
      mockFetch
        .mockReturnValueOnce(
          Promise.resolve({
            ok: false,
            status: 429,
            headers: new Map(),
          })
        )
        .mockReturnValueOnce(
          mockGraphQL({ account: { organizations: [] } })
        );

      const result = await client.getOrganizations();
      expect(result).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10000);

    it('throws after max retries on persistent 429', async () => {
      const client = makeClient();

      // All calls return 429
      for (let i = 0; i <= 4; i++) {
        mockFetch.mockReturnValueOnce(
          Promise.resolve({
            ok: false,
            status: 429,
            headers: new Map(),
          })
        );
      }

      await expect(client.getOrganizations()).rejects.toThrow(
        'rate limit exceeded after retries'
      );
    }, 30000);
  });
});
