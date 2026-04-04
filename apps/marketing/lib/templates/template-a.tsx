/**
 * Template A — Headline Bar + Callout Box
 *
 * The workhorse template. Three-zone vertical stack:
 * 1. White headline bar with bold text (top)
 * 2. Yellow-bordered callout box with body text (middle-bottom)
 * 3. Logo (bottom-left)
 *
 * All on top of an AI-generated photorealistic background.
 */
import React from "react";
import { BRAND } from "./brand";

export interface TemplateAProps {
  headline: string;
  body: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}

export function TemplateA({
  headline,
  body,
  bgDataUrl,
  logoDataUrl,
  width,
  height,
}: TemplateAProps) {
  // Scale font sizes based on canvas width (1080 is the baseline)
  const scale = width / 1080;
  const headlineSize = Math.round(48 * scale);
  const bodySize = Math.round(30 * scale);
  const padding = Math.round(40 * scale);
  const logoSize = Math.round(160 * scale);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding,
        position: "relative",
      }}
    >
      {/* Background image */}
      <img
        src={bgDataUrl}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          objectFit: "cover",
        }}
      />
      {/* Dark gradient overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.05) 30%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0.35) 100%)",
        }}
      />

      {/* Headline bar */}
      <div
        style={{
          display: "flex",
          alignSelf: "flex-start",
          maxWidth: "85%",
          background: BRAND.white,
          padding: `${Math.round(24 * scale)}px ${Math.round(36 * scale)}px`,
          borderRadius: 16,
          border: `3px solid ${BRAND.dark}`,
          boxShadow: `6px 6px 0px 0px ${BRAND.dark}`,
        }}
      >
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: headlineSize,
            color: BRAND.dark,
            textTransform: "uppercase",
            letterSpacing: -0.5,
            lineHeight: 1.1,
          }}
        >
          {headline}
        </span>
      </div>

      {/* Callout box + logo row */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: Math.round(20 * scale),
        }}
      >
        {/* Callout box */}
        <div
          style={{
            display: "flex",
            alignSelf: "flex-start",
            maxWidth: "78%",
            background: "rgba(255, 255, 255, 0.95)",
            border: `3px solid ${BRAND.yellow}`,
            borderRadius: 16,
            padding: `${Math.round(24 * scale)}px ${Math.round(32 * scale)}px`,
            boxShadow: "4px 4px 0px 0px rgba(240, 195, 75, 0.6)",
          }}
        >
          <span
            style={{
              fontFamily: "Inter",
              fontWeight: 700,
              fontSize: bodySize,
              color: BRAND.dark,
              textTransform: "uppercase",
              lineHeight: 1.3,
            }}
          >
            {body}
          </span>
        </div>

        {/* Logo */}
        <div style={{ display: "flex", alignSelf: "flex-start" }}>
          <img
            src={logoDataUrl}
            style={{
              width: logoSize,
              height: logoSize,
              borderRadius: 16,
              border: `3px solid ${BRAND.dark}`,
              boxShadow: `4px 4px 0px 0px ${BRAND.dark}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
