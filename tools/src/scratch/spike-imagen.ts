/**
 * Spike 4.0B + 4.0C — AI Image Generation + Hybrid Composition
 *
 * 1. Generates background images via Gemini Imagen API
 * 2. Composites them with branded templates via Puppeteer
 *
 * Usage: npx tsx tools/src/scratch/spike-imagen.ts
 * Output: tools/src/scratch/spike-output/
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';

const OUTPUT_DIR = join(import.meta.dirname, 'spike-output');
const GEMINI_API_KEY = 'AIzaSyALDDD9Wd2fjPF02eFzcum899ExT2i-3L0';
const LOGO_PATH = '/Users/matt/Projects/aac-astro/public/images/logo.jpg';

// ─── Imagen API ─────────────────────────────────────────────────────────────

interface ImagenResult {
  base64: string;
  mimeType: string;
}

async function generateImage(
  prompt: string,
  aspectRatio: string = '1:1'
): Promise<ImagenResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        personGeneration: 'ALLOW_ADULT',
        outputOptions: { mimeType: 'image/png' },
      },
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Imagen API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const prediction = data.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    throw new Error(`No image in response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return {
    base64: prediction.bytesBase64Encoded,
    mimeType: prediction.mimeType || 'image/png',
  };
}

// ─── Brand Constants ────────────────────────────────────────────────────────

const BRAND = {
  blue: '#1e6fb8',
  yellow: '#f0c34b',
  dark: '#1a1a1a',
  white: '#ffffff',
  fontDisplay: "'Space Grotesk', sans-serif",
  fontBody: "'Inter', sans-serif",
  fontImports: `
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap');
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  `,
};

function baseStyles(): string {
  return `
    ${BRAND.fontImports}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: 100%; height: 100%; overflow: hidden; }
  `;
}

// ─── Templates (now with real bg image + logo support) ──────────────────────

function templateA(opts: {
  headline: string;
  body: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}): string {
  return `<!DOCTYPE html>
<html><head><style>
  ${baseStyles()}
  .container {
    width: ${opts.width}px;
    height: ${opts.height}px;
    background-image: url('${opts.bgDataUrl}');
    background-size: cover;
    background-position: center;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 40px;
    position: relative;
  }
  /* Subtle dark overlay for text readability */
  .container::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgba(0,0,0,0.25) 0%,
      rgba(0,0,0,0.05) 30%,
      rgba(0,0,0,0.05) 50%,
      rgba(0,0,0,0.3) 100%
    );
  }
  .headline-bar {
    position: relative;
    background: ${BRAND.white};
    padding: 24px 36px;
    border-radius: 16px;
    border: 3px solid ${BRAND.dark};
    box-shadow: 6px 6px 0px 0px ${BRAND.dark};
    align-self: flex-start;
    max-width: 85%;
  }
  .headline-bar h1 {
    font-family: ${BRAND.fontDisplay};
    font-weight: 700;
    font-size: 42px;
    color: ${BRAND.dark};
    text-transform: uppercase;
    letter-spacing: -0.5px;
    line-height: 1.1;
  }
  .callout-box {
    position: relative;
    background: rgba(255, 255, 255, 0.95);
    border: 3px solid ${BRAND.yellow};
    border-radius: 16px;
    padding: 28px 36px;
    max-width: 75%;
    align-self: flex-start;
    box-shadow: 4px 4px 0px 0px rgba(240, 195, 75, 0.6);
  }
  .callout-box p {
    font-family: ${BRAND.fontBody};
    font-weight: 700;
    font-size: 30px;
    color: ${BRAND.dark};
    text-transform: uppercase;
    line-height: 1.3;
  }
  .logo-area {
    position: relative;
    align-self: flex-start;
  }
  .logo-area img {
    width: 180px;
    height: 180px;
    border-radius: 20px;
    border: 3px solid ${BRAND.dark};
    box-shadow: 4px 4px 0px 0px ${BRAND.dark};
  }
</style></head><body>
  <div class="container">
    <div class="headline-bar">
      <h1>${opts.headline}</h1>
    </div>
    <div class="callout-box">
      <p>${opts.body}</p>
    </div>
    <div class="logo-area">
      <img src="${opts.logoDataUrl}" alt="Attack A Crack" />
    </div>
  </div>
</body></html>`;
}

function templateC(opts: {
  headline: string;
  subheadline: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}): string {
  return `<!DOCTYPE html>
