/**
 * Buffer API client — Social media post scheduling via GraphQL.
 *
 * Extracted from aac-astro/scripts/lib/buffer-client.js.
 * Refactored to class pattern with constructor config (no process.env reads).
 *
 * Buffer API: https://developers.buffer.com
 * Endpoint: https://api.buffer.com (GraphQL POST)
 * Auth: Bearer token via API key.
 * Rate limit: 60 req/min per user.
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('buffer');

const API_ENDPOINT = 'https://api.buffer.com';
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;

// ── Interfaces ───────────────────────────────────────────────────────

export interface BufferConfig {
  accessToken: string;
  organizationId?: string;
}

export interface BufferOrganization {
  id: string;
  name: string;
  ownerEmail: string;
}

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string;
  service: string;
  avatar: string | null;
  isQueuePaused: boolean;
}

export interface BufferPost {
  id: string;
  text: string;
  dueAt?: string;
  status?: string;
}

export interface BufferIdea {
  id: string;
  content: string;
}

/** Google Business Profile metadata for GBP posts. */
export interface GbpMetadata {
  type: 'whats_new' | 'event' | 'offer';
  button?: 'learn_more' | 'book' | 'order' | 'shop' | 'sign_up' | 'call';
  link?: string;
}

/** Instagram metadata. Buffer requires a post type and shouldShareToFeed flag. */
export interface InstagramMetadata {
  type: 'post' | 'story' | 'reel';
  /** Whether the post appears in the main feed. Defaults to true. */
  shouldShareToFeed?: boolean;
}

export interface CreatePostOptions {
  imageUrl?: string;
  dueAt?: string;
  linkUrl?: string;
  gbpMetadata?: GbpMetadata;
  instagramMetadata?: InstagramMetadata;
  mode?: 'addToQueue' | 'customScheduled' | 'shareNow' | 'shareNext';
  saveToDraft?: boolean;
}

export interface CreateIdeaOptions {
  tagIds?: string[];
  targetDate?: string;
  mediaUrls?: string[];
}

export interface GetPostsOptions {
  channelIds?: string[];
  status?: string[];
  first?: number;
}

// ── Client ───────────────────────────────────────────────────────────

export class BufferClient {
  private lastRequestTime = 0;

  constructor(private config: BufferConfig) {}

  // ── Private helpers ────────────────────────────────────────────────

  private async rateLimitedFetch(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
    }

    let retries = 0;
    while (retries <= MAX_RETRIES) {
      this.lastRequestTime = Date.now();
      const res = await fetch(url, options);

      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining && parseInt(remaining, 10) < 20) {
        log.warn(`Rate limit: ${remaining} requests remaining`);
      }

      if (res.status === 429) {
        retries++;
        if (retries > MAX_RETRIES) {
          throw new Error('Buffer API rate limit exceeded after retries');
        }
        const backoff = Math.pow(2, retries) * 1000;
        log.warn(`Rate limited — retrying in ${backoff / 1000}s...`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      return res;
    }

    // Unreachable, but satisfies TypeScript
    throw new Error('Buffer API: unexpected retry loop exit');
  }

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const res = await this.rateLimitedFetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Buffer API request failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as {
      data: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(
        `Buffer GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`
      );
    }

    return json.data;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Get all organizations for the authenticated account.
   */
  async getOrganizations(): Promise<BufferOrganization[]> {
    const data = await this.graphql<{
      account: { organizations: BufferOrganization[] };
    }>(`
      query GetOrganizations {
        account {
          organizations {
            id
            name
            ownerEmail
          }
        }
      }
    `);
    return data.account.organizations;
  }

  /**
   * Get all channels for an organization.
   * Uses configured organizationId if no orgId provided.
   */
  async getChannels(orgId?: string): Promise<BufferChannel[]> {
    const organizationId = orgId ?? this.config.organizationId;
    if (!organizationId) {
      throw new Error(
        'BufferClient: organizationId required — pass it to getChannels() or set it in config'
      );
    }

    const data = await this.graphql<{ channels: BufferChannel[] }>(
      `
      query GetChannels($orgId: OrganizationId!) {
        channels(input: { organizationId: $orgId }) {
          id
          name
          displayName
          service
          avatar
          isQueuePaused
        }
      }
    `,
      { orgId: organizationId }
    );
    return data.channels;
  }

  /**
   * Get scheduled posts. Requires organizationId in config or via getOrganizations().
   */
  async getScheduledPosts(
    channelId: string,
    options?: GetPostsOptions
  ): Promise<BufferPost[]> {
    const organizationId = this.config.organizationId;
    if (!organizationId) {
      throw new Error(
        'BufferClient: organizationId required in config for getScheduledPosts()'
      );
    }

    const first = options?.first ?? 100;

    const data = await this.graphql<{
      posts: { edges: Array<{ node: BufferPost }> } | null;
    }>(
      `
      query GetScheduledPosts($input: PostsInput!, $first: Int) {
        posts(input: $input, first: $first) {
          edges {
            node {
              id
              text
              dueAt
              status
            }
          }
        }
      }
    `,
      {
        input: {
          organizationId,
          filter: {
            channelIds: [channelId],
            status: ['scheduled'],
          },
        },
        first,
      }
    );

    return (data.posts?.edges ?? []).map((e) => e.node);
  }

