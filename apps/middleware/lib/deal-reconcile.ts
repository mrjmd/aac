import { createLogger } from '@aac/shared-utils/logger';
import type {
  PipedriveClient,
  PipedriveDeal,
  DealStage,
} from '@aac/api-clients/pipedrive';
import type {
  QuickBooksClient,
  QBEstimate,
  QBInvoice,
} from '@aac/api-clients/quickbooks';
import { isStageAdvance, isoDateDaysAgo } from './cron.js';

const log = createLogger('deal-reconcile');

export interface ReconcileSummary {
  estimates: {
    scanned: number;
    dealsCreated: number;
    stagesAdvanced: number;
    skippedNoMapping: number;
    skippedTerminal: number;
  };
  invoices: {
    scanned: number;
    dealsCreated: number;
    stagesAdvanced: number;
    invoicesLinked: number;
    skippedNoMapping: number;
  };
}

export interface ReconcileDeps {
  pipedrive: PipedriveClient;
  quickbooks: QuickBooksClient;
  /**
   * Resolve a QB Customer.Id to a PD Person.Id (string form, as stored in
   * Redis). Returns null when no mapping exists — the cron skips those
   * records rather than creating orphan deals.
   */
  resolvePdPersonId: (qbCustomerId: string) => Promise<string | null>;
}

/**
 * Map a QB Estimate's TxnStatus to the deal stage it implies.
 * Returns null for terminal/irrelevant statuses (Rejected, Closed) so the
 * cron skips them — those estimates shouldn't auto-create deals, and any
 * existing deal already in a later stage shouldn't get touched.
 */
export function estimateStatusToStage(
  status: QBEstimate['TxnStatus'],
): DealStage | null {
  switch (status) {
    case 'Accepted':
    case 'Converted':
      return 'quote_accepted';
    case 'Pending':
    case undefined:
      return 'quote_sent';
    case 'Rejected':
    case 'Closed':
      return null;
    default:
      return null;
  }
}

/**
 * Find the deal that an invoice should attach to. Tries the direct
 * `qb-inv-{id}` external_id first, then falls back to the linked estimate's
 * `qb-est-{id}` external_id. Returns null if neither exists.
 */
async function findDealForInvoice(
  pipedrive: PipedriveClient,
  invoice: QBInvoice,
): Promise<PipedriveDeal | null> {
  const direct = await pipedrive.findDealByExternalId(`qb-inv-${invoice.Id}`);
  if (direct) return direct;

  const linkedEstimateId = invoice.LinkedTxn?.find(
    (t) => t.TxnType === 'Estimate',
  )?.TxnId;
  if (!linkedEstimateId) return null;

  return pipedrive.findDealByExternalId(`qb-est-${linkedEstimateId}`);
}

/**
 * Phase 1: walk recent QB estimates, find or create the matching deal,
 * advance the stage when QB shows it further along than PD does.
 */
async function reconcileEstimates(
  deps: ReconcileDeps,
  estimates: QBEstimate[],
): Promise<ReconcileSummary['estimates']> {
  const out: ReconcileSummary['estimates'] = {
    scanned: estimates.length,
    dealsCreated: 0,
    stagesAdvanced: 0,
    skippedNoMapping: 0,
    skippedTerminal: 0,
  };

  for (const est of estimates) {
    const customerId = est.CustomerRef?.value;
    if (!customerId) continue;

    const targetStage = estimateStatusToStage(est.TxnStatus);
    if (!targetStage) {
      out.skippedTerminal += 1;
      continue;
    }

    const externalId = `qb-est-${est.Id}`;
    const existing = await deps.pipedrive.findDealByExternalId(externalId);

    if (existing) {
      if (isStageAdvance(existing.stage, targetStage)) {
        await deps.pipedrive.setDealStage(existing.id, targetStage);
        out.stagesAdvanced += 1;
        log.info('Advanced deal stage from estimate', {
          dealId: existing.id,
          from: existing.stage,
          to: targetStage,
          estimateId: est.Id,
        });
      }
      continue;
    }

    const pdPersonIdRaw = await deps.resolvePdPersonId(customerId);
    if (!pdPersonIdRaw) {
      out.skippedNoMapping += 1;
      log.warn('No PD mapping for QB customer; estimate skipped', {
        qbCustomerId: customerId,
        estimateId: est.Id,
      });
      continue;
    }

    const personId = parseInt(pdPersonIdRaw, 10);
    const title = `Quote ${est.DocNumber ?? est.Id}`;
    await deps.pipedrive.createDeal({
      title,
      personId,
      stage: targetStage,
      qbEstimateId: est.Id,
      externalId,
    });
    out.dealsCreated += 1;
    log.info('Created deal from estimate', {
      personId,
      estimateId: est.Id,
      stage: targetStage,
    });
  }

  return out;
}