<html><head><style>
  ${baseStyles()}
  .container {
    width: ${opts.width}px;
    height: ${opts.height}px;
    display: flex;
    flex-direction: column;
  }
  .dark-header {
    background: ${BRAND.dark};
    padding: 44px 48px 36px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dark-header h1 {
    font-family: ${BRAND.fontDisplay};
    font-weight: 700;
    font-size: 48px;
    color: ${BRAND.yellow};
    text-transform: uppercase;
    letter-spacing: -0.5px;
    line-height: 1.1;
  }
  .dark-header h2 {
    font-family: ${BRAND.fontBody};
    font-weight: 600;
    font-size: 26px;
    color: ${BRAND.yellow};
    text-transform: uppercase;
    opacity: 0.85;
    line-height: 1.2;
  }
  .photo-area {
    flex: 1;
    background-image: url('${opts.bgDataUrl}');
    background-size: cover;
    background-position: center;
    position: relative;
  }
  .logo-overlay {
    position: absolute;
    bottom: 28px;
    right: 28px;
  }
  .logo-overlay img {
    width: 120px;
    height: 120px;
    border-radius: 16px;
    border: 3px solid ${BRAND.dark};
    box-shadow: 4px 4px 0px 0px rgba(0,0,0,0.4);
  }
</style></head><body>
  <div class="container">
    <div class="dark-header">
      <h1>${opts.headline}</h1>
      <h2>${opts.subheadline}</h2>
    </div>
    <div class="photo-area">
      <div class="logo-overlay">
        <img src="${opts.logoDataUrl}" alt="Attack A Crack" />
      </div>
    </div>
  </div>
</body></html>`;
}

function templateG(opts: {
  title: string;
  items: string[];
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}): string {
  const checkItems = opts.items
    .map(item => `<div class="check-item"><span class="checkbox">☑</span><span>${item}</span></div>`)
    .join('\n');

  return `<!DOCTYPE html>
<html><head><style>
  ${baseStyles()}
  .container {
    width: ${opts.width}px;
    height: ${opts.height}px;
    background-image: url('${opts.bgDataUrl}');
    background-size: cover;
    background-position: center;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .container::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
  }
  .card {
    position: relative;
    background: ${BRAND.blue};
    border-radius: 20px;
    padding: 52px 48px;
    width: 78%;
    border: 3px solid ${BRAND.dark};
    box-shadow: 8px 8px 0px 0px rgba(26, 26, 26, 0.5);
  }
  .card h2 {
    font-family: ${BRAND.fontDisplay};
    font-weight: 700;
    font-size: 52px;
    color: ${BRAND.white};
    text-transform: uppercase;
    text-align: center;
    margin-bottom: 8px;
    letter-spacing: -1px;
  }
  .divider {
    border: none;
    border-top: 3px dotted rgba(255,255,255,0.4);
    margin: 16px 0 28px;
  }
  .check-item {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 20px;
  }
  .checkbox {
    font-size: 36px;
    color: ${BRAND.yellow};
    line-height: 1;
    flex-shrink: 0;
  }
  .check-item span:last-child {
    font-family: ${BRAND.fontBody};
    font-weight: 600;
    font-size: 32px;
    color: ${BRAND.white};
    line-height: 1.3;
  }
  .logo-bottom {
    position: absolute;
    bottom: 28px;
    right: 32px;
    z-index: 10;
  }
  .logo-bottom img {
    width: 90px;
    height: 90px;
    border-radius: 12px;
    border: 2px solid rgba(255,255,255,0.3);
    box-shadow: 3px 3px 0px 0px rgba(0,0,0,0.3);
  }
</style></head><body>
  <div class="container">
    <div class="card">
      <h2>${opts.title}</h2>
      <hr class="divider">
      ${checkItems}
    </div>
    <div class="logo-bottom">
      <img src="${opts.logoDataUrl}" alt="Attack A Crack" />
    </div>
  </div>
</body></html>`;
}

// ─── Render helper ──────────────────────────────────────────────────────────

async function renderTemplate(
  browser: puppeteer.Browser,
  html: string,
  width: number,
  height: number,
  filename: string
): Promise<void> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUTPUT_DIR, filename), type: 'png' });
  await page.close();
  console.log(`  ✓ ${filename}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log('Spike 4.0B+C — AI Image Generation + Hybrid Composition\n');

  // Load logo as data URL
  const logoBuffer = await readFile(LOGO_PATH);
  const logoDataUrl = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;

  // ── Step 1: Generate AI background images ──────────────────────────
  console.log('Step 1: Generating AI background images via Gemini Imagen...\n');

  const prompts = [
    {
      name: 'rain-foundation',
      prompt: 'Photorealistic image of heavy rain falling on the exterior of a New England colonial home, water pooling near the concrete foundation wall, dramatic stormy lighting, lush green landscaping getting soaked. No text, no watermarks, no people.',
      aspect: '3:4',
      template: 'A',
    },
    {
      name: 'foundation-wall-crack',
      prompt: 'Photorealistic image of a concrete foundation wall in a basement showing a vertical crack with slight water seepage, dramatic side lighting from a basement window, concrete texture visible. No text, no watermarks, no people.',
      aspect: '3:4',
      template: 'C',
    },
    {
      name: 'winter-house',
      prompt: 'Photorealistic image of a snow-covered New England cape-style home in winter, icicles hanging from gutters, snow piled near the foundation, overcast sky, suburban neighborhood setting. No text, no watermarks, no people.',
      aspect: '3:4',
      template: 'C',
    },
    {
      name: 'basement-interior',
      prompt: 'Photorealistic image of a dimly lit basement interior with concrete walls and floor, slight moisture visible on walls, exposed joists above, moody atmospheric lighting. No text, no watermarks, no people.',
      aspect: '3:4',
      template: 'G',
    },
    {
      name: 'spring-thaw',
      prompt: 'Photorealistic image of a New England home exterior in early spring, melting snow with water running toward the foundation, patches of green grass emerging, warm golden hour light. No text, no watermarks, no people.',
      aspect: '3:4',
      template: 'A',
    },
  ];

  const generated: Map<string, string> = new Map(); // name -> data URL

  for (const p of prompts) {
    try {
      console.log(`  Generating: ${p.name}...`);
      const result = await generateImage(p.prompt, p.aspect);

      // Save raw AI image
      const rawBuffer = Buffer.from(result.base64, 'base64');
      await writeFile(join(OUTPUT_DIR, `ai-raw-${p.name}.png`), rawBuffer);
      console.log(`  ✓ ai-raw-${p.name}.png`);

      generated.set(p.name, `data:${result.mimeType};base64,${result.base64}`);

      // Rate limit: 8 seconds between requests
      if (prompts.indexOf(p) < prompts.length - 1) {
        console.log('  (waiting 8s for rate limit...)');
        await new Promise(r => setTimeout(r, 8000));
      }
    } catch (err) {
      console.error(`  ✗ Failed: ${p.name} — ${err}`);
    }
  }

  // ── Step 2: Composite templates with AI backgrounds ────────────────
  console.log('\nStep 2: Compositing hybrid images...\n');

  const browser = await puppeteer.launch({ headless: true });
  const W = 1080, H = 1350; // Instagram 4:5

  try {
    // Template A + rain-foundation bg
    if (generated.has('rain-foundation')) {
      await renderTemplate(browser, templateA({
        headline: 'Heavy Rain Tests Your Foundation',
        body: 'South Shore storms can increase basement water pressure',
        bgDataUrl: generated.get('rain-foundation')!,
        logoDataUrl,
        width: W, height: H,
      }), W, H, 'hybrid-a-rain.png');
    }

    // Template A + spring-thaw bg
    if (generated.has('spring-thaw')) {
      await renderTemplate(browser, templateA({
        headline: 'Spring Thaw Alert',
        body: 'Melting snow creates pressure against your foundation walls',
        bgDataUrl: generated.get('spring-thaw')!,
        logoDataUrl,
        width: W, height: H,
      }), W, H, 'hybrid-a-spring.png');
    }

    // Template C + foundation-wall-crack bg
    if (generated.has('foundation-wall-crack')) {
      await renderTemplate(browser, templateC({
        headline: 'Prevention Beats Repair',
        subheadline: 'Early action saves time and stress',
        bgDataUrl: generated.get('foundation-wall-crack')!,
        logoDataUrl,
        width: W, height: H,
      }), W, H, 'hybrid-c-crack.png');
    }

    // Template C + winter-house bg
    if (generated.has('winter-house')) {
      await renderTemplate(browser, templateC({
        headline: 'Boston Winters Stress Foundations',
        subheadline: 'Freeze thaw cycles expand and contract the soil around your home',
        bgDataUrl: generated.get('winter-house')!,
        logoDataUrl,
        width: W, height: H,
      }), W, H, 'hybrid-c-winter.png');
    }

    // Template G + basement-interior bg
    if (generated.has('basement-interior')) {
      await renderTemplate(browser, templateG({
        title: 'Checklist',
        items: [
          'Wall or floor cracks',
          'Basement dampness',
          'Sticking doors or windows',
          'Water near foundation walls',
        ],
        bgDataUrl: generated.get('basement-interior')!,
        logoDataUrl,
        width: W, height: H,
      }), W, H, 'hybrid-g-basement.png');
    }

    console.log(`\n✅ Done! All images in ${OUTPUT_DIR}`);
    console.log('\nFiles to review:');
    console.log('  ai-raw-*.png     — Raw AI-generated backgrounds (no template)');
    console.log('  hybrid-*.png     — Final composited images (AI bg + template + logo)');
    console.log('\nCompare hybrid-*.png against actual Instagram posts.');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
