import { loadBrandProfile } from "./brand-profile";
import type { BrandProfile } from "./brand-profile";

interface CaptionContext {
  concept: string;
  pillar: string;
  platform: string;
  visualApproach: string;
}

/**
 * Build a prompt that generates a platform-specific caption.
 */
export function buildCaptionPrompt(ctx: CaptionContext, profile?: BrandProfile): {
  systemPrompt: string;
  userPrompt: string;
} {
  const bp = profile ?? loadBrandProfile();
  const rules = bp.ctaRules[platformLabel(ctx.platform)];

  const systemPrompt = `You are writing a social media caption for ${bp.business.name}, a ${bp.business.industry} company in ${bp.business.location}.

## Brand Voice
${bp.voice.description}
Tone: ${bp.voice.toneKeywords.join(", ")}
Reading level: ${bp.voice.readingLevel}

## Phrases to Use
${bp.phrasesToUse.map((p) => `- ${p}`).join("\n")}

## Phrases to Avoid
${bp.phrasesToAvoid.map((p) => `- ${p}`).join("\n")}

## Platform: ${platformLabel(ctx.platform)}
${rules ? rules.rules.map((r) => `- ${r}`).join("\n") : "No specific rules."}
${rules?.maxChars ? `Maximum ${rules.maxChars} characters.` : ""}

## Example Captions (for style reference)
${bp.examplePosts
  .filter((ex) => ex.elements["caption (" + ctx.platform.toLowerCase() + ")"])
  .map((ex) => ex.elements["caption (" + ctx.platform.toLowerCase() + ")"])
  .join("\n\n") || "No platform-specific examples available. Match the brand voice."}

Return ONLY the caption text. No JSON, no labels, no explanation.`;

  const userPrompt = `Write a ${ctx.platform} caption for a ${ctx.pillar} post about: ${ctx.concept}

The image shows: ${ctx.visualApproach}

Keep it concise, on-brand, and include the appropriate CTA for this platform.`;

  return { systemPrompt, userPrompt };
}

function platformLabel(platform: string): string {
  const map: Record<string, string> = {
    instagram: "Instagram",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    gbp: "Google Business Profile",
  };
  return map[platform.toLowerCase()] ?? platform;
}
