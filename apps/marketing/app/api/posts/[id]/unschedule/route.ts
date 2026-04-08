/**
 * Unschedule a post: delete each variant's Buffer post and revert state.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/auth";
import { db } from "@/lib/db";
import { contentPosts, platformVariants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getBufferClient } from "@/lib/buffer";

type Params = { params: Promise<{ id: string }> };

interface VariantResult {
  variantId: number;
  platform: string;
  ok: boolean;
  error?: string;
}

export async function POST(request: NextRequest, { params }: Params) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const postId = Number(id);

  const [post] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, postId))
    .limit(1);

  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  if (post.status !== "scheduled") {
    return NextResponse.json(
      { error: `Post is in '${post.status}' status, expected 'scheduled'` },
      { status: 400 },
    );
  }

  const variants = await db
    .select()
    .from(platformVariants)
    .where(eq(platformVariants.postId, postId));

  // Delete from Buffer for any variant that has a bufferPostId
  const results: VariantResult[] = [];
  let client;
  try {
    client = await getBufferClient();
  } catch (e) {
    return NextResponse.json(
      { error: `Buffer client init failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  for (const variant of variants) {
    if (!variant.bufferPostId) {
      results.push({ variantId: variant.id, platform: variant.platform, ok: true });
      continue;
    }
    try {
      await client.deletePost(variant.bufferPostId);
      results.push({ variantId: variant.id, platform: variant.platform, ok: true });
    } catch (e) {
      results.push({
        variantId: variant.id,
        platform: variant.platform,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      // Continue — we still want to clear local state even if Buffer fails
    }

    // Clear local state regardless of Buffer outcome (best-effort cleanup)
    await db
      .update(platformVariants)
      .set({
        bufferPostId: null,
        publishStatus: "draft",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(platformVariants.id, variant.id));
  }

  // Revert post status
  await db
    .update(contentPosts)
    .set({
      status: "review",
      scheduledAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(contentPosts.id, postId));

  revalidatePath(`/post/${postId}`);
  revalidatePath("/calendar");
  revalidatePath("/review");

  return NextResponse.json({ results });
}
