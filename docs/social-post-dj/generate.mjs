/**
 * Generate branded social images for the Digital Journal article.
 *
 * Run from apps/marketing/ (for node_modules access):
 *   node ../../docs/social-post-dj/generate.mjs
 */
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = __dirname;
const FONTS_DIR = join(__dirname, "..", "..", "apps", "marketing", "lib", "templates", "fonts");

// ── Load assets ───────────────────────────────────────────────────

async function loadAssets() {
  const spaceGrotesk = readFileSync(join(FONTS_DIR, "SpaceGrotesk-Bold.ttf"));
  const interBold = readFileSync(join(FONTS_DIR, "Inter-Bold.ttf"));
  const photoBuffer = readFileSync(join(DIR, "Luc and Matt.jpg"));

  // DJ logo (webp → png for satori compatibility)
  const djLogoPng = await sharp(join(DIR, "Digital-Journal-Logo-e1745859786345.webp"))
    .png()
    .toBuffer();
  const djLogoDataUrl = `data:image/png;base64,${djLogoPng.toString("base64")}`;

  const aacLogo = readFileSync(join(DIR, "logo-blue-bg.jpeg"));
  const aacLogoDataUrl = `data:image/jpeg;base64,${aacLogo.toString("base64")}`;

  return { spaceGrotesk, interBold, photoBuffer, djLogoDataUrl, aacLogoDataUrl };
}

// ── Crop photo to target aspect ratio ─────────────────────────────

async function cropPhoto(photoBuffer, targetWidth, targetHeight) {
  const meta = await sharp(photoBuffer).metadata();
  const srcW = meta.width;
  const srcH = meta.height;
  const targetRatio = targetWidth / targetHeight;
  const srcRatio = srcW / srcH;

  let cropW, cropH, cropLeft, cropTop;

  if (srcRatio > targetRatio) {
    cropH = srcH;
    cropW = Math.round(srcH * targetRatio);
    cropLeft = Math.round((srcW - cropW) / 2);
    cropTop = 0;
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetRatio);
    cropLeft = 0;
    cropTop = Math.round((srcH - cropH) * 0.25);
  }

  const cropped = await sharp(photoBuffer)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .resize(targetWidth, targetHeight)
    .jpeg({ quality: 92 })
    .toBuffer();

  return `data:image/jpeg;base64,${cropped.toString("base64")}`;
}

// ── Template (Satori uses object-based JSX, not React) ────────────

function buildTemplate({ width, height, bgDataUrl, djLogoDataUrl, aacLogoDataUrl }) {
  const scale = width / 1080;
  const isLandscape = width / height > 1.5;

  const featuredFontSize = Math.round(14 * scale);
  const quoteFontSize = isLandscape ? Math.round(38 * scale) : Math.round(44 * scale);
  const djLogoHeight = Math.round(isLandscape ? 24 * scale : 28 * scale);
  const djLogoWidth = Math.round(djLogoHeight * (726 / 92));
  const aacLogoSize = Math.round(width * 0.08);
  const pad = Math.round(40 * scale);

  return {
    type: "div",
    props: {
      style: {
        width,
        height,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      },
      children: [
        // Background photo
        {
          type: "img",
          props: {
            src: bgDataUrl,
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width,
              height,
              objectFit: "cover",
            },
          },
        },
        // Gradient overlay
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width,
              height,
              display: "flex",
              background: isLandscape
                ? "linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.25) 40%, rgba(0,0,0,0.65) 100%)"
                : "linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.18) 45%, rgba(0,0,0,0.68) 100%)",
            },
          },
        },
        // "AS FEATURED IN" + DJ logo
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              top: pad,
              left: pad,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: Math.round(6 * scale),
            },
            children: [
              {
                type: "span",
                props: {
                  style: {
                    fontFamily: "Inter",
                    fontWeight: 700,
                    fontSize: featuredFontSize,
                    color: "rgba(255,255,255,0.9)",
                    letterSpacing: 3,
                  },
                  children: "AS FEATURED IN",
                },
              },
              {
                type: "img",
                props: {
                  src: djLogoDataUrl,
                  style: {
                    height: djLogoHeight,
                    width: djLogoWidth,
                  },
                },
              },
            ],
          },
        },
        // Pull quote — lower portion
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              bottom: isLandscape ? pad : Math.round(pad * 1.8),
              left: pad,
              right: isLandscape ? Math.round(width * 0.3) : pad,
              display: "flex",
              flexDirection: "column",
              gap: Math.round(8 * scale),
            },
            children: [
              {
                type: "span",
                props: {
                  style: {
                    fontFamily: "Space Grotesk",
                    fontWeight: 700,
                    fontSize: quoteFontSize,
                    color: "#ffffff",
                    lineHeight: 1.2,
                    textShadow: "0 3px 10px rgba(0,0,0,0.6)",
                    letterSpacing: -0.5,
                  },
                  children: "\u201CYou don\u2019t need to hire me.\u201D",
                },
              },
              // Yellow accent bar
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: Math.round(60 * scale),
                    height: Math.round(4 * scale),
                    background: "#f0c34b",
                    borderRadius: 3,
                  },
                },
              },
            ],
          },
        },
        // AAC logo — bottom right
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              bottom: isLandscape ? pad : Math.round(pad * 1.8),
              right: pad,
              display: "flex",
              opacity: 0.9,
            },
            children: {
              type: "img",
              props: {
                src: aacLogoDataUrl,
                style: {
                  width: aacLogoSize,
                  height: aacLogoSize,
                  borderRadius: Math.round(10 * scale),
                  border: "2px solid rgba(255,255,255,0.3)",
                },
              },
            },
          },
        },
      ],
    },
  };
}

// ── Render to PNG ─────────────────────────────────────────────────

async function renderToPng(jsx, width, height, fonts) {
  const svg = await satori(jsx, {
    width,
    height,
    fonts: fonts.map((f) => ({
      name: f.name,
      data: f.data,
      weight: f.weight,
      style: "normal",
    })),
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  });

  return Buffer.from(resvg.render().asPng());
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("Loading assets...");
  const { spaceGrotesk, interBold, photoBuffer, djLogoDataUrl, aacLogoDataUrl } =
    await loadAssets();

  const fonts = [
    { name: "Space Grotesk", data: spaceGrotesk, weight: 700 },
    { name: "Inter", data: interBold, weight: 700 },
  ];

  const variants = [
    { name: "instagram-1080x1080", width: 1080, height: 1080 },
    { name: "facebook-linkedin-1200x630", width: 1200, height: 630 },
  ];

  for (const v of variants) {
    console.log(`Generating ${v.name}...`);

    const bgDataUrl = await cropPhoto(photoBuffer, v.width, v.height);

    const jsx = buildTemplate({
      width: v.width,
      height: v.height,
      bgDataUrl,
      djLogoDataUrl,
      aacLogoDataUrl,
    });

    const png = await renderToPng(jsx, v.width, v.height, fonts);
    const outPath = join(DIR, `dj-article-${v.name}.png`);
    writeFileSync(outPath, png);
    console.log(`  -> ${outPath}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
