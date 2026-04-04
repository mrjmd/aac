/**
 * Spike 4.0E — Satori Rendering Validation
 *
 * Ports Template A (headline + callout) from Puppeteer HTML to Satori JSX.
 * Composites with an existing AI-generated background image.
 * Renders at IG 4:5, FB 1:1, LI 16:9 for comparison with Puppeteer output.
 *
 * Usage: npx tsx tools/src/scratch/spike-satori.tsx
 * Output: tools/src/scratch/spike-output/satori-*
 */

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import React from 'react';

const OUTPUT_DIR = join(import.meta.dirname, 'spike-output');
const FONTS_DIR = join(import.meta.dirname, 'fonts');
const LOGO_PATH = '/Users/matt/Projects/aac-astro/public/images/logo.jpg';

// Brand constants
const BRAND = {
  blue: '#1e6fb8',
  yellow: '#f0c34b',
  dark: '#1a1a1a',
  white: '#ffffff',
};

// Platform dimensions
const SIZES = {
  instagram: { width: 1080, height: 1350 },
  facebook: { width: 1080, height: 1080 },
  linkedin: { width: 1200, height: 627 },
} as const;

// ── Template A: Headline Bar + Callout Box (Satori JSX) ─────────────

function TemplateA({ headline, body, bgDataUrl, logoDataUrl, width, height }: {
  headline: string;
  body: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}) {
  return (
    <div style={{
      width, height,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: 40,
      position: 'relative',
    }}>
      {/* Background image */}
      <img
        src={bgDataUrl}
        style={{
          position: 'absolute',
          top: 0, left: 0, width, height,
          objectFit: 'cover',
        }}
      />
      {/* Dark gradient overlay for readability */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, width, height,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.05) 30%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0.3) 100%)',
      }} />

      {/* Headline bar */}
      <div style={{
        display: 'flex',
        alignSelf: 'flex-start',
        maxWidth: '85%',
        background: BRAND.white,
        padding: '24px 36px',
        borderRadius: 16,
        border: `3px solid ${BRAND.dark}`,
        boxShadow: `6px 6px 0px 0px ${BRAND.dark}`,
      }}>
        <span style={{
          fontFamily: 'Space Grotesk',
          fontWeight: 700,
          fontSize: 42,
          color: BRAND.dark,
          textTransform: 'uppercase',
          letterSpacing: -0.5,
          lineHeight: 1.1,
        }}>
          {headline}
        </span>
      </div>

      {/* Callout box */}
      <div style={{
        display: 'flex',
        alignSelf: 'flex-start',
        maxWidth: '75%',
        background: 'rgba(255, 255, 255, 0.95)',
        border: `3px solid ${BRAND.yellow}`,
        borderRadius: 16,
        padding: '28px 36px',
        boxShadow: '4px 4px 0px 0px rgba(240, 195, 75, 0.6)',
      }}>
        <span style={{
          fontFamily: 'Inter',
          fontWeight: 700,
          fontSize: 30,
          color: BRAND.dark,
          textTransform: 'uppercase',
          lineHeight: 1.3,
        }}>
          {body}
        </span>
      </div>

      {/* Logo */}
      <div style={{ display: 'flex', alignSelf: 'flex-start' }}>
        <img
          src={logoDataUrl}
          style={{
            width: 180,
            height: 180,
            borderRadius: 20,
            border: `3px solid ${BRAND.dark}`,
            boxShadow: `4px 4px 0px 0px ${BRAND.dark}`,
          }}
        />
      </div>
    </div>
  );
}

// ── Template G: Checklist Card (Satori JSX) ──────────────────────────

