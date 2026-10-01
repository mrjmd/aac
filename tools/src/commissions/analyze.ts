#!/usr/bin/env npx tsx
/**
 * Ed commission report — attribution + commission calc.
 *
 * Attribution closure: a person is Ed-attributed if
 *   - Referred by = Edward Crowell (person 5225), or
 *   - Referred by = an already-attributed person (chain), or
 *   - owned by the Edward Crowell PD user.
 * Each attributed person maps to one or more QBO customers: the PD QB
 * Customer ID field plus any manual-links.json entries (a link's
 * effectiveFrom date excludes that customer's older transactions).
 *
 * Buckets:
 *   events          — invoices PAID IN FULL → commission earned
 *                     (paidToEd = already in ledger.json, i.e. paid out via payroll)
 *   pendingInvoices — invoiced, customer hasn't paid → commission on its way
 *   openEstimates   — quote outstanding (Pending/Accepted) → commission if it closes
 *
 * Reads snapshot.json + ledger.json + manual-links.json, writes findings.json.
 * `--commit` records every currently-owed commission as paid to Ed.
 */
import {
  readJson, writeJson, ED_PERSON_ID, ED_USER_ID, EXCLUDE_PERSON_IDS,
  COMMISSION_RATE, SNAPSHOT_PATH, FINDINGS_PATH, LEDGER_PATH, MANUAL_LINKS_PATH,
  type Snapshot, type Findings, type CommissionEvent, type PendingInvoice,
  type OpenEstimate, type LedgerEntry, type ManualLink,
} from './lib';

const OPEN_ESTIMATE_STATUSES = new Set(['Pending', 'Accepted']);

function buildFindings(snapshot: Snapshot, ledger: LedgerEntry[], manualLinks: ManualLink[]): Findings {
  const byId = new Map(snapshot.persons.map((p) => [p.id, p]));

  // attribution closure
  const attributed = new Map<number, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of snapshot.persons) {
      if (attributed.has(p.id) || p.id === ED_PERSON_ID || EXCLUDE_PERSON_IDS.has(p.id)) continue;
      let reason: string | null = null;
      if (p.referredById === ED_PERSON_ID) {
        reason = 'Referred by Ed';
      } else if (p.referredById != null && attributed.has(p.referredById)) {
        reason = `Referred by ${byId.get(p.referredById)?.name ?? p.referredByName ?? p.referredById} (Ed chain)`;
      } else if (p.ownerId === ED_USER_ID) {
        reason = 'Contact owned by Ed';
      }
      if (reason) {
        attributed.set(p.id, reason);
        changed = true;
      }
    }
  }

  // person -> [{qbCustomerId, effectiveFrom?}]
  const qbLinks = new Map<number, Array<{ qbCustomerId: string; effectiveFrom?: string }>>();
  for (const [pid] of attributed) {
    const p = byId.get(pid)!;
    if (p.qbCustomerId) qbLinks.set(pid, [{ qbCustomerId: p.qbCustomerId }]);
  }
  for (const link of manualLinks) {
    if (!attributed.has(link.personId)) continue;
    const list = qbLinks.get(link.personId) ?? [];
    if (!list.some((l) => l.qbCustomerId === link.qbCustomerId)) {
      list.push({ qbCustomerId: link.qbCustomerId, effectiveFrom: link.effectiveFrom });
    }
    qbLinks.set(link.personId, list);
  }

  // payments: invoice txn id -> payment dates
  const payDatesByInvoice = new Map<string, string[]>();
  for (const pay of snapshot.payments) {
    const lines = (pay.Line as Array<Record<string, any>> | undefined) ?? [];
    for (const line of lines) {
      for (const lt of (line.LinkedTxn as Array<Record<string, any>> | undefined) ?? []) {
        if (lt.TxnType === 'Invoice') {
          const list = payDatesByInvoice.get(String(lt.TxnId)) ?? [];
          list.push(String(pay.TxnDate ?? ''));
          payDatesByInvoice.set(String(lt.TxnId), list);
        }
      }
    }
  }

  const invoicesByCustomer = new Map<string, Array<Record<string, any>>>();
  for (const inv of snapshot.invoices) {
    const cust = String((inv.CustomerRef as Record<string, any> | undefined)?.value ?? '');
    if (!cust) continue;
    const list = invoicesByCustomer.get(cust) ?? [];
    list.push(inv);
    invoicesByCustomer.set(cust, list);
  }

  const estimatesByCustomer = new Map<string, Array<Record<string, any>>>();
  for (const est of snapshot.estimates ?? []) {
    const cust = String((est.CustomerRef as Record<string, any> | undefined)?.value ?? '');
    if (!cust) continue;
    const list = estimatesByCustomer.get(cust) ?? [];
    list.push(est);
    estimatesByCustomer.set(cust, list);
  }

  const paidOut = new Set(ledger.map((e) => e.invoiceId));
  const commission = (amount: number): number => Math.round(amount * COMMISSION_RATE * 100) / 100;

  const events: CommissionEvent[] = [];
  const pendingInvoices: PendingInvoice[] = [];
  const openEstimates: OpenEstimate[] = [];

  for (const [pid, links] of qbLinks) {
    const p = byId.get(pid)!;
    const reason = attributed.get(pid)!;
    for (const { qbCustomerId, effectiveFrom } of links) {
      for (const inv of invoicesByCustomer.get(qbCustomerId) ?? []) {
        const txnDate = String(inv.TxnDate ?? '');
        if (effectiveFrom && txnDate < effectiveFrom) continue;
        const amount = Number(inv.TotalAmt ?? 0);
        if (Number(inv.Balance) === 0) {
          const payDates = payDatesByInvoice.get(String(inv.Id)) ?? [];
          events.push({
            personId: pid,
            personName: p.name,
            reason,
            qbCustomerId,
            invoiceId: String(inv.Id),
            invoiceDocNumber: String(inv.DocNumber ?? inv.Id),
            invoiceDate: txnDate,
            invoiceAmount: amount,
            paidDate: payDates.length ? payDates.sort().at(-1)! : txnDate,
            commission: commission(amount),
            paidToEd: paidOut.has(String(inv.Id)),
          });
        } else {
          pendingInvoices.push({
            personId: pid,
            personName: p.name,
            reason,
            invoiceDocNumber: String(inv.DocNumber ?? inv.Id),
            invoiceDate: txnDate,
            amount,
            balance: Number(inv.Balance),
            commission: commission(amount),
          });
        }
      }
      for (const est of estimatesByCustomer.get(qbCustomerId) ?? []) {
        const status = String(est.TxnStatus ?? '');
        if (!OPEN_ESTIMATE_STATUSES.has(status)) continue;
        const txnDate = String(est.TxnDate ?? '');
        if (effectiveFrom && txnDate < effectiveFrom) continue;
        const amount = Number(est.TotalAmt ?? 0);
        openEstimates.push({
          personId: pid,
          personName: p.name,
          reason,
          estimateDocNumber: String(est.DocNumber ?? est.Id),
          estimateDate: txnDate,
          status,
          amount,
          commission: commission(amount),
        });
      }
    }
  }

  events.sort((a, b) => a.paidDate.localeCompare(b.paidDate));
  pendingInvoices.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
  openEstimates.sort((a, b) => a.estimateDate.localeCompare(b.estimateDate));

  return {
    runAt: snapshot.runAt,
    rate: COMMISSION_RATE,
    attributedCount: attributed.size,
    events,
    pendingInvoices,
    openEstimates,
    roster: [...attributed].map(([personId, reason]) => ({
      personId, personName: byId.get(personId)!.name, reason,
    })).sort((a, b) => a.personName.localeCompare(b.personName)),
  };
}

