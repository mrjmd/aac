import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { db } from "@/lib/db";
import { contentIdeas } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getGeminiClient } from "@/lib/gemini";
import { buildIdeaRevisionSystemPrompt } from "@/lib/prompts";

type Params = { params: Promise<{ id: string }> };

// ── GET — Fetch a single idea ─────────────────────────────────────

export async function GET(_request: NextRequest, { params }: Params) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const idea = await db
    .select()
    .from(contentIdeas)
    .where(eq(contentIdeas.id, Number(id)))
    .limit(1);

  if (!idea.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(idea[0]);
}

// ── PATCH — Update idea status (approve / revise / reject) ────────

export async function PATCH(request: NextRequest, { params }: Params) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json()) as {
    action: "approve" | "revise" | "reject";
    feedback?: string;
    rejectionReason?: string;
  };

  const idNum = Number(id);
  const existing = await db
    .select()
    .from(contentIdeas)
    .where(eq(contentIdeas.id, idNum))
    .limit(1);

  if (!existing.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const idea = existing[0];

  switch (body.action) {
    case "approve": {
      const [updated] = await db
        .update(contentIdeas)
        .set({ status: "approved", updatedAt: new Date().toISOString() })
        .where(eq(contentIdeas.id, idNum))
        .returning();
      return NextResponse.json(updated);
    }

    case "revise": {
      if (!body.feedback) {
        return NextResponse.json(
          { error: "Feedback required for revise" },
          { status: 400 },
        );
      }

      // Call Gemini to revise the idea
      const gemini = getGeminiClient();
      const meta = safeParseDescription(idea.description);

      const revisionPrompt = `Revise this social media post idea based on the feedback below.

Original idea:
- Title: ${idea.title}
- Description: ${meta.text}
- Pillar: ${idea.pillar}
- Template: ${meta.suggestedTemplate}
- Visual approach: ${meta.visualApproach}

User feedback: ${body.feedback}

Return the revised idea as a JSON object with: title, description, pillar, suggestedPlatforms, suggestedTemplate, visualApproach.`;

      const raw = await gemini.generateContent(revisionPrompt, {
        systemPrompt: buildIdeaRevisionSystemPrompt(),
        temperature: 0.7,
      });

      let revised: Record<string, unknown>;
      try {
        revised = JSON.parse(
          raw.replace(/```json\n?|\n?```/g, "").trim(),
        ) as Record<string, unknown>;
      } catch {
        return NextResponse.json(
          { error: "Failed to parse revision response", raw },
          { status: 502 },
        );
      }

      const [updated] = await db
        .update(contentIdeas)
        .set({
          title: String(revised.title ?? idea.title),
          description: JSON.stringify({
            text: revised.description,
            suggestedPlatforms: revised.suggestedPlatforms,
            suggestedTemplate: revised.suggestedTemplate,
            visualApproach: revised.visualApproach,
          }),
          pillar: String(revised.pillar ?? idea.pillar),
          status: "draft",
          revisionFeedback: body.feedback,
          version: (idea.version ?? 1) + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contentIdeas.id, idNum))
        .returning();

      return NextResponse.json(updated);
    }

    case "reject": {
      const [updated] = await db
        .update(contentIdeas)
        .set({
          status: "rejected",
          rejectionReason: body.rejectionReason ?? "other",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contentIdeas.id, idNum))
        .returning();

      // Count rejected ideas in this batch to determine backfill needs
      let backfillCount = 0;
      let rejectedTopics: string[] = [];

      if (idea.batchId) {
        const batchIdeas = await db
          .select()
          .from(contentIdeas)
          .where(eq(contentIdeas.batchId, idea.batchId));

        const rejected = batchIdeas.filter((i) => i.status === "rejected");
        rejectedTopics = rejected.map((i) => i.title);

        // Backfill = rejected count minus any replacements already generated
        // (replacements are non-rejected ideas beyond the original 5)
        const originalCount = 5;
        const nonRejected = batchIdeas.filter((i) => i.status !== "rejected");
        backfillCount = Math.max(0, originalCount - nonRejected.length);
      }

      return NextResponse.json({
        ...updated,
        backfill: backfillCount > 0
          ? { count: backfillCount, batchId: idea.batchId, rejectedTopics }
          : null,
      });
    }

    default:
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
}

function safeParseDescription(desc: string | null): {
  text: string;
  suggestedPlatforms: string[];
  suggestedTemplate: string;
  visualApproach: string;
} {
  if (!desc) return { text: "", suggestedPlatforms: [], suggestedTemplate: "", visualApproach: "" };
  try {
    return JSON.parse(desc) as ReturnType<typeof safeParseDescription>;
  } catch {
    return { text: desc, suggestedPlatforms: [], suggestedTemplate: "", visualApproach: "" };
  }
}
