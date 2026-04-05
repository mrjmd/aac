/**
 * AI image quality gate.
 * Uses Gemini vision to check generated images for gibberish text,
 * irrelevance, and obvious artifacts before presenting to the user.
 */

const VISION_MODEL = "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface QualityResult {
  passed: boolean;
  hasText: boolean;
  isRelevant: boolean;
  reason: string;
}

/**
 * Check an AI-generated image for quality issues.
 * Returns pass/fail with reasons.
 */
export async function checkImageQuality(
  imageBase64: string,
  expectedContent: string,
  apiKey: string,
): Promise<QualityResult> {
  try {
    const response = await fetch(
      `${API_BASE}/${VISION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: imageBase64,
                  },
                },
                {
                  text: `Analyze this AI-generated background image for a social media post. Answer these questions:

1. TEXT_CHECK: Does this image contain ANY visible text, letters, words, numbers, labels, watermarks, or writing of any kind? Look carefully — even partial or blurry text counts. Answer YES or NO.

2. RELEVANCE_CHECK: Is this image related to: ${expectedContent}? It should show a relevant scene (house, foundation, basement, weather, construction, etc.). Answer YES or NO.

3. QUALITY_CHECK: Is this image photorealistic and professional quality, without obvious AI artifacts (weird textures, distorted objects, impossible geometry)? Answer YES or NO.

Respond in exactly this format:
TEXT: YES or NO
RELEVANT: YES or NO
QUALITY: YES or NO
REASON: One sentence explaining any issues found`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 200,
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!response.ok) {
      // If vision check fails, pass by default (don't block the pipeline)
      return { passed: true, hasText: false, isRelevant: true, reason: "Vision check unavailable" };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    const hasText = /TEXT:\s*YES/i.test(text);
    const isRelevant = /RELEVANT:\s*YES/i.test(text);
    const isQuality = /QUALITY:\s*YES/i.test(text);
    const reasonMatch = text.match(/REASON:\s*(.+)/i);
    const reason = reasonMatch?.[1]?.trim() ?? "";

    return {
      passed: !hasText && isRelevant && isQuality,
      hasText,
      isRelevant,
      reason,
    };
  } catch {
    // On error, pass by default
    return { passed: true, hasText: false, isRelevant: true, reason: "Check skipped" };
  }
}

/**
 * Generate an image with quality gate — retries up to maxAttempts if image fails checks.
 * Returns the best attempt (first passing, or last attempt if all fail).
 */
export async function generateWithQualityGate(
  generateFn: () => Promise<{ base64: string; mimeType: string }>,
  expectedContent: string,
  apiKey: string,
  maxAttempts = 3,
): Promise<{ base64: string; mimeType: string; quality: QualityResult; attempts: number }> {
  let bestResult: { base64: string; mimeType: string; quality: QualityResult } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const image = await generateFn();
    const quality = await checkImageQuality(image.base64, expectedContent, apiKey);

    if (quality.passed) {
      return { ...image, quality, attempts: attempt };
    }

    console.log(
      `Image quality gate failed (attempt ${attempt}/${maxAttempts}): ${quality.reason}`,
    );
    bestResult = { ...image, quality };

    // Don't retry if the only issue is relevance (retrying won't help much)
    if (!quality.hasText && quality.isRelevant) break;
  }

  // Return last attempt with its quality result
  return { ...bestResult!, attempts: maxAttempts };
}
