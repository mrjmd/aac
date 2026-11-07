/**
 * Triage data shapes: the Snapshot collect() produces and the FindingsFile
 * analyze() produces. Moved verbatim from tools/src/triage/collect.ts and
 * analyze.ts (2026-11-05); render.ts and the command center read these.
 */

import type { CalendarEvent } from '@aac/api-clients/google-calendar';
import type { SuppressedFinding, Xref } from './identity.js';

// ── snapshot shape (consumed by analyze.ts) ──────────────────────────

export interface ThreadSnapshot {
  phone: string;
  conversationId: string;
  lastActivityAt: string;
  /** Oldest-first within the history window. */
  messages: Array<{ direction: 'incoming' | 'outgoing'; at: string; text: string }>;
  calls: Array<{
    id: string;
    direction: 'incoming' | 'outgoing';
    status: string;
    at: string;
    durationSec: number;
    hasTranscript: boolean;
    /** Voicemail transcript, when the caller left one (0s completed call). */
    voicemail?: string;
  }>;
}

export interface EmailThreadSnapshot {
  threadId: string;
  subject: string;
  /** Display name + address of the non-Matt side, from the From header. */
  counterparty: string;
  counterpartyAddress: string;
  lastActivityAt: string;
  /** Oldest-first. */
  messages: Array<{
    direction: 'incoming' | 'outgoing';
    at: string;
    /** text/plain body, quoted-reply tail stripped, capped. */
    text: string;
    attachmentNames: string[];
  }>;
}

export interface CustomerSnapshot {
  id: string;
  name: string;
  /** E.164, deduped (Primary/Mobile/Alternate). Joins QBO txns → Quo threads. */
  phones: string[];
  /** Lower-cased PrimaryEmailAddr entries (QBO allows comma-separated).
   *  Identity cross-reference: joins email threads → customer. */
  emails?: string[];
  /** QBO CompanyName when set and different from DisplayName ("Tom Dacey"
   *  → "Champion Builders") — merges a contact with their company record. */
  companyName?: string;
  /** Bill/Ship address lines (street lines only matter downstream). */
  addresses?: string[];
}

export interface Snapshot {
  generatedAt: string;
  windows: {
    calendarFrom: string;
    calendarTo: string;
    qboSince: string;
    quoActiveSince: string;
  };
  calendar: CalendarEvent[];
  /** Raw QBO entities (full field set — DueDate/EmailStatus/etc. included). */
  estimates: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  customers: CustomerSnapshot[];
  completions: Record<string, Record<string, unknown> | null>;
  scheduling: {
    pending: Array<Record<string, unknown>>;
    review: Array<Record<string, unknown>>;
  };
  todos: Array<Record<string, unknown>>;
  /** Cloud-worker observability (added 2026-10-21, launchd→workers P1/P2):
   *  runlogs are newest-first; heartbeats are ISO timestamps set per cron
   *  tick, so a stale one means the worker cron is dead. */
  worker: {
    /** message-drafts runlog (followup/intake/ct-routing records). */
    messageDraftRecords: Array<Record<string, unknown>>;
    /** quote-drafter trigger runlog (T1-T4 firings + draft outcomes). */
    quoteDrafterRunlog: Array<Record<string, unknown>>;
    /** T4 scope-change flags on human-owned open quotes (newest first). */
    scopeFlags: Array<Record<string, unknown>>;
    messageDraftsHeartbeat: string | null;
    quoteDrafterHeartbeat: string | null;
    /** Redis kill-switch override (off|shadow|live) — null = env default (live). */
    quoteDrafterModeOverride: string | null;
  };
  threads: ThreadSnapshot[];
  emails: EmailThreadSnapshot[];
  /** Set when the Gmail sweep failed (e.g. token lacks gmail.readonly). */
  emailSweepError?: string;
  stats: Record<string, number>;
}

// ── finding shape (consumed by render.ts) ────────────────────────────

export type Section =
  | 'system'
  | 'booked_gap'
  | 'stub_review'
  | 'offer_hold'
  | 'incomplete_event'
  | 'quote_promised'
  | 'quote_gap'
  | 'deal_closer'
  | 'cash_not_invoiced'
  | 'cash_not_sent'
  | 'cash_overdue'
  | 'stale_estimate'
  | 'message_draft'
  | 'conversation'
  | 'solicitation'
  | 'scope_flag';

export interface Finding {
  id: string;
  section: Section;
  severity: 'red' | 'yellow' | 'info';
  title: string;
  customer?: string;
  phone?: string;
  amount?: number;
  ageDays?: number;
  evidence?: string;
  detail?: string;
  action?: string;
  source: string;
  confidence?: 'high' | 'medium' | 'low';
  /** D5: display text for the last Quo touch ("2d ago" / "none in 21d+"). */
  lastContact?: string;
  /** Deep link to the source (Gmail thread for email findings). */
  link?: string;
  /** Who this is about + when the evidence happened — feeds the shared
   *  booked-customer cross-reference (identity.ts). */
  xref?: Xref;
  /** L1/L2: a hard time from the thread (ISO), e.g. "call at 2pm today". Ranks first on Today. */
  dueAt?: string;
  /** D10/D11/D13: when the event this is about starts (ISO). This week pins the item to that day. */
  dueOn?: string;
}

export interface FindingsFile {
  generatedAt: string;
  snapshotAt: string;
  findings: Finding[];
  pulse: {
    arOpenTotal: number;
    arOpenCount: number;
    arOverdueTotal: number;
    notInvoicedCount: number;
    approvedUnscheduledCount: number;
    staleEstimateTotal: number;
    staleEstimateCount: number;
    quotePromisedCount: number;
    assessedUnquotedCount: number;
    stubAwaitingReviewCount: number;
    offeredHoldCount: number;
    incompleteUpcomingCount: number;
    draftsAwaitingSendCount: number;
    jobsNext7: number;
    jobsNext30: number;
  };
  /** Quote-drafter trigger runlog passthrough (newest-first) — render's
   *  bot-drafts section reads this now that the laptop shadow-log is dead. */
  quoteDrafterRunlog?: Array<Record<string, unknown>>;
  /** Findings dropped because the customer is already booked (audit list). */
  suppressed?: SuppressedFinding[];
  /** Clusters with an upcoming green job — render filters the stale-quote
   *  sections (awaiting-human) on these. */
  booked?: Array<{ phones: string[]; emails: string[]; qboIds: string[]; event: string; start: string; createdAt: string | null }>;
  /** Phone/email → identity cluster, for one-person-one-item grouping in the command center. */
  contactClusters?: Record<string, string>;
  stats: Record<string, number>;
}