function main(): void {
  const snapshot = readJson<Snapshot | null>(SNAPSHOT_PATH, null);
  if (!snapshot) throw new Error(`No snapshot at ${SNAPSHOT_PATH} — run collect.ts first`);
  const ledger = readJson<LedgerEntry[]>(LEDGER_PATH, []);
  const manualLinks = readJson<ManualLink[]>(MANUAL_LINKS_PATH, []);

  const findings = buildFindings(snapshot, ledger, manualLinks);
  writeJson(FINDINGS_PATH, findings);

  const owed = findings.events.filter((e) => !e.paidToEd);
  const owedTotal = owed.reduce((s, e) => s + e.commission, 0);
  console.log(`Attributed persons: ${findings.attributedCount}`);
  console.log(`Commissions earned: ${findings.events.length} (${owed.length} owed, $${owedTotal.toFixed(2)})`);
  console.log(`Pending invoices: ${findings.pendingInvoices.length}, open estimates: ${findings.openEstimates.length}`);
  console.log(`Findings -> ${FINDINGS_PATH}`);

  if (process.argv.includes('--commit')) {
    const now = new Date().toISOString();
    for (const e of owed) {
      ledger.push({
        invoiceId: e.invoiceId,
        invoiceDocNumber: e.invoiceDocNumber,
        personName: e.personName,
        invoiceAmount: e.invoiceAmount,
        commission: e.commission,
        paidDate: e.paidDate,
        paidAt: now,
      });
    }
    writeJson(LEDGER_PATH, ledger);
    console.log(`Committed ${owed.length} commissions as paid to Ed -> ${LEDGER_PATH}`);
  }
}

main();
