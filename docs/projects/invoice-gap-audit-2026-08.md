# 🔴 CRITICAL — Invoice Gap Audit (Jun 15 – Aug 21, 2026)

**Priority: VERY HIGH.** ~\$25k of completed work never invoiced; systemic
single-point-of-failure identified. Audit run 2026-08-21 by cross-referencing
Google Calendar jobs (colorId 10) × field-app completion records (Redis
`field:completion:*`) × QBO invoices/payments/estimates.

Re-run the audit anytime: `tools/src/scratch/dump-field-completions.ts` dumps
completions; QBO data via `tools/src/analysis/pull-qbo-baseline.ts`.

## Never invoiced at all — ~\$24,750 (no invoice, no payment, ever, in QBO)

| Job date | Customer | Estimate | Field app state | Notes |
|---|---|---|---|---|
| Jun 16 | **Jill Fairweather** | \$10,300 (Closed) or \$2,800 (Pending) | no record | biggest item; ambiguous which estimate |
| Jun 25–26 | **John Forristall** | \$4,175 (Accepted) | completed → linked inv **#2439 DELETED from QBO** | ask Mike who deleted it & why |
| Jul 13 | **Shaun Milliken** | \$5,375 (Pending) | checked_in, never completed | |
| Aug 5 | Brendan O'Connor | none found | checked_in, never completed | |
| Aug 6 | Corey Banana | \$1,100 (Pending) | stuck at before_photo | |
| Aug 12 | Ray Piccinni | \$1,075 (Accepted) | no record | |
| Aug 19 | Gayle Hagen-Peter | \$1,650 (Pending) | no record | |
| Aug 21 | Konrad Kosztyla | \$1,075 (Pending) | no record | |

Caveat: some may have paid cash/check that was deposited without attribution —
no matching QBO deposits found, but unlabeled check deposits wouldn't show.
Confirm with Mike before dunning anyone.

## Invoice created but never emailed, unpaid — \$8,150

- Mike Cronin \$2,950 — job Jun 17, invoice created Aug 3 (47 days late), never sent
- Lorraine Sheehan \$1,875 — job Aug 4, never sent
- Albina Tkachenko \$1,075; Kendra Dupiton \$2,250 — jobs Aug 20–21, possibly in-flight

## Sent but unpaid (AR) — \$6,925

Tom Dacey \$975 (60d), Boston Best Construction \$1,075 (60d), Tony Shawki
\$1,525, Mike Salamando \$1,800, Charlotte Winney \$475, Talia Smith \$1,075.

## Systemic finding

**When Mike completes the field-app flow, invoicing is 100% correct** — every
completed/payment-status job has a proper invoice; the cash/check path works
(invoice recorded, not emailed, balance zeroed — as designed). **Every miss is
a flow never started or abandoned mid-way** (7 no-record, 10 stuck at
checked_in/before_photo). The failure mode is silence: nothing happens and
nobody is told when the flow doesn't finish.

## Proposed direction (to brainstorm)

Exception alert (per errors→diagnostic-agent pattern): nightly cron finds
calendar jobs (colorId 10) ended > N hours ago with no `phase: completed`
field record or no linked/matching QBO invoice → text Matt with the specifics.
Would have caught all of the above within a day. Open design questions: how to
handle cash/check without nagging customers who already paid (answer: alert
Matt/Mike internally, never auto-email the customer); multi-day jobs; jobs
that legitimately cancel.

## Action checklist

- [ ] Ask Mike: Fairweather, Milliken, O'Connor, Banana, Piccinni, Hagen-Peter,
      Kosztyla — done? paid cash/check? then invoice or record payment
- [ ] Ask Mike about deleted Forristall invoice #2439; re-issue if owed
- [ ] Send Cronin (\$2,950) and Sheehan (\$1,875) invoices
- [ ] Chase 60-day AR: Dacey, Boston Best Construction
- [ ] Build the exception-alert cron
