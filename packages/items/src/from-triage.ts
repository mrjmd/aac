import { createHash } from 'node:crypto';
import type { Area, ItemCandidate, Lane } from './types.js';

/** The subset of tools/src/triage Finding the adapter reads. */
export interface TriageFinding {
  id: string;
  section: string;
  severity: 'red' | 'yellow' | 'info';
  title: string;
  customer?: string;
  phone?: string;
  amount?: number;
  evidence?: string;
  detail?: string;
  action?: string;
  source: string;
  link?: string;
  /** Who it's about and when the evidence happened (triage identity.ts). */
  xref?: { phones?: string[]; emails?: string[]; evidenceAt?: string };
  /** A hard time from the thread (ISO). */
  dueAt?: string;
}

/** Detectors where the evidence time is a customer's unanswered inbound. */
const WAITING_SOURCES = new Set(['L1', 'L2', 'D6', 'D7', 'D8', 'D12', 'D15']);

const AREA_BY_SECTION: Record<string, Area> = {
  system: 'system',
  booked_gap: 'jobs',
  stub_review: 'jobs',
  offer_hold: 'jobs',
  incomplete_event: 'jobs',
  quote_promised: 'sales',
  quote_gap: 'sales',
  deal_closer: 'sales',
  stale_estimate: 'sales',
  scope_flag: 'sales',
  cash_not_invoiced: 'money',
  cash_not_sent: 'money',
  cash_overdue: 'money',
  message_draft: 'inbox',
  conversation: 'inbox',
  solicitation: 'inbox',
};

/** Automation produced it; Matt confirms (README §4.1, two lanes). */
const CONFIRM_SECTIONS = new Set(['message_draft', 'scope_flag']);

/**
 * Bridge fingerprint until detectors emit their own: the facts that mark
 * new evidence (severity, amount, the evidence line, the source link).
 * Titles, details and ages are left out because they change with time
 * ("3d old", "Overdue 123d") without anything new happening.
 */
export function triageFingerprint(f: TriageFinding): string {
  const facts = [f.severity, f.amount ?? '', f.evidence ?? '', f.link ?? ''].join('|');
  return createHash('sha256').update(facts).digest('hex').slice(0, 16);
}

export function fromTriageFinding(f: TriageFinding): ItemCandidate {
  const area = AREA_BY_SECTION[f.section] ?? 'inbox';
  const lane: Lane = CONFIRM_SECTIONS.has(f.section) ? 'confirm' : 'needs-you';
  const candidate: ItemCandidate = {
    key: f.id,
    detector: f.source,
    area,
    lane,
    severity: f.severity,
    title: f.title,
    fingerprint: triageFingerprint(f),
  };
  if (f.customer) candidate.customer = f.customer;
  if (f.phone) candidate.phone = f.phone;
  if (f.amount !== undefined) candidate.amount = f.amount;
  if (f.detail) candidate.detail = f.detail;
  if (f.action) candidate.action = f.action;
  if (f.evidence) candidate.evidence = f.evidence;
  if (f.link) candidate.link = f.link;
  if (area === 'money') candidate.sensitive = 'money';
  if (f.dueAt) candidate.dueAt = f.dueAt;
  if (f.section === 'solicitation') candidate.solicitation = true;
  else if (WAITING_SOURCES.has(f.source) && f.xref?.evidenceAt) candidate.waitingSince = f.xref.evidenceAt;
  if (f.xref?.phones?.length || f.xref?.emails?.length) {
    candidate.who = {
      ...(f.xref.phones?.length ? { phones: f.xref.phones } : {}),
      ...(f.xref.emails?.length ? { emails: f.xref.emails } : {}),
    };
  }
  return candidate;
}
