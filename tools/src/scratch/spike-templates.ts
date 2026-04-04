/**
 * Spike 4.0A — Template Rendering Proof of Concept
 *
 * Renders branded social media templates to PNG using Puppeteer.
 * Tests whether HTML/CSS templates can produce Instagram-quality images
 * that match AAC's neo-brutalist website aesthetic.
 *
 * Usage: npx tsx tools/src/scratch/spike-templates.ts
 * Output: tools/src/scratch/spike-output/
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const OUTPUT_DIR = join(import.meta.dirname, 'spike-output');

// Brand constants from visual-brand-identity.md
const BRAND = {
  blue: '#1e6fb8',
  yellow: '#f0c34b',
  dark: '#1a1a1a',
  white: '#ffffff',
  lightGray: '#f5f5f5',
  fontDisplay: "'Space Grotesk', sans-serif",
  fontBody: "'Inter', sans-serif",
  // Google Fonts URLs for Puppeteer (can't use local woff2)
  fontImports: `
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap');
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  `,
};

// Platform dimensions
const SIZES = {
  instagram: { width: 1080, height: 1350 }, // 4:5 portrait
  facebook: { width: 1080, height: 1080 },  // 1:1 square
  linkedin: { width: 1200, height: 627 },   // 1.91:1 landscape
};

function baseStyles(): string {
  return `
    ${BRAND.fontImports}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
  `;
}

/**
 * Template A: Headline Bar + Callout Box
 * The workhorse template — white headline bar, yellow-bordered callout, logo bottom
 */
function templateA(opts: {
  headline: string;
  body: string;
  bgImageUrl?: string;
  width: number;
  height: number;
}): string {
  const bgImage = opts.bgImageUrl
    ? `background-image: url('${opts.bgImageUrl}'); background-size: cover; background-position: center;`
    : `background: linear-gradient(135deg, #4a6741 0%, #2d4a2d 50%, #1a3a1a 100%);`;

  return `<!DOCTYPE html>
<html><head><style>
  ${baseStyles()}
  .container {
    width: ${opts.width}px;
    height: ${opts.height}px;
    ${bgImage}
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 40px;
    position: relative;
  }
  .headline-bar {
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
    align-self: flex-start;
  }
  .logo-text {
    font-family: ${BRAND.fontDisplay};
    font-weight: 700;
    font-size: 64px;
    color: ${BRAND.white};
    text-transform: uppercase;
    letter-spacing: -1px;
    text-shadow: 3px 3px 0px ${BRAND.dark}, -1px -1px 0px ${BRAND.dark};
    line-height: 0.85;
  }
  .logo-text .crack {
    display: block;
    background: linear-gradient(180deg, #e8e8e8 0%, #b0b0b0 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(3px 3px 0px ${BRAND.dark});
  }
  .logo-bolt {
    color: ${BRAND.yellow};
    font-size: 48px;
    margin: -10px 4px;
    display: inline-block;
    text-shadow: 2px 2px 0px ${BRAND.dark};
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
      <div class="logo-text">
        ATTACK<br>
        <span class="logo-bolt">⚡</span>
        <span class="crack">CRACK</span>
      </div>
    </div>
  </div>
</body></html>`;
}

/**
 * Template C: Dark Header + Photo
 * Bold statement with dark bar, gold text, photo below
 */
function templateC(opts: {
  headline: string;
  subheadline: string;
  bgImageUrl?: string;
  width: number;
  height: number;
}): string {
  const bgImage = opts.bgImageUrl
    ? `background-image: url('${opts.bgImageUrl}'); background-size: cover; background-position: center;`
    : `background: linear-gradient(180deg, #666 0%, #888 100%);`;

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
    padding: 48px 48px 40px;
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
    font-size: 28px;
    color: ${BRAND.yellow};
    text-transform: uppercase;
    opacity: 0.85;
    line-height: 1.2;
  }
  .photo-area {
    flex: 1;
    ${bgImage}
    position: relative;
  }
  .logo-overlay {
    position: absolute;
    bottom: 32px;
    left: 50%;
    transform: translateX(-50%);
  }
  .logo-badge {
    background: ${BRAND.dark};
    border: 3px solid ${BRAND.yellow};
    border-radius: 16px;
    padding: 12px 28px;
    box-shadow: 4px 4px 0px 0px rgba(0,0,0,0.3);
  }
  .logo-badge span {
    font-family: ${BRAND.fontDisplay};
    font-weight: 700;
    font-size: 28px;
    color: ${BRAND.white};
    text-transform: uppercase;
    letter-spacing: 2px;
  }
  .logo-badge .bolt {
    color: ${BRAND.yellow};
    margin: 0 2px;
  }
