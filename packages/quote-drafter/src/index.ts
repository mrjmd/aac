/**
 * @aac/quote-drafter — event-triggered quote drafting (launchd →
 * server-workers P2).
 *
 * The middleware Quo webhook enqueues message events; runTick() (worker
 * cron or manual CLI) debounces them per phone, classifies the trigger
 * (T1 photo-burst / T2 Mike-debrief / T3 quote-promised), and runs the
 * drafter: Quo thread + MMS photos + live field context → Gemini against
 * the canonical pricing ruleset → bot-marked Pending QBO estimate.
 * Nothing is ever sent to a customer.
 */
export {
  classify,
  DEBOUNCE_MS,
  INTERNAL,
  MAX_DRAFTS_PER_RUN,
  MAX_PHOTOS,
  POST_SEND_RE,
  QUOTE_PROMISE_RE,
  SKIP_IF_RECENT_ESTIMATE_DAYS,
  type DrafterAssets,
  type DrafterDeps,
  type DrafterMode,
  type DraftRunRecord,
  type QuoteFinding,
  type TriggerEvent,
  type TriggerRunlogEntry,
  type TriggerVerdict,
} from './types.js';
export { loadAssets, clearAssetCache, type AssetManifest } from './assets.js';
export { buildScopeGatePrompt, parseGateVerdict, runScopeGate, type GateVerdict } from './gate.js';
export { flagScopeChange, type ScopeFlag } from './flags.js';
export { pollQuoteEmails, type EmailPollSummary } from './email-poll.js';
export {
  getOpenQuote,
  upsertOpenQuote,
  removeOpenQuote,
  listOpenQuotes,
  summarizeLines,
  syncOpenQuoteIndex,
  OPEN_QUOTE_SYNC_INTERVAL_MS,
} from './open-quotes.js';
export { draftOne, prepareRun, type DraftOneOptions, type RunContext } from './drafter.js';
export { loadFieldChannel, fetchFieldContext, type FieldChannel } from './field-context.js';
export { runTick, resolveMode, resolveT4Mode, resolveVisitCustomers, type TickSummary } from './trigger.js';
