/**
 * Shapes for the inbound router (docs/plans/inbound-router.md): one read of
 * a settled customer burst, and the routes decided from it.
 */
import type { Redis } from '@upstash/redis';
import type { QuoClient } from '@aac/api-clients/quo';
import type { GeminiClient } from '@aac/api-clients/gemini';
import type { Referral, StandingRule } from '@aac/quoting';

export type InboundIntent =
  | 'new_lead'
  | 'quote_request'
  | 'photos_sent'
  | 'scope_change'
  | 'scheduling_reply'
  | 'question'
  | 'other';

export const INBOUND_INTENTS: readonly InboundIntent[] = [
  'new_lead',
  'quote_request',
  'photos_sent',
  'scope_change',
  'scheduling_reply',
  'question',
  'other',
];

export type CanHelpVerdict = 'can-help' | 'cant-help' | 'need-info';

/** The one saved read of a customer's conversation, at `inbound:read:{phone}`. */
export interface InboundRead {
  phone: string;
  /** ISO time of the read. */
  at: string;
  /** Newest message/call id + time; an unchanged fingerprint makes a re-run a no-op. */
  fingerprint: string;
  classification: 'lead' | 'solicitation' | 'other';
  propertyState: 'MA' | 'CT' | 'other' | 'unknown';
  entities: { name: string | null; address: string | null; email: string | null };
  intents: InboundIntent[];
  canHelp: {
    verdict: CanHelpVerdict;
    /** Ids of the CanHelpStore rules that fired. */
    ruleIds: string[];
    /** Referral ids that fit, best first. */
    referralIds: string[];
    reason: string;
    /** For need-info: the one question that decides it. */
    question: string | null;
  };
  /** Photo descriptions keyed `{messageId}:{index}` (Quo media URLs expire; message ids don't). */
  photos: Record<string, string>;
  summary: string;
}

/** Facts about the thread the read doesn't judge: who has said what, and what already exists. */
export interface ThreadState {
  /** Matt has texted them by hand (auto-replies excluded) or called out and connected. */
  mattEngaged: boolean;
  /** Matt's message is the newest in the thread: he has already answered this burst. */
  mattRepliedLast: boolean;
  /** Intake has already drafted or skipped this phone (message-drafts:intake-done). */
  intakeDone: boolean;
  /** A Pending estimate is open for this phone (quote-draft:open). */
  openQuote: boolean;
  /** Matt promised a quote in a recent outbound text (the quote drafter's T3). */
  quotePromised: boolean;
  /** Inbound photos in this burst (the quote drafter's T1). */
  newPhotos: number;
}

export type RouteName = 'intake' | 'ct-routing' | 'decline' | 'quote' | 'quote-gate' | 'scheduling' | 'none';

export interface Route {
  route: RouteName;
  why: string;
}

export interface RouterDeps {
  redis: Redis;
  quo: QuoClient;
  gemini: GeminiClient;
  canHelp: { rules(): Promise<StandingRule[]>; referrals(): Promise<Referral[]> };
  now?: () => number;
}

/** One line of `inbound:shadow`. */
export interface ShadowEntry {
  at: string;
  phone: string;
  /** waiting = a missed call whose voicemail may still be transcribing; the tick re-arms it. */
  outcome: 'decided' | 'unchanged' | 'waiting' | 'skipped' | 'failed';
  detail?: string;
  read?: {
    classification: InboundRead['classification'];
    propertyState: InboundRead['propertyState'];
    intents: InboundIntent[];
    verdict: CanHelpVerdict;
    ruleIds: string[];
    referrals: string[];
    reason: string;
    photosRead: number;
    entities: InboundRead['entities'];
  };
  state?: ThreadState;
  routes?: Route[];
  /** What the old paths had done for this phone when the router decided. */
  legacy?: { intake: string | null; quoteSettling: boolean };
}
