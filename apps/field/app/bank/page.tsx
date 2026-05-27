import Link from 'next/link';
import { getBankAccounts, getUndepositedPayments } from '@/lib/bank';
import DepositForm from './deposit-form';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function BankPage() {
  const [payments, bankAccounts] = await Promise.all([
    getUndepositedPayments(),
    getBankAccounts(),
  ]);

  const total = payments.reduce((s, p) => s + p.amount, 0);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-4 pb-32">
      <div className="mb-4">
        <Link href="/" className="text-sm text-aac-blue underline-offset-2 hover:underline">
          ← Back to jobs
        </Link>
      </div>

      <header className="mb-4">
        <h1 className="text-2xl font-semibold text-gray-900">At the bank</h1>
        <p className="mt-1 text-sm text-gray-600">
          Check which cash and check payments you&apos;re depositing right now. App creates a QuickBooks
          deposit that matches what you give the teller — that&apos;s what bookkeeping reconciles against the
          bank statement later.
        </p>
        {payments.length > 0 ? (
          <p className="mt-2 text-xs text-gray-500">
            Undeposited Funds total: ${total.toFixed(2)}
          </p>
        ) : null}
      </header>

      {bankAccounts.length === 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          No active bank accounts found in QuickBooks. Add one before depositing.
        </div>
      ) : (
        <DepositForm
          payments={payments}
          bankAccounts={bankAccounts.map((a) => ({
            id: a.Id,
            name: a.Name,
            currentBalance: a.CurrentBalance,
          }))}
        />
      )}
    </main>
  );
}
