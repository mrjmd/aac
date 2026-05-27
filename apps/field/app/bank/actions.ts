'use server';

import { revalidatePath } from 'next/cache';
import { getQuickBooks } from '@/lib/clients';
import { getUndepositedPayments } from '@/lib/bank';
import { getCurrentSession } from '@/lib/session';
import { createLogger } from '@aac/shared-utils/logger';

const log = createLogger('field:bank-actions');

export interface CreateDepositResult {
  ok: boolean;
  error?: string;
  depositId?: string;
  total?: number;
  count?: number;
}

/**
 * Creates a QB Deposit that pulls the selected Payments out of Undeposited
 * Funds into the chosen bank account. Re-fetches the payments server-side
 * (rather than trusting the client-posted amounts) so a stale browser tab
 * can't manufacture a Deposit Mike didn't intend.
 */
export async function createBankDeposit(formData: FormData): Promise<CreateDepositResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, error: 'Signed out — please log in again.' };

  const bankAccountId = String(formData.get('bankAccountId') || '');
  const selected = formData.getAll('paymentId').map(String).filter(Boolean);

  if (!bankAccountId) return { ok: false, error: 'Pick a bank account first.' };
  if (selected.length === 0) return { ok: false, error: 'Select at least one payment to deposit.' };

  // Re-fetch the truth from QB instead of trusting client-side amounts.
  const undeposited = await getUndepositedPayments();
  const byId = new Map(undeposited.map((p) => [p.id, p]));

  const lines: Array<{ paymentId: string; amount: number }> = [];
  const missing: string[] = [];
  for (const id of selected) {
    const p = byId.get(id);
    if (!p) {
      missing.push(id);
    } else {
      lines.push({ paymentId: id, amount: p.amount });
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `${missing.length} of the selected payment(s) are no longer undeposited — refresh the list and try again.`,
    };
  }

  try {
    const qb = getQuickBooks();
    const deposit = await qb.createDeposit({
      depositToAccountId: bankAccountId,
      payments: lines,
    });
    log.info('Created deposit', {
      depositId: deposit.Id,
      total: deposit.TotalAmt,
      count: lines.length,
      bankAccountId,
      by: session.email,
    });
    revalidatePath('/bank');
    return {
      ok: true,
      depositId: deposit.Id,
      total: deposit.TotalAmt,
      count: lines.length,
    };
  } catch (err) {
    log.error('Deposit creation failed', err as Error, { bankAccountId, count: lines.length });
    return {
      ok: false,
      error: `QuickBooks rejected the deposit: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
