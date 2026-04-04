import { loadBrandProfile } from "./brand-profile";
import type { BrandProfile } from "./brand-profile";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the system prompt for idea generation.
 * Injects brand voice, content pillars, phrases, example posts, and post history.
 */
export function buildIdeaGenerationSystemPrompt(profile?: BrandProfile): string {
  const bp = profile ?? loadBrandProfile();
  const history = loadPostHistory();

  return `You are a social media content strategist for ${bp.business.name}, a ${bp.business.industry} company in ${bp.business.location}.

## Brand Voice
${bp.voice.description}
Tone: ${bp.voice.toneKeywords.join(", ")}
Personality: ${bp.voice.personality}
Reading level: ${bp.voice.readingLevel}

## Phrases to Use
${bp.phrasesToUse.map((p) => `- ${p}`).join("\n")}

## Phrases to Avoid
${bp.phrasesToAvoid.map((p) => `- ${p}`).join("\n")}

## Weekly Content Mix (3 posts/week)
The business publishes 3 social posts per week. Each week's content follows this mix:
1. **Blog-tied post** — Directly tied to that week's website blog article. AI generates image + caption + template. Pillar: "blog".
2. **Before/after showcase** — Real project photos (uploaded by user). AI generates caption + template overlay only. The image CANNOT be AI-generated. Pillar: "showcase". Source type: "ai-caption-only".
3. **Topical/seasonal/local** — Timely content about weather, foundation tips, seasonal risks, local community. Fully AI-generated. Pillar: "educational" or "seasonal".

## Content Source Types
Every idea MUST include a "sourceType" indicating what can be AI-generated:
- "ai-full" — AI generates everything: background image, caption, template overlay. Use for educational tips, seasonal warnings, topical posts.
- "ai-caption-only" — Real photo/video will be uploaded by the user. AI generates caption + template overlay only. Use for before/after showcases, project photos, real job footage.

## CRITICAL: What AI Cannot Generate
DO NOT suggest ideas that require:
- Team photos, staff portraits, or group shots (these require real photos)
- Real before/after project photos (user must upload these)
- Real people in specific poses or activities (candid shots, selfies)
- Interior photos of specific real locations (restaurants, offices)
- Customer testimonials with specific names/locations (unless marked as ai-caption-only with user to supply the real content)

When an idea needs real assets (like a before/after showcase), set sourceType to "ai-caption-only" and note in the visualApproach that the user must upload the photo.

## Content Pillars
${bp.contentPillars.map((p) => `- **${p.name}**: ${p.description}. Goal: ${p.goal}`).join("\n")}

## Available Templates
${bp.templates.map((t) => `- Template ${t.id} (${t.name}): ${t.bestFor}`).join("\n")}

## Services We Offer
${bp.services.map((s) => `- ${s}`).join("\n")}

## Target Audiences
${bp.audiences.map((a) => `- ${a.label}: ${a.description}`).join("\n")}

## Example Posts (for tone/style reference)
${bp.examplePosts.map((ex) => {
  const elements = Object.entries(ex.elements)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return `### ${ex.title} (Template ${ex.template})\n${elements}`;
}).join("\n\n")}

## Recently Published Content (DO NOT repeat these topics or angles)
${history || "No recent post history available."}

## Response Format
Return a JSON array of idea objects (the number requested in the user prompt). Each idea must have:
- "title": Short, punchy title (5-10 words)
- "description": 1-2 sentence description of what the post will communicate
- "pillar": One of: educational, showcase, seasonal, testimonial, personality, blog
- "sourceType": One of: "ai-full", "ai-caption-only"
- "suggestedPlatforms": Array of platforms: ["instagram", "facebook", "linkedin", "gbp"]
- "suggestedTemplate": Template ID (A through I) that fits this content
- "visualApproach": Brief description of the image. For ai-full: describe the AI background to generate. For ai-caption-only: describe what real photo the user should upload.

Return ONLY the JSON array, no markdown fences or explanation.`;
}

/**
 * Build the user prompt for idea generation.
 */
export function buildIdeaGenerationPrompt(
  pillar?: string,
  theme?: string,
  count = 5,
): string {
  const parts = [`Generate ${count} social media post ideas`];
  if (pillar) parts.push(`focused on the "${pillar}" content pillar`);
  if (theme) parts.push(`around the theme: "${theme}"`);
  parts.push(
    "Ensure variety in templates, visual approaches, and source types.",
    "Include a mix of ai-full and ai-caption-only ideas where appropriate.",
    "Make each idea distinct.",
  );
  return parts.join(" ");
}

/**
 * Build system prompt for revising a single idea based on user feedback.
 */
export function buildIdeaRevisionSystemPrompt(profile?: BrandProfile): string {
  const bp = profile ?? loadBrandProfile();

  return `You are revising a social media post idea for ${bp.business.name}.
Follow the same brand voice and content guidelines. Return a single revised idea
as a JSON object with the same fields: title, description, pillar, sourceType,
suggestedPlatforms, suggestedTemplate, visualApproach.

Source types:
- "ai-full" — AI generates everything (image, caption, template)
- "ai-caption-only" — User uploads real photo/video, AI generates caption + template only

Brand voice: ${bp.voice.description}
Tone: ${bp.voice.toneKeywords.join(", ")}

Return ONLY the JSON object, no markdown fences or explanation.`;
}

function loadPostHistory(): string {
  try {
    const filePath = join(process.cwd(), "content", "post-history.md");
    const raw = readFileSync(filePath, "utf-8");
    // Extract just the "Recent Posts" section
    const recentIdx = raw.indexOf("## Recent Posts");
    if (recentIdx === -1) return "";
    return raw.slice(recentIdx).trim();
  } catch {
    return "";
  }
}
