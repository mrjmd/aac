export { eventMatchesName, nameTokens, streetKey, tokensAlike } from './match.js';
export { searchCustomers, trimCustomer } from './search.js';
export type { CustomerHit } from './search.js';
export {
  buildCustomerTimeline,
  customerProfile,
  eventMatch,
  fetchEmailPart,
  fetchQboPart,
  fetchQuoPart,
  sameStreet,
  trimEvent,
} from './timeline.js';
export type {
  CustomerProfile,
  CustomerTimeline,
  QboPart,
  QuoPart,
  TimelineEmail,
  TimelineEntry,
  TimelineEvent,
  TimelineInputs,
  TimelineKind,
} from './timeline.js';
