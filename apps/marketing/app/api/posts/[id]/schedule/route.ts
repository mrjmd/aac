/**
 * Schedule a post for publishing via Buffer.
 *
 * Modes:
 * - auto: pick the next open cadence slot via findNextSlot()
 * - manual: caller provides a specific scheduledAt ISO string
 * - retry: re-attempt only the failed variants on an already-scheduled post
 *
 * Best-effort semantics: each variant is scheduled independently. If some
 * fail and some succeed, the post moves to "scheduled" status and the
 * failed variants stay marked "failed" with an error message — the user
 * can retry them individually.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/auth";
import { db } from "@/lib/db";
import { contentPosts, platformVariants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { findNextSlot } from "@/lib/scheduling-cadence";
import { arePostVariantsFullyApproved } from "@/lib/post-status";
import { findChannelForPlatform } from "@/lib/buffer";
import { BufferClient } from "@aac/api-clients";
import type { BufferChannel } from "@aac/api-clients";
import type { CreatePostOptions } from "@aac/api-clients";

type Params = { params: Promise<{ id: string }> };

type ScheduleBody =
  | { mode: "auto" }
  | { mode: "manual"; scheduledAt: string }
  | { mode: "retry" };

interface VariantResult {
  variantId: number;
  platform: string;
  ok: boolean;
  bufferPostId?: string;
  error?: string;
}

export async function POST(request: NextRequest, { params }: Params) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const postId = Number(id);
  const body = (await request.json()) as ScheduleBody;

  // Load post + variants
  const [post] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, postId))
    .limit(1);

  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const variants = await db
    .select()
    .from(platformVariants)
    .where(eq(platformVariants.postId, postId));

  // Validate state for the requested mode
  if (body.mode === "retry") {
    if (post.status !== "scheduled") {
      return NextResponse.json(
        { error: "Retry only valid on already-scheduled posts" },
        { status: 400 },
      );
    }
  } else {
    if (!arePostVariantsFullyApproved(variants)) {
      return NextResponse.json(
        { error: "All variants must have approved caption + image before scheduling" },
        { status: 400 },
      );
    }
    if (post.status !== "review") {
      return NextResponse.json(
        { error: `Post is in '${post.status}' status, expected 'review'` },
        { status: 400 },
      );
    }
  }

  // Resolve target slot
  let scheduledAt: Date;
  if (body.mode === "manual") {
    scheduledAt = new Date(body.scheduledAt);
    if (isNaN(scheduledAt.getTime())) {
      return NextResponse.json({ error: "Invalid scheduledAt" }, { status: 400 });
    }
  } else if (body.mode === "auto") {
    scheduledAt = await findNextSlot();
  } else {
    // retry: keep the existing scheduledAt
    if (!post.scheduledAt) {
      return NextResponse.json(
        { error: "Post has no scheduledAt to retry against" },
        { status: 400 },
      );
    }
    scheduledAt = new Date(post.scheduledAt);
  }

  // Get a Buffer client up front (will throw if BUFFER_ACCESS_TOKEN missing)
  const accessToken = process.env.BUFFER_ACCESS_TOKEN;
  if (!accessToken) {
    return NextResponse.json(
      { error: "BUFFER_ACCESS_TOKEN not set" },
      { status: 500 },
    );
  }
  // We need an org-configured client for createPost to work; the existing
  // getBufferClient() helper handles bootstrap + caching.
  const { getBufferClient } = await import("@/lib/buffer");
  const client = await getBufferClient();

  // Determine which variants to schedule
  const targets =
    body.mode === "retry"
      ? variants.filter((v) => v.publishStatus === "failed")
      : variants;

  // Schedule each variant best-effort, in sequence (BufferClient throttles to 200ms)
  const results: VariantResult[] = [];
  for (const variant of targets) {
    const result = await scheduleVariant(client, variant, scheduledAt, post);
    results.push(result);

    // Persist per-variant outcome
    if (result.ok) {
      await db
        .update(platformVariants)
        .set({
          bufferPostId: result.bufferPostId ?? null,
          publishStatus: "scheduled",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(platformVariants.id, variant.id));
    } else {
      await db
        .update(platformVariants)
        .set({
          publishStatus: "failed",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(platformVariants.id, variant.id));
    }
  }

  // Update post status if at least one variant succeeded
  const anySuccess = results.some((r) => r.ok);
  if (anySuccess && body.mode !== "retry") {
    await db
      .update(contentPosts)
      .set({
        status: "scheduled",
        scheduledAt: scheduledAt.toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contentPosts.id, postId));
  }

  revalidatePath(`/post/${postId}`);
  revalidatePath("/calendar");
  revalidatePath("/review");

  return NextResponse.json({
    scheduledAt: scheduledAt.toISOString(),
    results,
    anySuccess,
  });
}

async function scheduleVariant(
  client: BufferClient,
  variant: typeof platformVariants.$inferSelect,
  scheduledAt: Date,
  post: typeof contentPosts.$inferSelect,
): Promise<VariantResult> {
  const base: VariantResult = {
    variantId: variant.id,
    platform: variant.platform,
    ok: false,
  };

  if (!variant.imageUrl) {
    return { ...base, error: "Variant has no imageUrl" };
  }
  if (!variant.imageUrl.startsWith("http")) {
    return {
      ...base,
      error: "Image URL not public — Vercel Blob (BLOB_READ_WRITE_TOKEN) required",
    };
  }
  if (!variant.caption) {
    return { ...base, error: "Variant has no caption" };
  }

  let channel: BufferChannel | null;
  try {
    channel = await findChannelForPlatform(variant.platform);
  } catch (e) {
    return {
      ...base,
      error: `Buffer channel lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!channel) {
    return {
      ...base,
      error: `Buffer channel not connected for ${variant.platform}`,
    };
  }

  // Build options. GBP needs gbpMetadata; everything else just needs basic fields.
  const options: CreatePostOptions = {
    imageUrl: variant.imageUrl,
    dueAt: scheduledAt.toISOString(),
  };

  if (variant.platform === "gbp") {
    options.gbpMetadata = {
      type: "whats_new",
      button: "learn_more",
      link: "https://www.attackacrack.com",
    };
  } else if (variant.platform === "instagram") {
    // Buffer requires Instagram posts to specify a type
    options.instagramMetadata = { type: "post" };
  }

  try {
    const created = await client.createPost(channel.id, variant.caption, options);
    return { ...base, ok: true, bufferPostId: created.id };
  } catch (e) {
    return {
      ...base,
      error: `Buffer createPost failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
