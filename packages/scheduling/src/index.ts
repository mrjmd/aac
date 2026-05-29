/**
 * @aac/scheduling — scheduling-directive pipeline.
 *
 * This package is intentionally empty at scaffold time. It is the home
 * for the SchedulingDirective normalizer + slot-suggestion algorithm +
 * calendar-event creation + Pipedrive deal updates + callback-child-deal
 * logic, all called from multiple entry points:
 *
 *   - apps/middleware  Quo webhook intent extraction
 *   - apps/middleware  QB webhook (Estimate.Update → Accepted)
 *   - apps/middleware  daily QB reconciliation backstop cron
 *   - (future) apps/website  instant-quote → schedule flow
 *   - (future) apps/partner-app  realtor / home-inspector entry
 *
 * The package owns *algorithms*, not transport. Apps own webhook
 * reception, intent classification, and authentication; this package
 * receives a typed directive and does the scheduling work.
 *
 * See `docs/projects/scheduling.md` (TBD) for the design spec.
 */

export const SCHEDULING_PACKAGE_VERSION = '0.0.0';
