import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { getGeminiClient } from "@/lib/gemini";
import { db } from "@/lib/db";
import { contentIdeas, contentPosts, platformVariants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildCaptionPrompt } from "@/lib/caption-prompts";
import { uploadImage } from "@/lib/storage";
import { renderTemplate, type TemplateData } from "@/lib/templates/renderer";
import { PLATFORM_SIZES, PLATFORM_RATIO_LABELS, type Platform } from "@/lib/templates/brand";
import { generateWithQualityGate } from "@/lib/image-quality-gate";
import { detectFocalPoint, cropToSize } from "@/lib/image-crop";

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

    // Generate customer-facing overlay text (replaces raw internal description)
    const overlayText = await generateOverlayText(
      gemini,
      templateId,
      idea.title,
      meta.text,
      idea.pillar ?? "educational",
    );
    const templateData = buildTemplateData(templateId, idea.title, overlayText);

    // Generate ONE AI background image at 1:1, then crop per platform
    const variants = [];
    let baseImageBuffer: Buffer | null = null;
    let focalPoint = { x: 0.5, y: 0.5 };

    if (meta.sourceType !== "ai-caption-only") {
      try {
        const imagePrompt = buildImagePrompt(meta.visualApproach, idea.pillar ?? "");
        const apiKey = process.env.GEMINI_API_KEY ?? "";

        // Generate one base image at 1:1 (most versatile for cropping)
        const result = await generateWithQualityGate(
          async () => {
            const [img] = await gemini.generateImage(imagePrompt, {
              aspectRatio: "1:1",
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

        baseImageBuffer = Buffer.from(result.base64, "base64");

        // Detect focal point for smart cropping
        focalPoint = await detectFocalPoint(result.base64, apiKey);
      } catch (imgErr) {
        console.error("Base image generation failed:", imgErr);
      }
    }

    for (const platform of platforms) {
      const size = PLATFORM_SIZES[platform as Platform];
      let imageUrl: string | null = null;

      if (baseImageBuffer) {
        try {
          // Crop the base image to this platform's aspect ratio
          const croppedBuffer = await cropToSize(
            baseImageBuffer,
            size.width,
            size.height,
            focalPoint,
          );
          const bgDataUrl = `data:image/png;base64,${croppedBuffer.toString("base64")}`;

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
          console.error(`Image processing failed for ${platform}:`, imgErr);
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
          aspectRatio: PLATFORM_RATIO_LABELS[platform as Platform],
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

/**
 * Generate customer-facing overlay text via Gemini.
 * Converts the internal idea description into a short, punchy tagline
 * appropriate for displaying on a social media image.
 */
async function generateOverlayText(
  gemini: ReturnType<typeof getGeminiClient>,
  templateId: string,
  title: string,
  internalDescription: string,
  pillar: string,
): Promise<string> {
  const templateGuide: Record<string, string> = {
    A: "a short supporting tagline (8-12 words max) that complements the headline. Think magazine ad callout.",
    C: "a short second line (3-6 words) that pairs with the headline to form a punchy two-line statement.",
    D: "not needed — this template uses only the headline badge.",
    F: "not needed — this template uses only the headline.",
    G: "3-5 short actionable checklist items (each 3-8 words). Return them separated by semicolons.",
  };

  const guide = templateGuide[templateId.toUpperCase()] ?? templateGuide.A;

  // Templates D and F don't need body text
  if (templateId.toUpperCase() === "D" || templateId.toUpperCase() === "F") {
    return "";
  }

  try {
    const result = await gemini.generateContent(
      `You are writing text for a branded social media image overlay for a foundation repair company.

Post topic: ${title}
Internal concept: ${internalDescription}
Content pillar: ${pillar}

Write ${guide}

Rules:
- This text appears ON the image, not as a caption. Keep it very short.
- Write for the customer, not the content creator. No exposition or meta-descriptions.
- Direct, confident tone. No filler words.
- Do NOT include hashtags, emojis, or the company name.
- Return ONLY the overlay text, nothing else.`,
      { temperature: 0.7, maxOutputTokens: 150 },
    );
    return result.trim();
  } catch (err) {
    console.error("Overlay text generation failed, falling back to title:", err);
    return title;
  }
}

function buildTemplateData(
  templateId: string,
  title: string,
  overlayText: string,
): TemplateData {
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
        line2: overlayText || words.slice(mid).join(" "),
      };
    }

    case "D":
      return { type: "D", badgeText: title };

    case "F":
      return { type: "F", text: title };

    case "G": {
      // overlayText should be semicolon-separated checklist items
      const items = overlayText
        .split(/[;•\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 3)
        .slice(0, 5);
      return {
        type: "G",
        title: title.length > 25 ? "CHECKLIST" : title.toUpperCase(),
        items: items.length >= 3 ? items : [
          truncate(title, 40),
          "Schedule an inspection today",
          "Call or text for a free quote",
        ],
      };
    }

    case "A":
    default:
      return {
        type: "A",
        headline: title,
        body: truncate(overlayText || title, 100),
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
