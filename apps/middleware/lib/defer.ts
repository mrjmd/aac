/**
 * Ack-fast helper: continue work AFTER the webhook response goes out.
 *
 * Why this exists (2026-10-19 incident): ONE slow scheduling-reply
 * handler exceeded Quo's webhook timeout, Quo retried, timed out again,
 * and auto-disabled the entire webhook — silently killing every
 * downstream automation. Webhook handlers must ack in milliseconds;
 * anything that calls Gemini/QBO/Calendar runs through here instead.
 *
 * Uses Vercel's waitUntil (the function instance stays alive up to its
 * maxDuration). Outside a Vercel request context (tests, local tsx) it
 * falls back to a detached promise so behavior stays observable.
 */
import { waitUntil } from '@vercel/functions';

export function defer(work: Promise<unknown>): void {
  const guarded = work.catch(() => {});
  try {
    waitUntil(guarded);
  } catch {
    void guarded;
  }
}
