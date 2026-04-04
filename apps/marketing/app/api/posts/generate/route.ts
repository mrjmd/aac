import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { getGeminiClient } from "@/lib/gemini";
import { db } from "@/lib/db";
import { contentIdeas, contentPosts, platformVariants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildCaptionPrompt } from "@/lib/caption-prompts";
import { uploadImage } from "@/lib/storage";

const PLATFORM_ASPECT_RATIOS: Record<string, string> = {
  instagram: "3:4",
  facebook: "1:1",
  linkedin: "1:1",
  gbp: "4:3",
};

export async function POST(request: NextRequest) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { ideaId: number };

    // Fetch the approved idea
    const [idea] = await db
      .select()
      .from(contentIdeas)
      .where(eq(contentIdeas.id, body.ideaId))
      .limit(1);

    if (!idea) {
      return NextResponse.json({ error: "Idea not found" }, { status: 404 });
    }
    if (idea.status !== "approved") {
      return NextResponse.json(
        { error: "Idea must be approved before generating a post" },
        { status: 400 },
      );
    }

    const meta = safeParseDescription(idea.description);
    const platforms = meta.suggestedPlatforms.length
      ? meta.suggestedPlatforms
      : ["instagram", "facebook", "linkedin"];

    // Create the post
    const [post] = await db
      .insert(contentPosts)
      .values({
        concept: idea.title,
        type: idea.pillar ?? "educational",
        sourceType: meta.sourceType ?? "ai-full",
        templateId: meta.suggestedTemplate || null,
        visualPrompt: meta.visualApproach || null,
        status: "generating",
        ideaId: idea.id,
      })
      .returning();

    // Link idea to post — stays "approved" until post is fully approved
    await db
      .update(contentIdeas)
      .set({ postId: post.id, updatedAt: new Date().toISOString() })
      .where(eq(contentIdeas.id, idea.id));

    // Generate AI image (only for ai-full posts)
    let imageUrl: string | null = null;

    if (meta.sourceType !== "ai-caption-only") {
      const gemini = getGeminiClient();
      const imagePrompt = buildImagePrompt(meta.visualApproach, idea.pillar ?? "");

      try {
        const [image] = await gemini.generateImage(imagePrompt, {
          aspectRatio: "3:4", // default to Instagram portrait
          mimeType: "image/png",
        });

        const buffer = Buffer.from(image.base64, "base64");
        imageUrl = await uploadImage(
          buffer,
          `posts/${post.id}/base-${Date.now()}.png`,
        );
      } catch (imgErr) {
        console.error("Image generation failed:", imgErr);
        // Continue without image — user can regenerate later
      }
    }

    // Generate captions per platform + create variants
    const gemini = getGeminiClient();
    const variants = [];

    for (const platform of platforms) {
      const { systemPrompt, userPrompt } = buildCaptionPrompt({
        concept: idea.title + " — " + meta.text,
        pillar: idea.pillar ?? "educational",
        platform,
        visualApproach: meta.visualApproach,
      });

      let caption = "";
      try {
        caption = await gemini.generateContent(userPrompt, {
          systemPrompt,
          temperature: 0.7,
          maxOutputTokens: 1024,
        });
      } catch (capErr) {
        console.error(`Caption generation failed for ${platform}:`, capErr);
        caption = `[Caption generation failed — edit manually]`;
      }

      const [variant] = await db
        .insert(platformVariants)
        .values({
          postId: post.id,
          platform,
          caption: caption.trim(),
          captionStatus: caption.includes("[Caption generation failed")
            ? "pending"
            : "generated",
          imageUrl,
          imageStatus: imageUrl ? "generated" : "pending",
          aspectRatio: PLATFORM_ASPECT_RATIOS[platform] ?? "1:1",
        })
        .returning();

      variants.push(variant);
    }

    // Update post status to review
    await db
      .update(contentPosts)
      .set({ status: "review", updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, post.id));

    return NextResponse.json({ post, variants });
  } catch (e) {
    console.error("Post generation error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function buildImagePrompt(visualApproach: string, pillar: string): string {
  const base = visualApproach || `Professional photo related to ${pillar} content for a foundation repair company`;
  return `${base}. Photorealistic, professional photography, editorial quality. New England setting. Natural lighting. No text, no watermarks, no labels, no annotations, no words, no writing of any kind in the image.`;
}

function safeParseDescription(desc: string | null): {
  text: string;
  sourceType: string;
  suggestedPlatforms: string[];
  suggestedTemplate: string;
  visualApproach: string;
} {
  const defaults = {
    text: "",
    sourceType: "ai-full",
    suggestedPlatforms: [] as string[],
    suggestedTemplate: "",
    visualApproach: "",
  };
  if (!desc) return defaults;
  try {
    return { ...defaults, ...(JSON.parse(desc) as Record<string, unknown>) } as typeof defaults;
  } catch {
    return { ...defaults, text: desc };
  }
}
