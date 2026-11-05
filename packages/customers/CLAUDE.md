# @aac/customers — who is this customer, and what has happened with them

One definition of customer identity and the customer timeline, shared by the
triage detectors (`tools/src/triage/identity.ts`), the command center
Customer page, and (planned) scheduling's hold matching.

- `match.ts`: pure name/address matching (`nameTokens`, `tokensAlike`,
  `eventMatchesName`, `nameCorroborated`). Calendar titles are typed by ear, so
  matching tolerates one-letter drift; addresses join on house number +
  street name + unit (`@aac/shared-utils/address`).
- `timeline.ts`: pure `buildCustomerTimeline` (QBO estimates/invoices/
  payments, Quo texts/calls, Gmail, calendar visits → one sorted list with
  totals) and a thin `getCustomerTimeline` that fetches through
  `@aac/api-clients`. Every calendar match says why it matched (address,
  phone, or name) so a loose name match is visible as one.
- No `process.env` here; callers construct the clients.