/**
 * Phase 2: walk recent QB invoices, link them to their deal (or create one
 * when absent), advance Paid when Balance reaches zero.
 */
async function reconcileInvoices(
  deps: ReconcileDeps,
  invoices: QBInvoice[],
): Promise<ReconcileSummary['invoices']> {
  const out: ReconcileSummary['invoices'] = {
    scanned: invoices.length,
    dealsCreated: 0,
    stagesAdvanced: 0,
    invoicesLinked: 0,
    skippedNoMapping: 0,
  };

  for (const inv of invoices) {
    const customerId = inv.CustomerRef?.value;
    if (!customerId) continue;

    const isPaid = (inv.Balance ?? 0) === 0;
    const deal = await findDealForInvoice(deps.pipedrive, inv);

    if (deal) {
      if (!deal.qbInvoiceId) {
        await deps.pipedrive.updateDeal(deal.id, { qbInvoiceId: inv.Id });
        out.invoicesLinked += 1;
        log.info('Linked invoice to existing deal', {
          dealId: deal.id,
          invoiceId: inv.Id,
        });
      }

      if (isPaid && isStageAdvance(deal.stage, 'paid')) {
        await deps.pipedrive.setDealStage(deal.id, 'paid');
        out.stagesAdvanced += 1;
        log.info('Advanced deal to Paid', { dealId: deal.id, invoiceId: inv.Id });
      }
      continue;
    }

    // No deal anywhere — create one (rare; would mean an invoice was issued
    // without an estimate, e.g. for warranty work or a courtesy charge).
    const pdPersonIdRaw = await deps.resolvePdPersonId(customerId);
    if (!pdPersonIdRaw) {
      out.skippedNoMapping += 1;
      log.warn('No PD mapping for QB customer; invoice skipped', {
        qbCustomerId: customerId,
        invoiceId: inv.Id,
      });
      continue;
    }

    const personId = parseInt(pdPersonIdRaw, 10);
    const targetStage: DealStage = isPaid ? 'paid' : 'job_done';
    const title = `Invoice ${inv.DocNumber ?? inv.Id}`;
    await deps.pipedrive.createDeal({
      title,
      personId,
      stage: targetStage,
      qbInvoiceId: inv.Id,
      externalId: `qb-inv-${inv.Id}`,
    });
    out.dealsCreated += 1;
    log.info('Created deal from invoice', {
      personId,
      invoiceId: inv.Id,
      stage: targetStage,
    });
  }

  return out;
}

/**
 * Reconcile QB → PD deal state. Idempotent: runs daily, replays the last
 * `windowDays` worth of QB activity, and converges PD deal state. Catches
 * anything the deterministic write paths (webhooks, marker-aware crons)
 * missed.
 *
 * `windowDays` defaults to 7. Tightening trades catch-up reach for shorter
 * function runtime — Vercel's 30s default is enough for ~200 records.
 */
export async function reconcileDeals(
  deps: ReconcileDeps,
  windowDays = 7,
): Promise<ReconcileSummary> {
  const since = isoDateDaysAgo(windowDays);
  log.info('Starting deal reconcile', { since, windowDays });

  const [estimates, invoices] = await Promise.all([
    deps.quickbooks.listRecentEstimates(since),
    deps.quickbooks.listRecentInvoices(since),
  ]);

  const estimatesSummary = await reconcileEstimates(deps, estimates);
  const invoicesSummary = await reconcileInvoices(deps, invoices);

  log.info('Reconcile complete', {
    estimates: estimatesSummary,
    invoices: invoicesSummary,
  });

  return { estimates: estimatesSummary, invoices: invoicesSummary };
}
