/**
 * Template G — Checklist Card
 *
 * Blue rounded card centered over a dimmed background photo.
 * Contains a title, dashed divider, and checkbox items.
 * Logo text in bottom-right corner.
 */
import React from "react";
import { BRAND } from "./brand";

export interface TemplateGProps {
  title: string;
  items: string[];
  bgDataUrl: string;
  logoDataUrl: string;
  width: number;
  height: number;
}

export function TemplateG({
  title,
  items,
  bgDataUrl,
  logoDataUrl,
  width,
  height,
}: TemplateGProps) {
  const scale = width / 1080;
  const titleSize = Math.round(48 * scale);
  const itemSize = Math.round(30 * scale);
  const logoSize = Math.round(120 * scale);

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
      {/* Dark overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          background: "rgba(0, 0, 0, 0.5)",
        }}
      />

      {/* Blue card */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: BRAND.blue,
          borderRadius: 20,
          padding: `${Math.round(44 * scale)}px ${Math.round(40 * scale)}px`,
          width: "78%",
          border: `3px solid ${BRAND.dark}`,
          boxShadow: "8px 8px 0px 0px rgba(26, 26, 26, 0.5)",
        }}
      >
        <span
          style={{
            fontFamily: "Space Grotesk",
            fontWeight: 700,
            fontSize: titleSize,
            color: BRAND.white,
            textTransform: "uppercase",
            textAlign: "center",
            letterSpacing: -1,
            marginBottom: 8,
          }}
        >
          {title}
        </span>

        {/* Divider */}
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 3,
            borderTop: "3px dashed rgba(255,255,255,0.4)",
            margin: `${Math.round(16 * scale)}px 0 ${Math.round(24 * scale)}px`,
          }}
        />

        {/* Items */}
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: Math.round(14 * scale),
              marginBottom: Math.round(16 * scale),
            }}
          >
            <span
              style={{
                fontSize: Math.round(32 * scale),
                color: BRAND.yellow,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ☑
            </span>
            <span
              style={{
                fontFamily: "Inter",
                fontWeight: 700,
                fontSize: itemSize,
                color: BRAND.white,
                lineHeight: 1.3,
              }}
            >
              {item}
            </span>
          </div>
        ))}
      </div>

      {/* Logo bottom-right */}
      <div
        style={{
          position: "absolute",
          bottom: Math.round(28 * scale),
          right: Math.round(32 * scale),
          display: "flex",
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
