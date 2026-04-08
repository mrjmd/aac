export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { contentIdeas, contentPosts, platformVariants } from "@/db/schema";
import { desc, inArray } from "drizzle-orm";
import { IdeaReview } from "./idea-review";
import { GenerateButton } from "./generate-button";
import { findNextSlot } from "@/lib/scheduling-cadence";
import type { platformVariants as pvType, contentPosts as cpType } from "@/db/schema";

type Variant = typeof pvType.$inferSelect;
type Post = typeof cpType.$inferSelect;

export default async function ReviewPage() {
  let ideas: (typeof contentIdeas.$inferSelect)[] = [];
  let variantsByPostId: Record<number, Variant[]> = {};
  let postsById: Record<number, Post> = {};
  let nextSlotIso: string | null = null;
  let dbError = false;

  try {
    ideas = await db
      .select()
      .from(contentIdeas)
      .orderBy(desc(contentIdeas.createdAt))
      .limit(50);

    // Fetch variants and posts for any ideas that have linked posts
    const postIds = ideas
      .filter((i) => i.postId)
      .map((i) => i.postId as number);

    if (postIds.length > 0) {
      const [variants, posts] = await Promise.all([
        db.select().from(platformVariants).where(inArray(platformVariants.postId, postIds)),
        db.select().from(contentPosts).where(inArray(contentPosts.id, postIds)),
      ]);

      for (const v of variants) {
        if (!variantsByPostId[v.postId]) variantsByPostId[v.postId] = [];
        variantsByPostId[v.postId].push(v);
      }
      for (const p of posts) {
        postsById[p.id] = p;
      }
    }

    // Compute next auto-schedule slot once for the whole page
    try {
      const slot = await findNextSlot();
      nextSlotIso = slot.toISOString();
    } catch (e) {
      console.error("findNextSlot failed:", e);
    }
  } catch {
    dbError = true;
  }

  const drafts = ideas.filter((i) => i.status === "draft" || i.status === "revising");
  const inReview = ideas.filter((i) => i.status === "approved" && i.postId);
  const approved = ideas.filter((i) => i.status === "approved" && !i.postId);
  const rejected = ideas.filter((i) => i.status === "rejected");

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-aac-dark">
            Review
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Review, revise, or reject generated content ideas.
          </p>
        </div>
        <GenerateButton />
      </div>

      {dbError && (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          Database not yet initialized. Run{" "}
          <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs">
            pnpm --filter @aac/marketing db:generate && pnpm --filter
            @aac/marketing db:migrate
          </code>{" "}
          to set up the schema.
        </div>
      )}

      {!dbError && ideas.length === 0 && (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium text-zinc-400">No ideas yet</p>
          <p className="mt-1 text-sm text-zinc-400">
            Click &ldquo;Generate Ideas&rdquo; to get started.
          </p>
        </div>
      )}

      {drafts.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Needs Review ({drafts.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((idea) => (
              <IdeaReview key={idea.id} idea={idea} />
            ))}
          </div>
        </section>
      )}

      {inReview.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-aac-blue">
            Visual Review ({inReview.length})
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {inReview.map((idea) => (
              <IdeaReview
                key={idea.id}
                idea={idea}
                variants={idea.postId ? variantsByPostId[idea.postId] : undefined}
                post={idea.postId ? postsById[idea.postId] : undefined}
                nextSlotIso={nextSlotIso}
              />
            ))}
          </div>
        </section>
      )}

      {approved.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-emerald-500">
            Approved — Generating ({approved.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {approved.map((idea) => (
              <IdeaReview key={idea.id} idea={idea} />
            ))}
          </div>
        </section>
      )}

      {rejected.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-300">
            Rejected ({rejected.length})
          </h2>
          <div className="grid gap-4 opacity-60 sm:grid-cols-2 lg:grid-cols-3">
            {rejected.map((idea) => (
              <IdeaReview key={idea.id} idea={idea} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
