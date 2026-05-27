'use client';

import { useMemo, useState, useTransition } from 'react';
import { createBankDeposit, type CreateDepositResult } from './actions';
import type { UndepositedPayment } from '@/lib/bank';

interface BankAccountOption {
  id: string;
  name: string;
  currentBalance?: number;
}

interface Props {
  payments: UndepositedPayment[];
  bankAccounts: BankAccountOption[];
}

export default function DepositForm({ payments, bankAccounts }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bankAccountId, setBankAccountId] = useState<string>(bankAccounts[0]?.id ?? '');
  const [result, setResult] = useState<CreateDepositResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedTotal = useMemo(() => {
    let s = 0;
    for (const p of payments) if (selected.has(p.id)) s += p.amount;
    return s;
  }, [payments, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(payments.map((p) => p.id)));
  }
  function clearAll() {
    setSelected(new Set());
  }

  function submit() {
    if (selected.size === 0 || !bankAccountId || isPending) return;
    const acctName = bankAccounts.find((a) => a.id === bankAccountId)?.name ?? '(unknown bank)';
    const ok = window.confirm(
      `Create a QuickBooks deposit of $${selectedTotal.toFixed(2)} across ${selected.size} payment${
        selected.size === 1 ? '' : 's'
      } into ${acctName}?\n\nThis should match the deposit slip you give the teller.`,
    );
    if (!ok) return;
    const fd = new FormData();
    fd.set('bankAccountId', bankAccountId);
    for (const id of selected) fd.append('paymentId', id);
    setResult(null);
    startTransition(async () => {
      const r = await createBankDeposit(fd);
      setResult(r);
      if (r.ok) setSelected(new Set());
    });
  }

  if (payments.length === 0) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 px-4 py-6 text-center text-sm text-green-800">
        Nothing in Undeposited Funds. You&apos;re all caught up.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {result?.ok ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          ✓ Deposit created (#{result.depositId}) — ${result.total?.toFixed(2)} across {result.count} payment
          {result.count === 1 ? '' : 's'}. Match this against your physical deposit slip.
        </div>
      ) : null}
      {result && !result.ok ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {result.error}
        </div>
      ) : null}

      <div className="flex items-center justify-between text-sm">
        <div className="text-gray-600">
          {payments.length} payment{payments.length === 1 ? '' : 's'} undeposited
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={selectAll} className="text-aac-blue underline-offset-2 hover:underline">
            Select all
          </button>
          <button type="button" onClick={clearAll} className="text-gray-600 underline-offset-2 hover:underline">
            Clear
          </button>
        </div>
      </div>

      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
        {payments.map((p) => {
          const isSelected = selected.has(p.id);
          return (
            <li key={p.id}>
              <label
                className={`flex cursor-pointer items-start gap-3 px-4 py-3 ${
                  isSelected ? 'bg-aac-blue/5' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(p.id)}
                  className="mt-1 h-5 w-5 rounded border-gray-300"
                />
                <div className="flex-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium text-gray-900">{p.customerName}</span>
                    <span className="font-semibold tabular-nums text-gray-900">
                      ${p.amount.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5">{p.method}</span>
                    {p.refNum ? <span>Check #{p.refNum}</span> : null}
                    <span className="ml-auto">{p.date}</span>
                  </div>
                </div>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="sticky bottom-0 -mx-4 border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-4px_8px_rgba(0,0,0,0.04)]">
        {bankAccounts.length > 1 ? (
          <div className="mb-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
              Deposit to
            </label>
            <select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="mb-3 text-xs text-gray-500">
            Depositing to: <span className="font-medium text-gray-700">{bankAccounts[0]?.name ?? '—'}</span>
          </div>
        )}

        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm text-gray-600">
            {selected.size} selected
          </span>
          <span className="text-xl font-semibold tabular-nums text-gray-900">
            ${selectedTotal.toFixed(2)}
          </span>
        </div>

        <button
          type="button"
          disabled={selected.size === 0 || !bankAccountId || isPending}
          onClick={submit}
          className="w-full rounded-md bg-aac-blue px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {isPending ? 'Creating deposit…' : 'Create deposit'}
        </button>
      </div>
    </div>
  );
}
