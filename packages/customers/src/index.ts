export {
  customerNameMatches,
  eventMatchesName,
  expandCompoundName,
  expandNicknames,
  lastFirstTokens,
  nameCorroborated,
  nameTokens,
  nameTokensForMatch,
  summaryMatchesCustomer,
  tokensAlike,
} from './match.js';
export {
  extractPhonesFromDescription,
  extractPipedriveId,
  matchEventToDealAndPerson,
  matchEventToPerson,
  matchPersonToQBCustomer,
} from './resolve.js';
export type { PipedriveLookup } from './resolve.js';
export { searchCustomers, trimCustomer } from './search.js';
export type { CustomerHit } from './search.js';
export {
  buildCustomerTimeline,
  customerProfile,
  eventMatch,
  fetchEmailPart,
  fetchQboPart,
  fetchQuoPart,
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
export { NUDGE_LADDER, nudgeStatus, nudgeTouch } from './nudge.js';
export type { NudgeKind, NudgeStatus, NudgeTouch } from './nudge.js';
