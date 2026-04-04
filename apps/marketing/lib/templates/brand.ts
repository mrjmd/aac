/** Brand constants shared by all templates */
export const BRAND = {
  blue: "#1e6fb8",
  yellow: "#f0c34b",
  dark: "#1a1a1a",
  white: "#ffffff",
} as const;

/** Platform dimensions */
export const PLATFORM_SIZES = {
  instagram: { width: 1080, height: 1350 },
  facebook: { width: 1080, height: 1080 },
  linkedin: { width: 1200, height: 627 },
  gbp: { width: 1200, height: 900 },
} as const;

export type Platform = keyof typeof PLATFORM_SIZES;
