/** Brand constants shared by all templates */
export const BRAND = {
  blue: "#1e6fb8",
  yellow: "#f0c34b",
  dark: "#1a1a1a",
  white: "#ffffff",
} as const;

/** Platform dimensions (real pixel sizes used for the final composite) */
export const PLATFORM_SIZES = {
  instagram: { width: 1080, height: 1350 }, // 4:5 portrait
  facebook: { width: 1080, height: 1350 }, // 4:5 portrait (same as IG for mobile)
  linkedin: { width: 1200, height: 627 }, // 1.91:1 landscape
  gbp: { width: 1200, height: 900 }, // 4:3 landscape
} as const;

/** Display label for aspect ratio (stored on variants for UI/debugging) */
export const PLATFORM_RATIO_LABELS: Record<keyof typeof PLATFORM_SIZES, string> = {
  instagram: "4:5",
  facebook: "4:5",
  linkedin: "1.91:1",
  gbp: "4:3",
};

export type Platform = keyof typeof PLATFORM_SIZES;
