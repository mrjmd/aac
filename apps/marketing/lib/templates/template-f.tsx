/**
 * Template F — Photo + Direct Text Overlay (Clean/Simple)
 *
 * Photorealistic scene with large white text directly overlaid.
 * No boxes, bars, or frames. Optional yellow accent underline.
 * Logo subtle or absent. Magazine-style.
 * Best for: clean, impactful single-message posts.
 */
import React from "react";
import { BRAND } from "./brand";

export interface TemplateFProps {
  text: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}

export function TemplateF({
  text,
  bgDataUrl,
  logoDataUrl,
  width,
  height,
}: TemplateFProps) {
  const scale = width / 1080;
  const textSize = Math.round(52 * scale);
  const logoSize = Math.round(100 * scale);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        position: "relative",
      }}
    >
      {/* Background */}
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
      {/* Dark overlay for text readability */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.45) 50%, rgba(0,0,0,0.3) 100%)",
        }}
      />

      {/* Centered text */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          maxWidth: "80%",
          gap: Math.round(12 * scale),
        }}
      >
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: textSize,
            color: BRAND.white,
            textTransform: "uppercase",
            textAlign: "center",
            letterSpacing: -0.5,
            lineHeight: 1.15,
            textShadow: "0 3px 8px rgba(0,0,0,0.5)",
          }}
        >
          {text}
        </span>
        {/* Yellow accent underline */}
        <div
          style={{
            display: "flex",
            width: Math.round(80 * scale),
            height: Math.round(5 * scale),
            background: BRAND.yellow,
            borderRadius: 4,
          }}
        />
      </div>

      {/* Small logo bottom-right */}
      <div
        style={{
          position: "absolute",
          bottom: Math.round(24 * scale),
          right: Math.round(24 * scale),
          display: "flex",
          opacity: 0.85,
        }}
      >
        <img
          src={logoDataUrl}
          style={{
            width: logoSize,
            height: logoSize,
            borderRadius: 12,
            border: `2px solid rgba(255,255,255,0.3)`,
          }}
        />
      </div>
    </div>
  );
}
