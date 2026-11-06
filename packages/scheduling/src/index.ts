/**
 * @aac/scheduling — scheduling-directive pipeline.
 *
 * Owns *algorithms* (directive normalization, slot suggestion, event
 * creation, callback child-deal logic). Apps own *transport* (webhook
 * reception, signature verification, intent classification).
 *
 * Called from:
 *   - apps/middleware  Quo webhook intent extraction (dispatch.ts: classify,
 *                      write directives, create stubs / holds)
 *   - apps/middleware  QB Estimate.Update webhook
 *   - apps/middleware  daily QB reconciliation backstop cron
 *   - (future) apps/website  instant-quote → schedule flow
 *   - (future) apps/partner-app  realtor / home-inspector entry
 *
 * Design spec: docs/projects/scheduling.md
 */

export * from './types.js';
export * from './normalize-qb-approval.js';
export * from './normalize-manual-schedule.js';
export * from './normalize-appointment-confirmed.js';
export * from './execute-hold.js';
export * from './execute-stub.js';
export * from './stub-photos.js';
export * from './field-photos.js';
export * from './email-photos.js';
export * from './normalize-quo-customer.js';
export * from './resolve-callback-parent.js';
export * from './replay.js';
export * from './suggest-slot.js';
// Duration prediction for directives (the Quo-path dispatch resolves the
// estimate itself; re-exported for callers that need the predictor).
export { estimateDuration } from '@aac/quoting';
export * from './build-event-description.js';
export * from './proposal.js';
export * from './travel-time.js';
export * from './booking-sync.js';
export * from './constants.js';
export * from './store.js';
export * from './dispatch.js';
export * from './proposal-builder.js';
export * from './suggestion-note.js';
