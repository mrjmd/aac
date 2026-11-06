# Booking ↔ QBO Acceptance Sync (+ stub/HOLD cleanup)

Status: BUILT 2026-11-05 (sync + webhook guard + HOLD cleanup).
Owner flagged as important automation 2026-11-03.

## What shipped (2026-11-05)

- `@aac/scheduling` `booking-sync.ts`: pure `customersForBooking` (phone /
  email / address / strict name, hub-guarded) + `decideBooking` (quotes
  dated ≤180d before the event; any Accepted → covered; exactly one Pending
  → accept; unsent bot drafts never count; otherwise none/ambiguous) +
  `syncBookedEstimates` orchestrator. Accepting stamps the handled marker
  first, then flips Accepted and prepends the evidence to PrivateNote.
- Runs inside the middleware `qb-reconcile` cron (every 30 min) on the
  calendar events it already fetches. Outcomes in
  `keys.bookingSyncEvent` (final: accepted/covered; none/ambiguous expire 24h).
- `qb-webhook` now has the same already-booked guard as qb-reconcile
  (`lib/booked-events.ts`): an Accepted flip for a booked customer makes no
  directive and no slots note (outcome `booked`).
- Live dry run 11/05 (local scratch script `booking-sync-dry.ts`): 25 green
  jobs, 23 covered, 2 none (Dacey; Champion's quote is under the company
  address), 0 false flips.
- Not done: step 1's stub-time call (the 30-min cron covers it).

## Problem

Acceptance only flows one way. `apps/middleware/api/cron/qb-reconcile.ts`
reads QBO and turns Accepted estimates into scheduling directives. Nothing
flows back: when a customer approves by email, phone or text, or Matt books
them directly, the QBO estimate stays **Pending**.

Seen 2026-11-03: #1577 (Champion Builders, signed estimate emailed back by
Sarah Dacey) and #1580 (Artie Downey, booked by phone) both sat Pending while
booked on the calendar. Marked Accepted by hand.

Consequences:
- `invoice-create` cron needs an Accepted estimate on job day; a Pending one
  returns `skipped_no_accepted_estimate` with **no alert**, so the job is
  silently not auto-invoiced.
- Triage, stale-quote follow-ups and the command center all read estimate
  status, so booked customers show as open quotes.

## Proposed fix

1. When a green job or STUB event is created (packages/scheduling
   `execute-stub.ts`) or detected for a customer, resolve their QBO estimates
   by phone (`QuickBooksClient.findCustomerByPhone`). Exactly one Pending
   estimate → mark Accepted (`updateEstimateStatus`), log the source
   (`booking_sync`). Zero or several → flag for Matt, never guess.
2. Same check as a backstop pass in the reconcile cron (booked event in the
   next N days + Pending estimate for that customer).
3. Respect multi-source stage timestamps: record the evidence (email signature,
   call, booking) as the acceptance source rather than trusting QBO's
   AcceptedDate.

## Related: stub creation doesn't remove the customer's HOLD (FIXED 2026-11-05: `holdBelongsTo` in execute-hold.ts, used by both paths)

`executeStubEvent` (and `execute-hold.ts`) only delete HOLDs whose title
contains the exact customer-name string. Misses seen 2026-11-03:
- Joffre: HOLD "Ann Joffre" vs stub "Ann and Paul Joffre" (same phone).
- Dacey: HOLD from Tom's phone, stub from Sarah's ("Sarah"), same address.

Fix: shared `holdBelongsTo(event, {phone, name, address})` used by both:
match on the `Customer-Phone:` description line (normalized), all tokens of
the shorter name (≥2 tokens) contained in the other, or house number + street
+ unit. Switch the duplicate guard to the existing `summaryMatchesCustomer`
(a one-word "Sarah" stub currently collides with any "Sarah Tanzi" event).
Tests (execute-stub.test.ts): same-phone name variant deleted; different
phone + same address ("Unit Number 35" vs "Unit 35") deleted; same surname
different phone/address kept; "Sarah" stub beside "Sarah Tanzi" still created.

## Interim

Triage (identity.ts, 2026-11-03; now `packages/triage/src/identity.ts`) now merges customer
identities and flags booked customers whose estimates are still Pending.

## Command center impact

The command center's quote/deal views should treat "booked on the calendar"
as closed even when QBO says Pending, until this sync ships, and should reuse
the same identity merge (phones, emails, company, names) rather than building
a second one.
