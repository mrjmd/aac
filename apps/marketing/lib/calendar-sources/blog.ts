/**
 * Blog source — fetches the static JSON feed published by aac-astro at build time.
 *
 * Endpoint: ${BLOG_SOURCE_URL}/api/blog.json (defaults to production website)
 * Refreshes on every aac-astro deploy. Cached client-side for 10 minutes.
 *
 * When aac-astro moves into apps/website/ in the monorepo, only the env var changes.
 */
import type { CalendarEvent, CalendarSourceResult } from "./types";

const BLOG_SOURCE_URL =
  process.env.BLOG_SOURCE_URL ?? "https://www.attackacrack.com";

interface BlogPostFeedItem {
  slug: string;
  title: string;
  excerpt: string;
  publishDate: string;
  heroImage: string | null;
  category: string;
  draft: boolean;
  url: string;
}

export async function fetchBlogEvents(
  start: Date,
  end: Date,
): Promise<CalendarSourceResult> {
  try {
    const res = await fetch(`${BLOG_SOURCE_URL}/api/blog.json`, {
      // Next.js-specific cache: refresh every 10 minutes
      next: { revalidate: 600 },
    });

    if (!res.ok) {
      return {
        events: [],
        error: `Blog source returned ${res.status}`,
      };
    }

    const posts = (await res.json()) as BlogPostFeedItem[];

    const startMs = start.getTime();
    const endMs = end.getTime();

    const events: CalendarEvent[] = [];
    for (const post of posts) {
      const ts = new Date(post.publishDate).getTime();
      if (ts < startMs || ts > endMs) continue;

      // Drafted posts are queued for the auto-publish cron — show as scheduled.
      // Past-dated non-draft posts are live.
      const status = post.draft ? "scheduled" : "published";

      events.push({
        id: `blog:${post.slug}`,
        source: "blog",
        date: post.publishDate,
        title: post.title,
        excerpt: post.excerpt,
        imageUrl: post.heroImage
          ? absolutize(post.heroImage, BLOG_SOURCE_URL)
          : undefined,
        url: post.draft ? undefined : post.url, // no public URL until live
        status,
        meta: {
          slug: post.slug,
          category: post.category,
          draft: post.draft,
        },
      });
    }

    return { events };
  } catch (e) {
    return {
      events: [],
      error: `Blog: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function absolutize(path: string, base: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
