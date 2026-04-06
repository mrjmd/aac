/**
 * Unified calendar event types.
 * All sources (social, gbp, blog) produce CalendarEvent objects so the UI
 * can render them uniformly regardless of origin.
 */

export type CalendarSource = "social" | "gbp" | "blog";

export type CalendarStatus = "draft" | "scheduled" | "published" | "failed";

export interface CalendarEvent {
  /** Unique across sources, e.g. "social:42", "gbp:abc123", "blog:basement-cost-guide" */
  id: string;
  source: CalendarSource;
  /** ISO 8601 date or datetime */
  date: string;
  title: string;
  excerpt?: string;
  imageUrl?: string;
  /** Link to source — Buffer post, blog page, or /post/[id] */
  url?: string;
  status?: CalendarStatus;
  /** Source-specific extras for the detail panel */
  meta?: Record<string, unknown>;
}

export interface CalendarSourceResult {
  events: CalendarEvent[];
  /** Non-empty if the source failed; UI shows a warning banner */
  error?: string;
}
