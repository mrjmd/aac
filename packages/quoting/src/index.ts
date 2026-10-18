/**
 * @aac/quoting — quote drafting + QB Estimate creation.
 *
 * This package is intentionally empty at scaffold time. It is the home
 * for the photo-analysis + business-rules-informed quote drafting +
 * QB Estimate creation pipeline.
 *
 * Designed to be invoked from multiple entry points (same shape as
 * `@aac/scheduling`):
 *
 *   - apps/middleware  agent-driven quote drafting
 *   - (future) apps/website  instant-quote-from-photos UI
 *   - (future) apps/partner-app  realtor / inspector entry
 *
 * A successful quote draft hands off to `@aac/scheduling` once accepted
 * (the quote → schedule chain is the load-bearing "from photo to booked
 * appointment" path).
 *
 * See `docs/projects/quoting.md` (TBD) for the design spec — not yet
 * written; this scaffold codifies the architectural decision so future
 * sessions don't bolt quoting into middleware.
 */

export const QUOTING_PACKAGE_VERSION = '0.0.0';

export {
  classifyScope,
  isWarrantyLine,
  type ScopeCategory,
  type ScopeClassification,
} from './classify-scope.js';

export {
  estimateDuration,
  type DurationPrediction,
  type DurationConfidence,
  type ScopeSignals,
  type SimilarCase,
} from './estimate-duration.js';

export {
  BOT_DRAFT_MARKER,
  BOT_DRAFT_TOP_LINE,
  buildQuoteDraftPrompt,
  parseQuoteDraftResponse,
  validateQuoteDraft,
  countInjectionUnits,
  draftTotal,
  buildDescriptionLibrary,
  isBotDraft,
  assembleEstimateLines,
  selectComparables,
  buildDraftPrivateNote,
  type DraftThreadMessage,
  type QuoteDraftLine,
  type QuoteDraft,
  type ScopeAccounting,
  type DraftValidation,
  type ComparableSummary,
} from './draft-quote.js';

export {
  attributePhoto,
  daysBetween,
  messagesWithinWindow,
  type AttributionWindow,
  type CorpusEstimateRef,
  type PhotoAttribution,
  type WindowedMessage,
} from './photo-corpus.js';

export {
  cosineSimilarity,
  retrieveSimilar,
  type Scored,
} from './retrieval.js';

export {
  buildAreaAnalysisPrompt,
  parseAreaAnalysis,
  areaSituationText,
  formatPhotoContext,
  threadDigest,
  type AreaAnalysis,
  type ExemplarLibraryEntry,
  type PhotoArea,
  type PhotoRead,
} from './photo-prepass.js';
export * from './field-context';
export * from './draft-notes';
