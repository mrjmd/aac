export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { contentPosts, platformVariants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PostDetail } from "./post-detail";
import { findNextSlot } from "@/lib/scheduling-cadence";
import { arePostVariantsFullyApproved } from "@/lib/post-status";

export default async function PostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const postId = Number(id);

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, postId))
    .limit(1);

  if (!post) notFound();

  const variants = await db
    .select()
    .from(platformVariants)
    .where(eq(platformVariants.postId, postId));

  // Compute the next auto-schedule slot only when the Schedule section will show
  let nextSlotIso: string | null = null;
  if (post.status === "review" && arePostVariantsFullyApproved(variants)) {
    try {
      const slot = await findNextSlot();
      nextSlotIso = slot.toISOString();
    } catch (e) {
      console.error("findNextSlot failed:", e);
    }
  }

  return <PostDetail post={post} variants={variants} nextSlotIso={nextSlotIso} />;
}
