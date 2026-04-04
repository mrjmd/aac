/**
 * Satori + resvg renderer.
 * Takes a template JSX component + data → composite PNG buffer.
 */
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { PLATFORM_SIZES, type Platform } from "./brand";
import { TemplateA } from "./template-a";
import { TemplateG } from "./template-g";

// ── Font loading (cached at module level) ──────────────────────────

const TEMPLATES_DIR = join(process.cwd(), "lib", "templates");

let _fonts: { name: string; data: Buffer; weight: number }[] | null = null;

function getFonts() {
  if (!_fonts) {
    const fontsDir = join(TEMPLATES_DIR, "fonts");
    _fonts = [
      {
        name: "Space Grotesk",
        data: readFileSync(join(fontsDir, "SpaceGrotesk-Bold.ttf")),
        weight: 700,
      },
      {
        name: "Inter",
        data: readFileSync(join(fontsDir, "Inter-Bold.ttf")),
        weight: 700,
      },
    ];
  }
  return _fonts;
}

// ── Logo loading (cached) ──────────────────────────────────────────

let _logoDataUrl: string | null = null;

function getLogoDataUrl(): string {
  if (!_logoDataUrl) {
    const logoPath = join(TEMPLATES_DIR, "logo.jpg");
    const logo = readFileSync(logoPath);
    _logoDataUrl = `data:image/jpeg;base64,${logo.toString("base64")}`;
  }
  return _logoDataUrl;
}

// ── Public API ─────────────────────────────────────────────────────

export interface RenderOptions {
  templateId: string;
  platform: Platform;
  /** AI background image as a base64 data URL */
  bgDataUrl: string;
  /** Template-specific data */
  data: TemplateData;
}

export type TemplateData =
  | { type: "A"; headline: string; body: string }
  | { type: "G"; title: string; items: string[] };

/**
 * Render a branded template composite to a PNG buffer.
 * AI background + brand template overlay + logo → final image.
 */
export async function renderTemplate(options: RenderOptions): Promise<Buffer> {
  const { templateId, platform, bgDataUrl, data } = options;
  const size = PLATFORM_SIZES[platform];
  const logoDataUrl = getLogoDataUrl();

  let jsx: React.ReactElement;

  switch (templateId.toUpperCase()) {
    case "A":
      if (data.type !== "A") throw new Error("Template A requires type A data");
      jsx = (
        <TemplateA
          headline={data.headline}
          body={data.body}
          bgDataUrl={bgDataUrl}
          logoDataUrl={logoDataUrl}
          width={size.width}
          height={size.height}
        />
      );
      break;

    case "G":
      if (data.type !== "G") throw new Error("Template G requires type G data");
      jsx = (
        <TemplateG
          title={data.title}
          items={data.items}
          bgDataUrl={bgDataUrl}
          logoDataUrl={logoDataUrl}
          width={size.width}
          height={size.height}
        />
      );
      break;

    default:
      // Fallback to Template A for unimplemented templates
      jsx = (
        <TemplateA
          headline={data.type === "A" ? data.headline : (data as { title?: string }).title ?? ""}
          body={data.type === "A" ? data.body : ""}
          bgDataUrl={bgDataUrl}
          logoDataUrl={logoDataUrl}
          width={size.width}
          height={size.height}
        />
      );
  }

  return renderJsxToPng(jsx, size.width, size.height);
}

/**
 * Render raw JSX to PNG via Satori → SVG → resvg → PNG.
 */
async function renderJsxToPng(
  jsx: React.ReactElement,
  width: number,
  height: number,
): Promise<Buffer> {
  const fonts = getFonts();

  const svg = await satori(jsx, {
    width,
    height,
    fonts: fonts.map((f) => ({
      name: f.name,
      data: f.data,
      weight: f.weight as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
      style: "normal" as const,
    })),
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  });

  return Buffer.from(resvg.render().asPng());
}