function TemplateG({ title, items, bgDataUrl, width, height }: {
  title: string;
  items: string[];
  bgDataUrl: string;
  width: number;
  height: number;
}) {
  return (
    <div style={{
      width, height,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    }}>
      {/* Background image */}
      <img
        src={bgDataUrl}
        style={{
          position: 'absolute',
          top: 0, left: 0, width, height,
          objectFit: 'cover',
        }}
      />
      {/* Dark overlay */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, width, height,
        background: 'rgba(0, 0, 0, 0.5)',
      }} />

      {/* Blue card */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        background: BRAND.blue,
        borderRadius: 20,
        padding: '52px 48px',
        width: '78%',
        border: `3px solid ${BRAND.dark}`,
        boxShadow: '8px 8px 0px 0px rgba(26, 26, 26, 0.5)',
      }}>
        <span style={{
          fontFamily: 'Space Grotesk',
          fontWeight: 700,
          fontSize: 52,
          color: BRAND.white,
          textTransform: 'uppercase',
          textAlign: 'center',
          letterSpacing: -1,
          marginBottom: 8,
        }}>
          {title}
        </span>

        {/* Divider */}
        <div style={{
          display: 'flex',
          width: '100%',
          height: 3,
          borderTop: '3px dashed rgba(255,255,255,0.4)',
          margin: '16px 0 28px',
        }} />

        {/* Check items */}
        {items.map((item, i) => (
          <div key={i} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            marginBottom: 20,
          }}>
            <span style={{
              fontSize: 36,
              color: BRAND.yellow,
              lineHeight: 1,
              flexShrink: 0,
            }}>
              ☑
            </span>
            <span style={{
              fontFamily: 'Inter',
              fontWeight: 700,
              fontSize: 32,
              color: BRAND.white,
              lineHeight: 1.3,
            }}>
              {item}
            </span>
          </div>
        ))}
      </div>

      {/* Logo bottom right */}
      <div style={{
        position: 'absolute',
        bottom: 32,
        right: 40,
        display: 'flex',
      }}>
        <span style={{
          fontFamily: 'Space Grotesk',
          fontWeight: 700,
          fontSize: 20,
          color: BRAND.white,
          textTransform: 'uppercase',
          letterSpacing: 1,
          textShadow: '2px 2px 4px rgba(0,0,0,0.7)',
        }}>
          ATTACK ⚡ CRACK
        </span>
      </div>
    </div>
  );
}

// ��─ Render helper ────────────────��───────────────────────────────────

async function renderToFile(
  jsx: React.ReactNode,
  width: number,
  height: number,
  fonts: { name: string; data: Buffer; weight: number }[],
  filename: string,
): Promise<void> {
  const start = performance.now();

  const svg = await satori(jsx as React.ReactElement, {
    width,
    height,
    fonts: fonts.map(f => ({
      name: f.name,
      data: f.data,
      weight: f.weight as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
      style: 'normal' as const,
    })),
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
  });
  const png = resvg.render().asPng();

  await writeFile(join(OUTPUT_DIR, filename), png);
  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`  ✓ ${filename} (${width}x${height}) — ${elapsed}ms`);
}

// ── Main ───────────────���─────────────────────────────────────────────

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log('Spike 4.0E — Satori Rendering Validation\n');

  // Load fonts (TTF required — Satori doesn't support WOFF2)
  const spaceGroteskBold = await readFile(join(FONTS_DIR, 'SpaceGrotesk-Bold.ttf'));
  const interBold = await readFile(join(FONTS_DIR, 'Inter-Bold.ttf'));

  const fonts = [
    { name: 'Space Grotesk', data: spaceGroteskBold, weight: 700 },
    { name: 'Inter', data: interBold, weight: 700 },
  ];

  // Load the AI-generated spring thaw background (best result from spike 4.0B)
  const bgImage = await readFile(join(OUTPUT_DIR, 'ai-raw-spring-thaw.png'));
  const bgDataUrl = `data:image/png;base64,${bgImage.toString('base64')}`;

  // Load the basement interior background (for template G)
  const bgBasement = await readFile(join(OUTPUT_DIR, 'ai-raw-basement-interior.png'));
  const bgBasementDataUrl = `data:image/png;base64,${bgBasement.toString('base64')}`;

  // Load logo
  const logo = await readFile(LOGO_PATH);
  const logoDataUrl = `data:image/jpeg;base64,${logo.toString('base64')}`;

  // ── Template A: Headline + Callout Box ────────────────────────────
  console.log('Template A — Headline + Callout Box (with AI background):');
  for (const [platform, size] of Object.entries(SIZES)) {
    await renderToFile(
      <TemplateA
        headline="Heavy Rain Tests Your Foundation"
        body="South Shore storms can increase basement water pressure"
        bgDataUrl={bgDataUrl}
        logoDataUrl={logoDataUrl}
        width={size.width}
        height={size.height}
      />,
      size.width,
      size.height,
      fonts,
      `satori-a-${platform}.png`,
    );
  }

  // ── Template G: Checklist Card ────────────────────────────────────
  console.log('\nTemplate G — Checklist Card (with AI background):');
  for (const [platform, size] of Object.entries(SIZES)) {
    await renderToFile(
      <TemplateG
        title="Checklist"
        items={[
          'Wall or floor cracks',
          'Basement dampness',
          'Sticking doors or windows',
          'Water near foundation walls',
        ]}
        bgDataUrl={bgBasementDataUrl}
        width={size.width}
        height={size.height}
      />,
      size.width,
      size.height,
      fonts,
      `satori-g-${platform}.png`,
    );
  }

  console.log('\n✅ Satori rendering complete!');
  console.log('Compare satori-* files against hybrid-* and template-* files in spike-output/');
}

main().catch(console.error);
