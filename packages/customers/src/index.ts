export { eventMatchesName, nameTokens, streetKey, tokensAlike } from './match.js';
export { searchCustomers } from './search.js';
export type { CustomerHit } from './search.js';
export { buildCustomerTimeline, customerProfile, eventMatch, getCustomerTimeline, sameStreet } from './timeline.js';
export type {
  CustomerProfile,
  CustomerTimeline,
  SourceStatus,
  TimelineDeps,
  TimelineEntry,
  TimelineInputs,
  TimelineKind,
} from './timeline.js';