</style></head><body>
  <div class="container">
    <div class="dark-header">
      <h1>${opts.headline}</h1>
      <h2>${opts.subheadline}</h2>
    </div>
    <div class="photo-area">
      <div class="logo-overlay">
        <div class="logo-badge">
          <span>ATTACK <span class="bolt">⚡</span> CRACK</span>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
}

/**
 * Template G: Checklist Card
 * Blue card with checkbox items over a dimmed photo background
 */
function templateG(opts: {
  title: string;
  items: string[];
  bgImageUrl?: string;
  width: number;
  height: number;
}): string {
  const bgImage = opts.bgImageUrl
    ? `background-image: url('${opts.bgImageUrl}'); background-size: cover; background-position: center;`
    : `background: #555;`;

  const checkItems = opts.items
    .map(item => `<div class="check-item"><span class="checkbox">☑</span><span>${item}</span></div>`)
    .join('\n');

  return `<!DOCTYPE html>
<html><head><style>
  ${baseStyles()}
  .container {
    width: ${opts.width}px;
    height: ${opts.height}px;
    ${bgImage}
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .container::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
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
    bottom: 32px;
    right: 40px;
    z-index: 10;
  }
  .logo-bottom span {
    font-family: ${BRAND.fontDisplay};
    font-weight: 700;
    font-size: 20px;
    color: ${BRAND.white};
    text-transform: uppercase;
    letter-spacing: 1px;
    text-shadow: 2px 2px 4px rgba(0,0,0,0.7);
  }
</style></head><body>
  <div class="container">
    <div class="card">
      <h2>${opts.title}</h2>
      <hr class="divider">
      ${checkItems}
    </div>
    <div class="logo-bottom">
      <span>ATTACK ⚡ CRACK</span>
    </div>
  </div>
</body></html>`;
}

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
  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUTPUT_DIR, filename), type: 'png' });
  await page.close();
  console.log(`  ✓ ${filename} (${width}x${height})`);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log('Spike 4.0A — Template Rendering PoC\n');

  const browser = await puppeteer.launch({ headless: true });

  try {
    // ── Template A: Headline + Callout Box ─────────────────────────
    console.log('Template A — Headline + Callout Box:');
    for (const [platform, size] of Object.entries(SIZES)) {
      await renderTemplate(
        browser,
        templateA({
          headline: 'Heavy Rain Tests Your Foundation',
          body: 'South Shore storms can increase basement water pressure',
          width: size.width,
          height: size.height,
        }),
        size.width,
        size.height,
        `template-a-${platform}.png`
      );
    }

    // ── Template C: Dark Header + Photo ─────────────────────────────
    console.log('\nTemplate C — Dark Header + Photo:');
    for (const [platform, size] of Object.entries(SIZES)) {
      await renderTemplate(
        browser,
        templateC({
          headline: 'Prevention Beats Repair',
          subheadline: 'Early action saves time and stress',
          width: size.width,
          height: size.height,
        }),
        size.width,
        size.height,
        `template-c-${platform}.png`
      );
    }

    // ── Template G: Checklist Card ──────────────────────────────────
    console.log('\nTemplate G — Checklist Card:');
    for (const [platform, size] of Object.entries(SIZES)) {
      await renderTemplate(
        browser,
        templateG({
          title: 'Checklist',
          items: [
            'Wall or floor cracks',
            'Basement dampness',
            'Sticking doors or windows',
            'Water near foundation walls',
          ],
          width: size.width,
          height: size.height,
        }),
        size.width,
        size.height,
        `template-g-${platform}.png`
      );
    }

    console.log(`\n✅ All templates rendered to ${OUTPUT_DIR}`);
    console.log('Review the PNGs and compare against the actual Instagram feed.');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
