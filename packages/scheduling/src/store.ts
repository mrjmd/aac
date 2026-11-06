/**
 * Persistence the scheduling dispatch, proposal builder and suggestion
 * note need, injected by the app (apps/middleware wires it to its Upstash
 * helpers in lib/redis.ts). The package never builds a Redis client or
 * names a Redis key itself.
 */

import type { ConditionName } from '@aac/shared-utils/health';
import type { SchedulingDirective } from './types.js';

export interface SchedulingStore {
  /** Append to the /api/health error list (surfaced to Matt by the agent). */
  logHealthError(source: string, message: string, details?: Record<string, unknown>): Promise<void>;
  /** Count a silent skip for the System health page (@aac/shared-utils/health countCondition). Optional; never throws. */
  countCondition?(name: ConditionName): Promise<void>;
  /** Write a directive to the shadow queue (pending or pending-review by confidence). */
  writePendingDirective(directive: SchedulingDirective): Promise<void>;
  /** Read a directive from the shadow queue. */
  getPendingDirective(directiveId: string): Promise<SchedulingDirective | null>;
  /** Directive id (or handled marker) already produced for a QB estimate. */
  getDirectiveIdByEstimate(qbEstimateId: string): Promise<string | null>;
  /** Cached PD person → QB customer id. */
  getQbCustomerIdFromPipedrive(pipedriveId: string): Promise<string | null>;
  /** Cache PD person ↔ QB customer ids. */
  storePipedriveToQbMapping(pipedriveId: string, qbCustomerId: string): Promise<void>;
  /** Count classifier calls and directives written, per event type, per day. */
  trackSchedulingClassification(
    eventType: string,
    summary: { classified: number; directivesWritten: number },
  ): Promise<void>;
  /** SET NX marker; true when this call claimed it (the action is new). */
  markCronAction(action: string, entityId: string, ttlSeconds?: number): Promise<boolean>;
}
