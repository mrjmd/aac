import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { getGeminiClient } from "@/lib/gemini";
import { db } from "@/lib/db";
import { contentIdeas, contentPosts, platformVariants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildCaptionPrompt } from "@/lib/caption-prompts";
import { uploadImage } from "@/lib/storage";
import { renderTemplate, type TemplateData } from "@/lib/templates/renderer";
import { PLATFORM_SIZES, type Platform } from "@/lib/templates/brand";
import { generateWithQualityGate } from "@/lib/image-quality-gate";
import type { ImageAspectRatio } from "@aac/api-clients";

const PLATFORM_ASPECT_RATIOS: Record<string, ImageAspectRatio> = {
  instagram: "3:4",
  facebook: "1:1",
  linkedin: "16:9",
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
    // Always generate for all 3 platforms (GBP is auto-posted separately via Buffer)
    const platforms = ["instagram", "facebook", "linkedin"];

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

    const gemini = getGeminiClient();
    const templateId = meta.suggestedTemplate || "A";
    const templateData = buildTemplateData(templateId, idea.title, meta.text);

    // Generate per-platform: AI background → Satori composite → upload
    const variants = [];

    for (const platform of platforms) {
      const aspectRatio = PLATFORM_ASPECT_RATIOS[platform] ?? "1:1";
      let imageUrl: string | null = null;

      if (meta.sourceType !== "ai-caption-only") {
        try {
          const imagePrompt = buildImagePrompt(meta.visualApproach, idea.pillar ?? "");
          const apiKey = process.env.GEMINI_API_KEY ?? "";

          // Generate AI background with quality gate (auto-retries on text detection)
          const result = await generateWithQualityGate(
            async () => {
              const [img] = await gemini.generateImage(imagePrompt, {
                aspectRatio,
                mimeType: "image/png",
              });
              return img;
            },
            `${idea.pillar} content for foundation repair: ${meta.visualApproach}`,
            apiKey,
            3,
          );

          if (!result.quality.passed) {
            console.warn(
              `Image quality gate: best of ${result.attempts} attempts still has issues: ${result.quality.reason}`,
            );
          }

          const bgDataUrl = `data:image/png;base64,${result.base64}`;

          // Apply branded template overlay via Satori
          const compositePng = await renderTemplate({
            templateId,
            platform: platform as Platform,
            bgDataUrl,
            data: templateData,
          });

          imageUrl = await uploadImage(
            compositePng,
            `posts/${post.id}/${platform}-${Date.now()}.png`,
          );
        } catch (imgErr) {
          console.error(`Image generation failed for ${platform}:`, imgErr);
        }
      }

      // Generate caption
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
          aspectRatio,
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

function buildTemplateData(
  templateId: string,
  title: string,
  description: string,
): TemplateData {
  // Truncate helper — keep text short and punchy for templates
  const truncate = (s: string, max: number) =>
    s.length > max ? s.slice(0, max - 1) + "…" : s;

  switch (templateId.toUpperCase()) {
    case "C": {
      // Split title into two lines for the dark header
      const words = title.split(" ");
      const mid = Math.ceil(words.length / 2);
      return {
        type: "C",
        line1: words.slice(0, mid).join(" "),
        line2: words.slice(mid).join(" ") || truncate(description, 60),
      };
    }

    case "D":
      return {
        type: "D",
        badgeText: title,
      };

    case "F":
      return {
        type: "F",
        text: title,
      };

    case "G": {
      const items = description
        .split(/[,;•\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 3)
        .slice(0, 5);
      return {
        type: "G",
        title: title.length > 25 ? "CHECKLIST" : title.toUpperCase(),
        items: items.length >= 3 ? items : [
          title,
          truncate(description, 50),
          "Call or text for a free quote",
        ],
      };
    }

    case "A":
    default:
      return {
        type: "A",
        headline: title,
        body: truncate(description, 100),
      };
  }
}

function buildImagePrompt(visualApproach: string, pillar: string): string {
  // Strip any template-specific instructions from the visual approach
  // (e.g., "with a yellow badge that reads 'Hurricane Prep'" — that's the template's job)
  let base = visualApproach || `Professional photo related to ${pillar} content for a foundation repair company`;
  base = base
    .replace(/with (?:a |the )?(?:yellow |gold )?(?:badge|banner|text|overlay|label).*?[.']/gi, "")
    .replace(/text (?:overlay|that reads).*?[.']/gi, "")
    .trim();

  return `${base}. Photorealistic, professional photography, editorial quality. New England residential setting. Natural or golden hour lighting. Shallow depth of field. ABSOLUTELY NO TEXT of any kind in this image — no words, no letters, no numbers, no labels, no watermarks, no annotations, no signs, no writing, no captions, no titles, no logos, no stamps. This is a background photograph only — all text and branding will be added separately as an overlay. The image must contain zero readable characters.`;
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
