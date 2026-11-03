# Booking ↔ QBO Acceptance Sync (+ stub/HOLD cleanup)

Status: NEEDED, not started. Owner flagged as important automation 2026-11-03.

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

## Related: stub creation doesn't remove the customer's HOLD

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

Triage (tools/src/triage/identity.ts, 2026-11-03) now merges customer
identities and flags booked customers whose estimates are still Pending.

## Command center impact

The command center's quote/deal views should treat "booked on the calendar"
as closed even when QBO says Pending, until this sync ships, and should reuse
the same identity merge (phones, emails, company, names) rather than building
a second one.
