/**
 * What happens to a cron's once-per-entity marker when the customer-facing
 * send fails.
 *
 * The crons claim the marker (markCronAction, SET NX 7 days) BEFORE the
 * send, so a send that fails would otherwise never be retried. Owner policy
 * (approved 2026-11-05):
 *
 * - The vendor definitively answered with an error (Quo or QuickBooks HTTP
 *   4xx/5xx, including exhausted 429 retries): the action did not happen.
 *   Release the marker so the next run retries.
 * - Anything else (network error, timeout, abort, a malformed success
 *   response): the text or invoice may have gone through. Keep the marker
 *   and accept the possible loss over a duplicate customer text; the
 *   caller's catch records a health error, whose message says so.
 */

import { isVendorHttpError } from '@aac/api-clients/errors';
import { createLogger } from '@aac/shared-utils/logger';
import { releaseCronAction } from './redis.js';

const log = createLogger('cron-send');

/**
 * Apply the policy above to a failed send, and return the error for the
 * caller to rethrow. Its message is the original one plus what happened to
 * the marker, so the caller's existing health error says whether the next
 * run retries. Never throws.
 */
export async function settleFailedSend(
  action: string,
  entityId: string,
  err: unknown,
): Promise<Error> {
  const message = err instanceof Error ? err.message : String(err);

  if (isVendorHttpError(err)) {
    try {
      await releaseCronAction(action, entityId);
      log.warn('Send rejected by vendor; marker released, next run retries', {
        action,
        entityId,
        status: err.status,
      });
      return new Error(`${message} [vendor rejected (HTTP ${err.status}); marker released, next run retries]`);
    } catch (releaseErr) {
      log.error('Send rejected by vendor but marker release failed; NOT retried', releaseErr as Error, {
        action,
        entityId,
      });
      return new Error(`${message} [vendor rejected (HTTP ${err.status}); marker release FAILED, not retried]`);
    }
  }

  log.error('Ambiguous send failure; marker kept, NOT retried', err as Error, { action, entityId });
  return new Error(`${message} [ambiguous failure, may have gone through; marker kept, NOT retried, check manually]`);
}
