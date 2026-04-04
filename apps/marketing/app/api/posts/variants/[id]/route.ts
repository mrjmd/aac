import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { db } from "@/lib/db";
import { platformVariants, variantVersions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getGeminiClient } from "@/lib/gemini";
import { buildCaptionPrompt } from "@/lib/caption-prompts";
import { uploadImage } from "@/lib/storage";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const variantId = Number(id);

    const body = (await request.json()) as {
      target: "caption" | "image";
      action: "approve" | "revise" | "reject";
      feedback?: string;
    };

    const [variant] = await db
      .select()
      .from(platformVariants)
      .where(eq(platformVariants.id, variantId))
      .limit(1);

    if (!variant) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Save version history before any change
    if (body.action === "revise") {
      await db.insert(variantVersions).values({
        variantId: variant.id,
        caption: variant.caption,
        imageUrl: variant.imageUrl,
        feedback: body.feedback ?? null,
      });
    }

    if (body.target === "caption") {
      switch (body.action) {
        case "approve":
          await db
            .update(platformVariants)
            .set({ captionStatus: "approved", updatedAt: new Date().toISOString() })
            .where(eq(platformVariants.id, variantId));
          break;

        case "reject":
          await db
            .update(platformVariants)
            .set({ captionStatus: "rejected", updatedAt: new Date().toISOString() })
            .where(eq(platformVariants.id, variantId));
          break;

        case "revise": {
          const gemini = getGeminiClient();
          const revisePrompt = `Revise this ${variant.platform} caption based on the feedback.

Current caption:
${variant.caption}

Feedback: ${body.feedback ?? "Make it better"}

Return ONLY the revised caption text. No JSON, no labels.`;

          const { systemPrompt } = buildCaptionPrompt({
            concept: "",
            pillar: "",
            platform: variant.platform,
            visualApproach: "",
          });

          const newCaption = await gemini.generateContent(revisePrompt, {
            systemPrompt,
            temperature: 0.7,
            maxOutputTokens: 1024,
          });

          await db
            .update(platformVariants)
            .set({
              caption: newCaption.trim(),
              captionStatus: "generated",
              updatedAt: new Date().toISOString(),
            })
            .where(eq(platformVariants.id, variantId));
          break;
        }
      }
    }

    if (body.target === "image") {
      switch (body.action) {
        case "approve":
          await db
            .update(platformVariants)
            .set({ imageStatus: "approved", updatedAt: new Date().toISOString() })
            .where(eq(platformVariants.id, variantId));
          break;

        case "reject":
          await db
            .update(platformVariants)
            .set({ imageStatus: "rejected", updatedAt: new Date().toISOString() })
            .where(eq(platformVariants.id, variantId));
          break;

        case "revise": {
          // Regenerate image with feedback incorporated into prompt
          const gemini = getGeminiClient();
          const basePrompt = body.feedback
            ? `${body.feedback}. `
            : "";
          const imagePrompt = `${basePrompt}Photorealistic, professional photography, editorial quality. New England setting. Natural lighting. No text, no watermarks, no labels, no annotations, no words, no writing of any kind in the image.`;

          const [image] = await gemini.generateImage(imagePrompt, {
            aspectRatio: (variant.aspectRatio as "1:1" | "3:4" | "4:3" | "16:9") ?? "3:4",
            mimeType: "image/png",
          });

          const buffer = Buffer.from(image.base64, "base64");
          const newUrl = await uploadImage(
            buffer,
            `posts/${variant.postId}/variant-${variant.id}-${Date.now()}.png`,
          );

          await db
            .update(platformVariants)
            .set({
              imageUrl: newUrl,
              imageStatus: "generated",
              updatedAt: new Date().toISOString(),
            })
            .where(eq(platformVariants.id, variantId));
          break;
        }
      }
    }

    // Fetch updated variant
    const [updated] = await db
      .select()
      .from(platformVariants)
      .where(eq(platformVariants.id, variantId))
      .limit(1);

    return NextResponse.json(updated);
  } catch (e) {
    console.error("Variant update error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
