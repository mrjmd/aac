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
