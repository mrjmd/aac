/**
 * Helpers for reasoning about content post / variant approval state.
 */
import type { platformVariants } from "@/db/schema";

type PlatformVariant = typeof platformVariants.$inferSelect;

/**
 * A post is "fully approved" when every variant has BOTH its caption
 * and its image marked approved. Used to gate the Schedule UI/endpoint.
 */
export function arePostVariantsFullyApproved(
  variants: PlatformVariant[],
): boolean {
  if (variants.length === 0) return false;
  return variants.every(
    (v) => v.captionStatus === "approved" && v.imageStatus === "approved",
  );
}
