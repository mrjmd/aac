/**
 * Template D — Yellow Badge on Photo (Eye-Catching)
 *
 * Large yellow filled badge overlaying a photorealistic background.
 * Bold dark text inside. Logo bottom-right.
 * Best for: attention-grabbing single-message posts.
 */
import React from "react";
import { BRAND } from "./brand";

export interface TemplateDProps {
  badgeText: string;
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}

export function TemplateD({
  badgeText,
  bgDataUrl,
  logoDataUrl,
  width,
  height,
}: TemplateDProps) {
  const scale = width / 1080;
  const badgeSize = Math.round(44 * scale);
  const logoSize = Math.round(140 * scale);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
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
      {/* Subtle dark overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          background: "rgba(0, 0, 0, 0.15)",
        }}
      />

      {/* Yellow badge */}
      <div
        style={{
          display: "flex",
          maxWidth: "80%",
          background: BRAND.yellow,
          padding: `${Math.round(36 * scale)}px ${Math.round(44 * scale)}px`,
          borderRadius: 20,
          border: `4px solid ${BRAND.dark}`,
          boxShadow: `8px 8px 0px 0px ${BRAND.dark}`,
          transform: "rotate(-2deg)",
        }}
      >
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: badgeSize,
            color: BRAND.dark,
            textTransform: "uppercase",
            textAlign: "center",
            letterSpacing: -0.5,
            lineHeight: 1.15,
          }}
        >
          {badgeText}
        </span>
      </div>

      {/* Logo bottom-right */}
      <div
        style={{
          position: "absolute",
          bottom: Math.round(32 * scale),
          right: Math.round(32 * scale),
          display: "flex",
        }}
      >
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
  );
}
