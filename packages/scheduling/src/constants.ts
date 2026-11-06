/**
 * Scheduling constants shared by the pipeline and the apps' Redis stores.
 *
 * Kept dependency-free and exported on its own subpath
 * (`@aac/scheduling/constants`) so a store module that every serverless
 * function imports can read the threshold without loading the pipeline.
 */

/**
 * Confidence threshold for routing a directive onto the auto-propose path.
 * Directives at or above this score land on `scheduling:pending:list`;
 * below it they land on `scheduling:pending-review:list` so Matt can
 * triage manually (no auto-fire SMS).
 *
 * Calibrated against the Walk #6 smoke-test (Margie's directive scored
 * ~0.55 and shouldn't have auto-fired).
 */
export const SCHEDULING_AUTO_PROPOSE_THRESHOLD = 0.7;
