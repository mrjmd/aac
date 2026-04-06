/**
 * Buffer integration for the marketing app.
 * Lazy singleton client + cached org/channel discovery.
 *
 * Auth: BUFFER_ACCESS_TOKEN env var.
 * Org and channel IDs are auto-discovered on first use and cached for 10 minutes.
 */
import { BufferClient, type BufferChannel } from "@aac/api-clients";

const CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedState {
  client: BufferClient;
  orgId: string;
  channels: BufferChannel[];
  fetchedAt: number;
}

let _state: CachedState | null = null;
let _bootstrapPromise: Promise<CachedState> | null = null;

/**
 * Get a fully-bootstrapped Buffer client with org + channels cached.
 * Throws if BUFFER_ACCESS_TOKEN is not set.
 */
async function getState(): Promise<CachedState> {
  // Return cache if fresh
  if (_state && Date.now() - _state.fetchedAt < CHANNEL_CACHE_TTL_MS) {
    return _state;
  }

  // Coalesce concurrent bootstrap requests
  if (_bootstrapPromise) return _bootstrapPromise;

  _bootstrapPromise = (async () => {
    const accessToken = process.env.BUFFER_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("BUFFER_ACCESS_TOKEN not set");
    }

    // Step 1: bootstrap client without orgId to fetch organizations
    const bootstrapClient = new BufferClient({ accessToken });
    const orgs = await bootstrapClient.getOrganizations();
    if (orgs.length === 0) {
      throw new Error("No Buffer organizations found for this account");
    }
    const orgId = orgs[0].id;

    // Step 2: real client with orgId for subsequent calls
    const client = new BufferClient({ accessToken, organizationId: orgId });
    const channels = await client.getChannels();

    _state = { client, orgId, channels, fetchedAt: Date.now() };
    _bootstrapPromise = null;
    return _state;
  })();

  return _bootstrapPromise;
}

/** Get all connected Buffer channels (cached). */
export async function getBufferChannels(): Promise<BufferChannel[]> {
  const state = await getState();
  return state.channels;
}

/** Get the Buffer client (org-configured). */
export async function getBufferClient(): Promise<BufferClient> {
  const state = await getState();
  return state.client;
}

/** Map Buffer service names to friendly platform labels for the UI. */
export function platformLabelForService(service: string): string {
  const map: Record<string, string> = {
    googlebusiness: "Google Business",
    instagram: "Instagram",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    twitter: "X / Twitter",
    pinterest: "Pinterest",
    tiktok: "TikTok",
  };
  return map[service] ?? service;
}
