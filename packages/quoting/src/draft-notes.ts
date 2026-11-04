/**
 * Conversation-panel note content for bot quote drafts (owner request
 * 2026-10-18): when the drafter creates or regenerates a draft, a note on
 * the customer's Quo contact announces it — for updates, what changed —
 * with a direct QBO link. Notes are internal (conversation panel), never
 * sent to the customer.
 */
import type { QBEstimate } from '@aac/api-clients/quickbooks';

export interface DraftNoteLine {
  item: string;
  qty: number;
  unitPrice: number;
}

/** QBO deep link straight to the estimate. */
export function qboEstimateLink(estimateId: string): string {
  return `https://app.qbo.intuit.com/app/estimate?txnId=${estimateId}`;
}

/**
 * Human-readable line diff for regenerated drafts: what the revision
 * added (+), removed (−), or changed (~) vs the previous bot draft.
 */
export function diffDraftLines(previous: QBEstimate, lines: DraftNoteLine[]): string[] {
  const prev = new Map<string, { name: string; qty: number; unitPrice: number }>();
  for (const l of previous.Line ?? []) {
    const name = l.SalesItemLineDetail?.ItemRef?.name;
    if (!name) continue;
    prev.set(name.toLowerCase(), {
      name,
      qty: l.SalesItemLineDetail?.Qty ?? 1,
      unitPrice: l.SalesItemLineDetail?.UnitPrice ?? 0,
    });
  }
  const next = new Map(lines.map((l) => [l.item.toLowerCase(), l]));
  const changes: string[] = [];
  for (const [key, l] of next) {
    const p = prev.get(key);
    if (!p) changes.push(`+ ${l.item} ×${l.qty} @ $${l.unitPrice}`);
    else if (p.qty !== l.qty || p.unitPrice !== l.unitPrice) {
      changes.push(`~ ${l.item}: ×${p.qty} @ $${p.unitPrice} → ×${l.qty} @ $${l.unitPrice}`);
    }
  }
  for (const [key, p] of prev) {
    if (!next.has(key)) changes.push(`− ${p.name} removed`);
  }
  return changes;
}

export function buildDraftCreatedNote(args: {
  docNumber: string;
  estimateId: string;
  total: number;
  confidence: string;
  needsSiteVisit: boolean;
  lines: DraftNoteLine[];
}): string {
  return [
    `🤖 Quote draft #${args.docNumber} created — $${args.total} (${args.confidence} confidence${args.needsSiteVisit ? ', site visit flagged' : ''})`,
    ...args.lines.map((l) => `• ${l.item} ×${l.qty} @ $${l.unitPrice}`),
    `Review: ${qboEstimateLink(args.estimateId)}`,
  ].join('\n');
}

/**
 * Flag note for scope-relevant new info on a quote the bot must not touch
 * (human-owned, or not bot-created). The estimate is never modified — this
 * note + the triage flag ARE the deliverable (T4, 2026-10-29).
 */
export function buildScopeFlagNote(args: {
  docNumber: string;
  estimateId: string;
  total: number;
  reason: string;
  channel: string;
}): string {
  return [
    `🤖 New info may affect quote #${args.docNumber} ($${args.total}) — via ${args.channel}:`,
    args.reason,
    `Not auto-updated (quote is human-owned). Review: ${qboEstimateLink(args.estimateId)}`,
  ].join('\n');
}

export function buildDraftUpdatedNote(args: {
  docNumber: string;
  estimateId: string;
  total: number;
  previousTotal: number;
  changes: string[];
}): string {
  return [
    `🤖 Quote draft #${args.docNumber} UPDATED — $${args.total} (was $${args.previousTotal})`,
    ...(args.changes.length ? args.changes : ['(line details revised)']),
    `Review: ${qboEstimateLink(args.estimateId)}`,
  ].join('\n');
}

/**
 * Can't-help note: the drafter found nothing AAC does in the thread, so no
 * estimate was made. Carries the reasons and the decline wording to copy
 * (owner, 2026-11-04: get out of the loop fast and kindly).
 */
export function buildDeclineNote(args: {
  asks: Array<{ request: string; reason?: string; suggestedReply?: string }>;
}): string {
  const replies = args.asks.map((a) => a.suggestedReply?.trim()).filter((r): r is string => !!r);
  return [
    `🤖 No quote drafted: this looks like work we can't help with.`,
    ...args.asks.map((a) => `• ${a.request}: ${a.reason ?? '(no reason given)'}`),
    ...(replies.length ? ['', 'Suggested reply:', [...new Set(replies)].join(' ')] : []),
  ].join('\n');
}
