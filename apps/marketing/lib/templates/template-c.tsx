/**
 * Template C — Dark Header + Photo (Bold Statement)
 *
 * Dark top bar with gold text (two lines), photo area below, logo at bottom.
 * Best for: bold value propositions, seasonal warnings.
 */
import React from "react";
import { BRAND } from "./brand";

export interface TemplateCProps {
  line1: string;
  line2: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}

export function TemplateC({
  line1,
  line2,
  bgDataUrl,
  logoDataUrl,
  width,
  height,
}: TemplateCProps) {
  const scale = width / 1080;
  const headerHeight = Math.round(height * 0.28);
  const line1Size = Math.round(44 * scale);
  const line2Size = Math.round(32 * scale);
  const logoSize = Math.round(130 * scale);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {/* Background image behind everything */}
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

      {/* Dark header bar */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          width,
          height: headerHeight,
          background: "rgba(26, 26, 26, 0.92)",
          padding: `${Math.round(24 * scale)}px ${Math.round(40 * scale)}px`,
          gap: Math.round(8 * scale),
        }}
      >
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: line1Size,
            color: BRAND.yellow,
            textTransform: "uppercase",
            textAlign: "center",
            letterSpacing: -0.5,
            lineHeight: 1.15,
          }}
        >
          {line1}
        </span>
        <span
          style={{
            fontFamily: "Inter",
            fontWeight: 700,
            fontSize: line2Size,
            color: "rgba(255, 255, 255, 0.85)",
            textTransform: "uppercase",
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          {line2}
        </span>
      </div>

      {/* Photo area — the background shows through */}
      <div style={{ display: "flex", flex: 1 }} />

      {/* Logo bar at bottom */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: `${Math.round(20 * scale)}px`,
          background: "rgba(0, 0, 0, 0.4)",
        }}
      >
        <img
          src={logoDataUrl}
          style={{
            width: logoSize,
            height: logoSize,
            borderRadius: 12,
            border: `2px solid ${BRAND.dark}`,
            boxShadow: `3px 3px 0px 0px ${BRAND.dark}`,
          }}
        />
      </div>
    </div>
  );
}
