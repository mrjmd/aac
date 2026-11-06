/**
 * @aac/payments — job payment handling against QuickBooks.
 *
 * Moved from apps/field/lib (payment-branches.ts, bank.ts). Callers
 * construct the clients and pass them in; nothing here reads env.
 *
 * Called from:
 *   - apps/field  Mark Complete server action (executePaymentBranch)
 *   - apps/field  "At the bank" page + deposit action (getUndepositedPayments, getBankAccounts)
 */

export * from './types.js';
export * from './payment-branches.js';
export * from './bank.js';
