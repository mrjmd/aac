/**
 * @aac/inbound-router — read each settled customer burst once and decide
 * which drafters run (docs/plans/inbound-router.md). Off by default; shadow
 * logs only; routes in `inbound-router:live` run their drafters (phase 4).
 */
export { settleDueAt, SETTLE_CAP_MS, SETTLE_QUIET_MS } from '@aac/shared-utils/inbound-settle';
export * from './types.js';
export * from './read.js';
export { decide } from './decide.js';
export * from './tick.js';
export * from './act.js';
export { sweepInbound } from './sweep.js';
