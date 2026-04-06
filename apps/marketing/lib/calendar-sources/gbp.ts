/**
 * GBP/Buffer source — fetches scheduled posts from all connected Buffer channels.
 *
 * Today this is just GBP (Matt's free Buffer only has GBP connected), but as
 * he connects IG/FB/LI later they'll appear automatically with no code change.
 */
import { getBufferClient, getBufferChannels, platformLabelForService } from "@/lib/buffer";
import type { CalendarEvent, CalendarSourceResult } from "./types";

export async function fetchGbpEvents(
  start: Date,
  end: Date,
): Promise<CalendarSourceResult> {
  try {
    const channels = await getBufferChannels();
    if (channels.length === 0) return { events: [] };

    const client = await getBufferClient();

    // Fetch scheduled posts from every connected channel in parallel
    const perChannel = await Promise.all(
      channels.map(async (channel) => {
        try {
          const posts = await client.getScheduledPosts(channel.id);
          return posts.map((post) => ({ post, channel }));
        } catch (e) {
          console.error(`Buffer: failed to fetch posts for channel ${channel.name}:`, e);
          return [];
        }
      }),
    );

    const startMs = start.getTime();
    const endMs = end.getTime();

    const events: CalendarEvent[] = [];
    for (const channelPosts of perChannel) {
      for (const { post, channel } of channelPosts) {
        if (!post.dueAt) continue;
        const dueMs = new Date(post.dueAt).getTime();
        if (dueMs < startMs || dueMs > endMs) continue;

        events.push({
          id: `gbp:${post.id}`,
          source: "gbp",
          date: post.dueAt,
          title: deriveTitle(post.text),
          excerpt: post.text.length > 120 ? post.text.slice(0, 120) + "…" : post.text,
          status: "scheduled",
          meta: {
            bufferPostId: post.id,
            channelId: channel.id,
            channelName: channel.displayName || channel.name,
            service: channel.service,
            serviceLabel: platformLabelForService(channel.service),
            fullText: post.text,
          },
        });
      }
    }

    return { events };
  } catch (e) {
    return {
      events: [],
      error: `GBP/Buffer: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Use the first line (or first ~60 chars) of the post text as a title. */
function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57) + "…";
}
