/**
 * The middleware's SchedulingStore: the Upstash helpers in ./redis.ts,
 * handed to @aac/scheduling's dispatch, proposal builder and suggestion
 * note (the package never touches Redis itself).
 */

import type { SchedulingDirective, SchedulingStore } from '@aac/scheduling';
import {
  getDirectiveIdByEstimate,
  getPendingDirective,
  getQbCustomerIdFromPipedrive,
  logHealthError,
  countCondition,
  markCronAction,
  storePipedriveToQbMapping,
  trackSchedulingClassification,
  writePendingDirective,
} from './redis.js';

/**
 * Each method forwards to its ./redis.ts helper at call time (not by
 * reference at load), so importing this module never reads helpers the
 * caller doesn't use.
 */
export const schedulingStore: SchedulingStore = {
  logHealthError: (source, message, details) => logHealthError(source, message, details),
  countCondition: (name) => countCondition(name),
  writePendingDirective: (directive) => writePendingDirective(directive),
  getPendingDirective: (directiveId) => getPendingDirective<SchedulingDirective>(directiveId),
  getDirectiveIdByEstimate: (qbEstimateId) => getDirectiveIdByEstimate(qbEstimateId),
  getQbCustomerIdFromPipedrive: (pipedriveId) => getQbCustomerIdFromPipedrive(pipedriveId),
  storePipedriveToQbMapping: (pipedriveId, qbCustomerId) =>
    storePipedriveToQbMapping(pipedriveId, qbCustomerId),
  trackSchedulingClassification: (eventType, summary) =>
    trackSchedulingClassification(eventType, summary),
  markCronAction: (action, entityId, ttlSeconds) => markCronAction(action, entityId, ttlSeconds),
};
