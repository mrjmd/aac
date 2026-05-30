/**
 * Proposal formatting + send logic for apps/agent.
 *
 * Walk #6 mid-step: when middleware POSTs a proposal to `/api/proposals`,
 * the endpoint handler:
 *   1. Verifies the shared secret
 *   2. Stores the proposal + sets the owner's active-proposal pointer
 *      (via writeProposal in lib/redis.ts)
 *   3. Calls `sendProposalSms(...)` below to text Matt from the agent line
 *
 * This file owns the SMS body shape. Deliberately terse: one slot, one
 * line of reasoning, one tap to skim. Matt can text back "yes" / "no" /
 * anything-else (edit). The reply handler lives in lib/proposal-reply.ts.
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { ProposalPayload, StoredProposal } from '@aac/scheduling';

const log = createLogger('agent:proposals');

export interface ProposalSendDeps {
  quo: {
    sendMessage(to: string, text: string, from?: string): Promise<{ id: string }>;
  };
  agentPhoneNumber: string;
  ownerPhoneE164: string;
  /** Test seam */
  now?: () => Date;
}

/**
 * Compose the SMS body for one proposal. Format (Matt-tested in fixtures,
 * not the field yet):
 *
 *   📅 {customer} — {intent emoji label}
 *   {short scope}
 *
 *   {weekday} {date} {time-range}  ({duration})
 *   why: {one-line reasoning}
 *
 *   Reply YES to confirm, NO to skip, or any edit ("Thu 1pm").
 *
 * Calling code passes the SMS string to Quo.sendMessage. We don't emit a
 * URL or attach the whole event description — Matt can pull-check
 * command-center if he wants the full body before approving.
 */
export function formatProposalSms(payload: ProposalPayload, opts?: { fallbackBadge?: boolean }): string {
  const intentLabel = formatIntentLabel(payload.directive.intent);
  const customer = payload.directive.customerName.trim() || 'Customer';
  const scope = oneLineScope(payload.directive.scopeSummary, customer);

  const start = new Date(payload.slot.startIso);
  const end = new Date(payload.slot.endIso);
  const dayLine = formatDayLine(start, end);

  const reasoning = oneLineReasoning(payload.slot.reasoning);

  const badge = opts?.fallbackBadge || payload.descriptionUsedFallback
    ? ' (description: template fallback)'
    : '';

  const lines = [
    `📅 ${customer} — ${intentLabel}`,
    scope,
    '',
    dayLine,
    `why: ${reasoning}${badge}`,
    '',
    `Reply YES to confirm, NO to skip, or text an edit ("Thu 1pm").`,
  ];
  return lines.join('\n');
}

export async function sendProposalSms(
  proposal: StoredProposal,
  deps: ProposalSendDeps,
): Promise<string | null> {
  const body = formatProposalSms(proposal, {
    fallbackBadge: proposal.descriptionUsedFallback,
  });
  try {
    const result = await deps.quo.sendMessage(
      deps.ownerPhoneE164,
      body,
      deps.agentPhoneNumber,
    );
    log.info('Sent proposal SMS', {
      proposalId: proposal.proposalId,
      smsId: result.id,
      to: deps.ownerPhoneE164,
    });
    return result.id;
  } catch (err) {
    log.error('Failed to send proposal SMS', err as Error, {
      proposalId: proposal.proposalId,
      to: deps.ownerPhoneE164,
    });
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function formatIntentLabel(intent: ProposalPayload['directive']['intent']): string {
  switch (intent) {
    case 'quote_approved':
      return 'job';
    case 'assessment_requested':
      return 'assessment';
    case 'callback_opened':
      return 'callback';
    case 'manual_schedule':
      return 'manual';
    default:
      return intent;
  }
}

const SCOPE_MAX = 90;

function oneLineScope(scope: string, customerName: string): string {
  // Drop the "Customer Name — " prefix that QB-path scope summaries carry
  // (already in our header line) and clamp.
  let s = scope.trim();
  const prefix = `${customerName} — `;
  if (s.startsWith(prefix)) s = s.slice(prefix.length);
  s = s.replace(/\s+/g, ' ');
  if (s.length > SCOPE_MAX) s = s.slice(0, SCOPE_MAX - 1).trimEnd() + '…';
  return s || '(no scope on file)';
}

const REASONING_MAX = 90;

function oneLineReasoning(reasoning: string): string {
  const r = reasoning.replace(/\s+/g, ' ').trim();
  if (r.length > REASONING_MAX) return r.slice(0, REASONING_MAX - 1).trimEnd() + '…';
  return r;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDayLine(start: Date, end: Date): string {
  // We format in America/New_York to match Matt's local. Avoid Intl
  // formatToParts here so tests are deterministic across runners; manual
  // composition.
  const tzStart = toAmericaNewYork(start);
  const tzEnd = toAmericaNewYork(end);
  const weekday = WEEKDAYS[tzStart.weekday];
  const month = MONTHS[tzStart.month];
  const dur = (end.getTime() - start.getTime()) / 3_600_000;
  const durStr = Number.isInteger(dur) ? `${dur}h` : `${dur.toFixed(1)}h`;
  return `${weekday} ${month} ${tzStart.day}  ${formatTime(tzStart)}–${formatTime(tzEnd)} ET (${durStr})`;
}

interface NyParts {
  weekday: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const NY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function toAmericaNewYork(d: Date): NyParts {
  const parts = NY_FORMATTER.formatToParts(d);
  let weekday = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = WEEKDAY_INDEX[p.value] ?? 0;
    else if (p.type === 'month') month = MONTH_INDEX[p.value] ?? 0;
    else if (p.type === 'day') day = parseInt(p.value, 10);
    else if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  if (hour === 24) hour = 0;
  return { weekday, month, day, hour, minute };
}

function formatTime(p: NyParts): string {
  const h12 = p.hour === 0 ? 12 : p.hour > 12 ? p.hour - 12 : p.hour;
  const am = p.hour < 12 ? 'am' : 'pm';
  if (p.minute === 0) return `${h12}${am}`;
  return `${h12}:${String(p.minute).padStart(2, '0')}${am}`;
}
