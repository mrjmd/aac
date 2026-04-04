import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { getGeminiClient } from "@/lib/gemini";
import { db } from "@/lib/db";
import { contentIdeas } from "@/db/schema";
import {
  buildIdeaGenerationSystemPrompt,
  buildIdeaGenerationPrompt,
} from "@/lib/prompts";

interface GeneratedIdea {
  title: string;
  description: string;
  pillar: string;
  sourceType: string;
  suggestedPlatforms: string[];
  suggestedTemplate: string;
  visualApproach: string;
}

export async function POST(request: NextRequest) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    pillar?: string;
    theme?: string;
    batchId?: string;
    count?: number;
    excludeTopics?: string[];
  };

  try {
    const count = Math.min(body.count ?? 5, 10); // cap at 10
    const gemini = getGeminiClient();
    const systemPrompt = buildIdeaGenerationSystemPrompt();

    let userPrompt = buildIdeaGenerationPrompt(body.pillar, body.theme, count);
    if (body.excludeTopics?.length) {
      userPrompt += `\n\nDo NOT generate ideas similar to these rejected topics:\n${body.excludeTopics.map((t) => `- ${t}`).join("\n")}`;
    }

    const raw = await gemini.generateContent(userPrompt, {
      systemPrompt,
      temperature: 0.8,
      maxOutputTokens: 2048,
    });

    let ideas: GeneratedIdea[];
    try {
      const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
      ideas = JSON.parse(cleaned) as GeneratedIdea[];
    } catch {
      return NextResponse.json(
        { error: "Failed to parse Gemini response", raw },
        { status: 502 },
      );
    }

    const batchId = body.batchId ?? crypto.randomUUID();

    const inserted = await Promise.all(
      ideas.map((idea) =>
        db
          .insert(contentIdeas)
          .values({
            title: idea.title,
            description: JSON.stringify({
              text: idea.description,
              sourceType: idea.sourceType ?? "ai-full",
              suggestedPlatforms: idea.suggestedPlatforms,
              suggestedTemplate: idea.suggestedTemplate,
              visualApproach: idea.visualApproach,
            }),
            pillar: idea.pillar,
            status: "draft",
            batchId,
          })
          .returning(),
      ),
    );

    return NextResponse.json({
      batchId,
      ideas: inserted.flat(),
    });
  } catch (e) {
    console.error("Generate ideas error:", e);
    return NextResponse.json(
      { error: String(e) },
      { status: 500 },
    );
  }
}
