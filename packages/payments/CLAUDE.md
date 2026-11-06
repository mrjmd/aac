# @aac/payments — job payments against QuickBooks

The payment logic behind the field app's Mark Complete and "At the bank"
screens, moved out of `apps/field/lib` so it can be tested and reused.

- `payment-branches.ts`: `executePaymentBranch(deps, event, status)`. Event →
  PD person → QB customer (`@aac/customers`), then the branch the technician
  picked: cash/check records a QB Payment on the single open invoice; card
  verifies the most recent invoice was paid by a card method; not-yet-paid
  emails the open invoice. Business conditions (no match, several open
  invoices, no email) come back as `{ ok: false }`, never thrown.
- `bank.ts`: `getUndepositedPayments(qb)` (Undeposited Funds minus payments
  already in a Deposit) and `getBankAccounts(qb)` for the deposit screen.
- `types.ts`: `PaymentStatus`, the one definition the field app uses.

## Rules

- **No env, no client construction.** Callers pass the `@aac/api-clients`
  clients in (`apps/field/lib/clients.ts` builds them).
- **No UI and no Next.js imports.** Server actions, `revalidatePath` and
  session checks stay in the app.
- Strict TypeScript, no `any`, no `@ts-ignore`. Vitest with mocked clients.
- The messages in failures are shown to the technician verbatim; change
  them deliberately.