  /**
   * Create/schedule a post on Buffer.
   *
   * GBP metadata is configurable via options.gbpMetadata — supports whats_new,
   * event, and offer post types with configurable CTA buttons.
   */
  async createPost(
    channelId: string,
    text: string,
    options?: CreatePostOptions
  ): Promise<BufferPost> {
    const mode = options?.mode ?? 'customScheduled';
    const variables: Record<string, unknown> = { text, channelId };

    let variableDefs = '$text: String!, $channelId: ChannelId!';
    let inputFields = `
      text: $text,
      channelId: $channelId,
      schedulingType: automatic,
      mode: ${mode}
    `;

    // Build metadata block — supports google (GBP) and/or instagram together
    const metadataParts: string[] = [];

    if (options?.gbpMetadata) {
      const gbp = options.gbpMetadata;
      const button = gbp.button ?? 'learn_more';

      variableDefs += ', $linkUrl: String';
      variables.linkUrl = gbp.link ?? options?.linkUrl ?? null;

      if (gbp.type === 'whats_new') {
        metadataParts.push(`google: {
          type: whats_new,
          detailsWhatsNew: { button: ${button}, link: $linkUrl }
        }`);
      } else if (gbp.type === 'event') {
        metadataParts.push(`google: {
          type: event,
          detailsEvent: { button: ${button}, link: $linkUrl }
        }`);
      } else if (gbp.type === 'offer') {
        metadataParts.push(`google: {
          type: offer,
          detailsOffer: { button: ${button}, link: $linkUrl }
        }`);
      }
    }

    if (options?.instagramMetadata) {
      const ig = options.instagramMetadata;
      const shareToFeed = ig.shouldShareToFeed ?? true;
      metadataParts.push(
        `instagram: { type: ${ig.type}, shouldShareToFeed: ${shareToFeed} }`
      );
    }

    if (metadataParts.length > 0) {
      inputFields += `, metadata: { ${metadataParts.join(', ')} }`;
    }

    if (options?.dueAt) {
      variableDefs += ', $dueAt: DateTime';
      inputFields += ', dueAt: $dueAt';
      variables.dueAt = options.dueAt;
    }

    if (options?.saveToDraft) {
      inputFields += ', saveToDraft: true';
    }

    let assetsBlock = '';
    if (options?.imageUrl) {
      variableDefs += ', $imageUrl: String!';
      assetsBlock = ', assets: { images: [{ url: $imageUrl }] }';
      variables.imageUrl = options.imageUrl;
    }

    const query = `
      mutation CreatePost(${variableDefs}) {
        createPost(input: {
          ${inputFields}
          ${assetsBlock}
        }) {
          ... on PostActionSuccess {
            post {
              id
              text
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `;

    const data = await this.graphql<{
      createPost: { post?: BufferPost; message?: string };
    }>(query, variables);

    if (data.createPost.message) {
      throw new Error(
        `Buffer post creation failed: ${data.createPost.message}`
      );
    }

    return data.createPost.post!;
  }

  /**
   * Delete a scheduled post.
   */
  async deletePost(postId: string): Promise<void> {
    const data = await this.graphql<{
      deletePost: { post?: { id: string }; message?: string };
    }>(
      `
      mutation DeletePost($postId: PostId!) {
        deletePost(input: { postId: $postId }) {
          ... on PostActionSuccess {
            post {
              id
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `,
      { postId }
    );

    if (data.deletePost.message) {
      throw new Error(`Buffer post deletion failed: ${data.deletePost.message}`);
    }
  }

  /**
   * Create an idea (content draft) in Buffer.
   */
  async createIdea(
    text: string,
    options?: CreateIdeaOptions
  ): Promise<BufferIdea> {
    const variables: Record<string, unknown> = { text };

    let variableDefs = '$text: String!';
    let inputFields = 'content: $text';

    if (options?.tagIds?.length) {
      variableDefs += ', $tagIds: [TagId!]';
      inputFields += ', tagIds: $tagIds';
      variables.tagIds = options.tagIds;
    }

    if (options?.targetDate) {
      variableDefs += ', $targetDate: DateTime';
      inputFields += ', targetDate: $targetDate';
      variables.targetDate = options.targetDate;
    }

    if (options?.mediaUrls?.length) {
      const mediaInput = options.mediaUrls.map((url) => `{ url: "${url}" }`).join(', ');
      inputFields += `, media: [${mediaInput}]`;
    }

    const data = await this.graphql<{
      createIdea: { idea?: BufferIdea; message?: string };
    }>(
      `
      mutation CreateIdea(${variableDefs}) {
        createIdea(input: { ${inputFields} }) {
          ... on IdeaActionSuccess {
            idea {
              id
              content
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `,
      variables
    );

    if (data.createIdea.message) {
      throw new Error(`Buffer idea creation failed: ${data.createIdea.message}`);
    }

    return data.createIdea.idea!;
  }
}
