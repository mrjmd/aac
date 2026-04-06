/**
 * Social posts source — reads scheduled posts from the local DB.
 * Currently empty (scheduling not yet built), but ready for when it lands.
 */
import { db } from "@/lib/db";
import { contentPosts, platformVariants } from "@/db/schema";
import { and, gte, lte, isNotNull, inArray } from "drizzle-orm";
import type { CalendarEvent, CalendarSourceResult, CalendarStatus } from "./types";

export async function fetchSocialEvents(
  start: Date,
  end: Date,
): Promise<CalendarSourceResult> {
  try {
    const posts = await db
      .select()
      .from(contentPosts)
      .where(
        and(
          isNotNull(contentPosts.scheduledAt),
          gte(contentPosts.scheduledAt, start.toISOString()),
          lte(contentPosts.scheduledAt, end.toISOString()),
        ),
      );

    if (posts.length === 0) return { events: [] };

    // Fetch variants for image previews
    const postIds = posts.map((p) => p.id);
    const variants = await db
      .select()
      .from(platformVariants)
      .where(inArray(platformVariants.postId, postIds));

    const variantsByPostId = new Map<number, typeof variants>();
    for (const v of variants) {
      const list = variantsByPostId.get(v.postId) ?? [];
      list.push(v);
      variantsByPostId.set(v.postId, list);
    }

    const events: CalendarEvent[] = posts.map((post) => {
      const postVariants = variantsByPostId.get(post.id) ?? [];
      const previewImage = postVariants.find((v) => v.imageUrl)?.imageUrl;

      return {
        id: `social:${post.id}`,
        source: "social",
        date: post.scheduledAt!,
        title: post.concept,
        excerpt: post.type ? `${post.type} post` : undefined,
        imageUrl: previewImage ?? undefined,
        url: `/post/${post.id}`,
        status: mapPostStatus(post.status),
        meta: {
          postId: post.id,
          type: post.type,
          variantCount: postVariants.length,
        },
      };
    });

    return { events };
  } catch (e) {
    return {
      events: [],
      error: `Social posts: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function mapPostStatus(status: string): CalendarStatus {
  switch (status) {
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
    case "failed":
      return "failed";
    default:
      return "draft";
  }
}
