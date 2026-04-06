/**
 * Single-image focal-point crop pipeline.
 * Generates one AI image, detects the focal point via Gemini vision,
 * then crops to each platform's aspect ratio centered on that point.
 */
import sharp from "sharp";

const VISION_MODEL = "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface FocalPoint {
  x: number; // 0–1, left to right
  y: number; // 0–1, top to bottom
}

/**
 * Detect the focal point of an image using Gemini vision.
 * Returns normalized coordinates (0–1) of the main subject.
 */
export async function detectFocalPoint(
  imageBase64: string,
  apiKey: string,
): Promise<FocalPoint> {
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
                  inlineData: { mimeType: "image/png", data: imageBase64 },
                },
                {
                  text: `This image will be cropped to different aspect ratios for social media posts. Identify the main visual subject or area of interest.

Return the focal point as two decimal numbers between 0 and 1:
- X: horizontal position (0 = left edge, 0.5 = center, 1 = right edge)
- Y: vertical position (0 = top edge, 0.5 = center, 1 = bottom edge)

Respond in exactly this format, nothing else:
X: 0.XX
Y: 0.XX`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.1, maxOutputTokens: 50 },
        }),
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) return { x: 0.5, y: 0.5 };

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    const xMatch = text.match(/X:\s*([\d.]+)/i);
    const yMatch = text.match(/Y:\s*([\d.]+)/i);

    const x = xMatch ? Math.min(1, Math.max(0, parseFloat(xMatch[1]))) : 0.5;
    const y = yMatch ? Math.min(1, Math.max(0, parseFloat(yMatch[1]))) : 0.5;

    return { x, y };
  } catch {
    return { x: 0.5, y: 0.5 };
  }
}

/**
 * Crop an image to a target size, keeping the focal point as centered as possible.
 */
export async function cropToSize(
  imageBuffer: Buffer,
  targetWidth: number,
  targetHeight: number,
  focal: FocalPoint,
): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const srcW = metadata.width!;
  const srcH = metadata.height!;

  const targetRatio = targetWidth / targetHeight;
  const srcRatio = srcW / srcH;

  let cropW: number;
  let cropH: number;

  if (srcRatio > targetRatio) {
    // Source is wider than target — crop sides
    cropH = srcH;
    cropW = Math.round(srcH * targetRatio);
  } else {
    // Source is taller than target — crop top/bottom
    cropW = srcW;
    cropH = Math.round(srcW / targetRatio);
  }

  // Position the crop window centered on the focal point
  const focalPxX = Math.round(focal.x * srcW);
  const focalPxY = Math.round(focal.y * srcH);

  let left = Math.round(focalPxX - cropW / 2);
  let top = Math.round(focalPxY - cropH / 2);

  // Clamp to image bounds
  left = Math.max(0, Math.min(left, srcW - cropW));
  top = Math.max(0, Math.min(top, srcH - cropH));

  return sharp(imageBuffer)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(targetWidth, targetHeight)
    .png()
    .toBuffer();
}
