/**
 * Open-quote index (T4 scope-change detection, 2026-10-29): which phones
 * have a Pending estimate right now, and whether the bot still owns it.
 * One HGET answers "should the gate even run for this inbound?".
 *
 * Written here at create/regenerate; adds/removals/ownership refresh for
 * estimates the bot never touched happen in middleware's qb-reconcile
 * cron. The index is advisory — draftOne re-verifies ownership against
 * live QBO before any write, so a stale entry costs one skipped job.
 */
import type { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { quickNormalizePhone } from '@aac/shared-utils/phone';
import type { OpenQuoteEntry } from '@aac/shared-utils/types';
import type { QBEstimate } from '@aac/api-clients/quickbooks';
import { INTERNAL, type DrafterDeps } from './types.js';

export async function getOpenQuote(redis: Redis, phone: string): Promise<OpenQuoteEntry | null> {
  const raw = await redis.hget<OpenQuoteEntry | string>(keys.quoteDraftOpen, phone);
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as OpenQuoteEntry) : raw;
}

export async function upsertOpenQuote(
  redis: Redis,
  phone: string,
  entry: OpenQuoteEntry,
): Promise<void> {
  await redis.hset(keys.quoteDraftOpen, { [phone]: JSON.stringify(entry) });
}

export async function removeOpenQuote(redis: Redis, phone: string): Promise<void> {
  await redis.hdel(keys.quoteDraftOpen, phone);
}

export async function listOpenQuotes(redis: Redis): Promise<Map<string, OpenQuoteEntry>> {
  const all = ((await redis.hgetall(keys.quoteDraftOpen)) ?? {}) as Record<
    string,
    OpenQuoteEntry | string
  >;
  const out = new Map<string, OpenQuoteEntry>();
  for (const [phone, raw] of Object.entries(all)) {
    out.set(phone, typeof raw === 'string' ? (JSON.parse(raw) as OpenQuoteEntry) : raw);
  }
  return out;
}

/** Compact "item ×qty @ $price" summary for gate prompts and flag notes. */
export function summarizeLines(
  lines: Array<{ item: string; qty: number; unitPrice: number }>,
): string {
  return lines.map((l) => `${l.item} ×${l.qty} @ $${l.unitPrice}`).join('; ');
}

function summarizeEstimateLines(e: QBEstimate): string {
  return summarizeLines(
    (e.Line ?? [])
      .filter((l) => l.SalesItemLineDetail?.ItemRef?.name)
      .map((l) => ({
        item: l.SalesItemLineDetail!.ItemRef!.name!,
        qty: l.SalesItemLineDetail?.Qty ?? 1,
        unitPrice: l.SalesItemLineDetail?.UnitPrice ?? 0,
      })),
  );
}

/** Rebuild at most this often; callers invoke every tick and this gates itself. */
export const OPEN_QUOTE_SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** Pending quotes stay open for weeks (stale-quote program) — look well back. */
const OPEN_QUOTE_WINDOW_DAYS = 90;
/** Never remove an entry written in the last hour — it may be a drafter
 *  create that raced the QBO list query. */
const FRESH_ENTRY_GRACE_MS = 60 * 60 * 1000;

/**
 * Full index rebuild from QBO: every Pending estimate in the window —
 * bot-created or not — becomes an entry (phone → newest Pending), with
 * ownership refreshed from the stored SyncToken fingerprint. Phones come
 * from the customer record; entries whose estimate left Pending are
 * removed. Self-gates to one run per OPEN_QUOTE_SYNC_INTERVAL_MS; pass
 * force to override. Returns null when gated.
 */
export async function syncOpenQuoteIndex(
  deps: Pick<DrafterDeps, 'redis' | 'qb' | 'log' | 'now'>,
  opts?: { force?: boolean },
): Promise<{ indexed: number; removed: number } | null> {
  const { redis, qb, log } = deps;
  const now = deps.now();
  if (!opts?.force) {
    const last = await redis.get<string>(keys.quoteDraftOpenSyncedAt);
    if (last && now - new Date(last).getTime() < OPEN_QUOTE_SYNC_INTERVAL_MS) return null;
  }
  await redis.set(keys.quoteDraftOpenSyncedAt, new Date(now).toISOString());

  const since = new Date(now - OPEN_QUOTE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const pending = (await qb.listRecentEstimates(since)).filter((e) => e.TxnStatus === 'Pending');

  const byCustomer = new Map<string, { phones: string[]; email: string | null; name: string }>();
  if (pending.length) {
    for (const c of await qb.listAllCustomers()) {
      if (!c.Id) continue;
      byCustomer.set(c.Id, {
        phones: [c.PrimaryPhone, c.Mobile, c.AlternatePhone]
          .map((p) => quickNormalizePhone(p?.FreeFormNumber))
          .filter((p): p is string => !!p),
        email: c.PrimaryEmailAddr?.Address ?? null,
        name: c.DisplayName,
      });
    }
  }

  const desired = new Map<string, { entry: OpenQuoteEntry; txnDate: string }>();
  for (const e of pending) {
    const customer = byCustomer.get(e.CustomerRef.value);
    const phone = customer?.phones.find((p) => !INTERNAL.has(p));
    if (!phone) continue;
    const txnDate = e.TxnDate ?? '';
    const current = desired.get(phone);
    if (current && current.txnDate >= txnDate) continue;
    const stored = await redis.get(keys.quoteDraftSyncToken(e.Id));
    desired.set(phone, {
      txnDate,
      entry: {
        estimateId: e.Id,
        docNumber: e.DocNumber ?? '',
        customerId: e.CustomerRef.value,
        customer: customer?.name ?? e.CustomerRef.name ?? '',
        email: e.BillEmail?.Address ?? customer?.email ?? null,
        total: e.TotalAmt ?? 0,
        linesSummary: summarizeEstimateLines(e),
        botOwned: stored !== null && stored !== undefined && String(stored) === String(e.SyncToken),
        updatedAt: new Date(now).toISOString(),
      },
    });
  }

  const existing = await listOpenQuotes(redis);
  for (const [phone, { entry }] of desired) {
    await upsertOpenQuote(redis, phone, entry);
  }
  let removed = 0;
  for (const [phone, entry] of existing) {
    if (desired.has(phone)) continue;
    if (now - new Date(entry.updatedAt).getTime() < FRESH_ENTRY_GRACE_MS) continue;
    await removeOpenQuote(redis, phone);
    removed++;
  }
  log(`open-quote index: ${desired.size} open quote(s), ${removed} removed`);
  return { indexed: desired.size, removed };
}
