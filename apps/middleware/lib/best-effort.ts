/**
 * Best-effort side effects for webhook catch paths and health bookkeeping.
 *
 * A webhook's catch block records the failure in Redis (logHealthError,
 * trackWebhookProcessed). When Redis itself is down, that call throws out
 * of the catch and the handler answers 5xx, and Quo answers repeated 5xx by
 * auto-disabling the webhook (the 2026-10-19 pattern). These calls are
 * observability, never the reason to fail a delivery, so they go through
 * here: run, and on failure log.error and move on.
 */

import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('best-effort');

export async function bestEffort(
  label: string,
  fn: () => Promise<unknown>,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`Best-effort ${label} failed (swallowed)`, err as Error, context);
  }
}
