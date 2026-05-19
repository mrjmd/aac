# Middleware — Auto-Invoicing Crons

**Status:** Cron A (invoice-create) LIVE on schedule as of 2026-05-19. Cron B (invoice-send) still OFF.
**Created:** 2026-05-18
**Owner:** Matt

> **NEXT ACTION — target week of 2026-05-26:** Cron A has been running for ~1 week of clean firings.
> Spot-check the invoices it created against what Matt would have done manually.
> If clean, enable Cron B by adding `{ "path": "/api/cron/invoice-send", "schedule": "5 11 * * *" }`
> to `apps/middleware/vercel.json` (5 min after Cron A, same UTC offset).
> If NOT clean (wrong amounts, wrong customers, unexpected skips), pause and fix before enabling B —
> B is the irreversible one because it sends customer email.

Two new daily crons that automate the manual invoice-management flow Matt is
doing every morning:

1. **Cron A — Invoice Create:** On the morning of a job, auto-create a QB
   invoice from the customer's most-recent accepted estimate.
2. **Cron B — Invoice Send:** Two days after a job, if the invoice still
   hasn't been paid or sent, email it to the customer (QB default template).

---

## Job-filter consistency (sacrosanct)

Both crons MUST use the exact same calendar-event filter shape used by the
existing `job-reminders` and `job-followups` crons. There is one source of
truth for "is this calendar event a real job?" and we extend it, not fork it.

The filter:

| Field | Value | Source |
|---|---|---|
| `attendeeEmails` | `env.google.technicianEmails` | `TECHNICIAN_EMAILS` env var (comma-separated) |
| `colorIds` | `['10']` (green = job only) | hardcoded in each cron's constant |
| `requireLocation` | `true` | matches existing crons |
| `minDurationMinutes` | `120` | matches `job-followups` |
| `excludeKeywords` | `['cancelled', 'canceled']` | matches `job-followups` |

**When a 2nd technician is hired:** change the `TECHNICIAN_EMAILS` env var in
Vercel. All four crons (reminders, followups, invoice-create, invoice-send)
pick up the new attendee list automatically. Do not hardcode anyone's email
anywhere in cron code.

**Color choice:** unlike `job-reminders` (which includes callbacks/assessments
on colors `5` and `3`), invoice automation fires on green (`10`) ONLY. Callbacks
and assessments don't have a billable scope tied to an estimate.

---

## Cron A — Invoice Create

**Schedule (when enabled):** Daily ~7:00 AM ET. Runs before Cron B.

**Flow:**
1. Calendar query: today's events matching the shared filter
2. For each event:
   a. Match event → Pipedrive person (same matcher used by existing crons)
   b. Match Pipedrive person → QB customer (by email primarily, fallback to display name)
   c. Query QB for that customer's most-recent estimate with `TxnStatus = "Accepted"`
   d. Create an Invoice in QB with `LinkedTxn` referencing that estimate
   e. **Do NOT send the invoice.** Cron B handles sending.
3. Redis dedupe by calendar event ID (won't double-create if cron retries)
4. Pre-flight check before creating: skip if an invoice already exists for
   this customer in the last 24 hours (manual creation by Mike or Matt wins)

**Failure modes that skip-and-log (not error):**
- No Pipedrive person matched → skip
- No QB customer matched → skip
- No accepted estimate found → skip
- Invoice already exists in last 24h for this customer → skip
- Event marked cancelled → skip (filter handles this)

### Edge case — estimate selection is a heuristic, not a guarantee

The most-recent-accepted-estimate ≠ guaranteed to be the estimate that THIS
specific job is delivering against. Known scenarios where this is wrong:

1. **Multiple accepted estimates for one customer.** A customer accepts two
   separate proposals (e.g., crack repair AND sump pump), then today's job
   is only doing one of them. We'd invoice the wrong scope.
2. **Customer accepted Quote A months ago, then accepted Quote B last week,
   and today's job is finishing Quote A's work.** We'd invoice Quote B.
3. **Customer accepted Quote A, then Matt verbally revised pricing without a
   new QB estimate.** We'd invoice the stale amount.

**Mitigation (in scope for this build):**
If a matched customer has >1 estimate with `TxnStatus = "Accepted"`, Cron A
DOES NOT create an invoice. Instead it sends a single alert SMS via
`quo.sendMessage(env.notifications.alertPhoneNumber, ...)` listing the
ambiguous job + the customer's accepted estimate IDs/totals so Matt can
manually create the right invoice.

This trades automation rate for trust: a false-negative (Matt invoices
manually) is recoverable; a false-positive (wrong amount invoiced) damages
customer trust.

**Long-term fix (deferred — Matt's call):** link a calendar event to a
specific QB estimate ID via Pipedrive deal custom field or calendar event
description marker. Requires manual tagging discipline at booking time. Not
in scope for this initial build.

---

## Cron B — Invoice Send

**Schedule (when enabled):** Daily ~7:05 AM ET. Runs after Cron A.

**Flow:**
1. Calendar query: events from 2 days ago matching the shared filter
2. For each event:
   a. Match event → Pipedrive person → QB customer (same matcher as Cron A)
   b. Find the most-recent invoice for that customer in the last ~5 days
   c. If `Balance > 0` (unpaid) AND `EmailStatus != "EmailSent"` →
      POST `/invoice/{id}/send` to QB (default template, default billing email)
3. Redis dedupe by invoice ID
4. Skip silently if invoice has been deleted/voided

**Failure modes that skip-and-log:**
- No invoice found → skip (manual handling expected)
- Invoice already paid (`Balance == 0`) → skip
- Invoice already emailed (`EmailStatus == "EmailSent"`) → skip
- Customer has no email on file in QB → skip + log so Matt handles manually

### Edge case — cash/check payment + Mike forgets to mark paid in QB

**Status: known and unsolved at the code layer. Matt is solving this
operationally.**

The painful failure mode: customer pays in cash or check on-site. Mike is
supposed to record the payment in the QB mobile app. If he forgets:

- `Invoice.Balance` still shows the unpaid amount
- `Invoice.EmailStatus` is still `NotSet` / `NeedToSend`
- Cron B sees both flags as "unpaid + unsent" and emails the customer
  asking for money they've already paid

**Customer impact:** confusing/annoying email, erodes trust, makes AAC look
disorganized. This is the worst failure mode of the entire system.

**Why not a pre-cron Matt-facing notification:** rejected. Frequent pings
would be more annoying than the occasional bad-send. Notifications are
reserved for exception/skip paths (e.g. multi-estimate ambiguity).

**Operational mitigation (Matt-owned, outside this code):** Mike must mark
payment in QB immediately on collection — not days later when checks are
deposited. Matt to enforce this as a hard rule.

**Code does not attempt to detect or mitigate.** The 48-hour Cron B delay
buys some buffer time but doesn't solve the case. We accept the residual
risk in exchange for keeping the system simple and Matt's inbox quiet.

---

## Build deliverables

### Package: `@aac/api-clients/quickbooks`

Add 4 methods + Vitest tests. All use existing `request` helper. All preserve
strict typing, no `any`.

| Method | Signature | Notes |
|---|---|---|
| `getEstimatesByCustomer` | `(customerId: string, status?: 'Accepted' \| 'Pending') => Promise<QBEstimate[]>` | Newest-first |
| `createInvoiceFromEstimate` | `(estimateId: string) => Promise<QBInvoice>` | Copies line items, sets `LinkedTxn` |
| `getInvoicesByCustomer` | `(customerId: string, sinceISO?: string) => Promise<QBInvoice[]>` | For dedupe + Cron B lookup |
| `sendInvoice` | `(invoiceId: string, email?: string) => Promise<QBInvoice>` | Default template; default email if omitted |

### App: `apps/middleware`

- `api/cron/invoice-create.ts` — mirrors `job-reminders.ts` structure
- `api/cron/invoice-send.ts` — mirrors `job-followups.ts` structure
- Both support `?dry=true` (no QB writes, returns what would happen)
- Both use shared filter helpers (no duplicated filter args inline)

### `vercel.json`

**Not added on initial PR.** Matt enables Cron A after manual dry-run is clean.
Then waits a week of observation. Then enables Cron B.

---

## Deployment / cutover sequence

1. PR merged → both cron handlers live as HTTP endpoints, but neither is on
   the Vercel cron schedule
2. Matt hits `GET /api/cron/invoice-create?dry=true` for several days, eyeballs
   output, confirms it would have invoiced the right jobs
3. Matt adds Cron A to `vercel.json` and deploys
4. ~7 days of observation. Daily summary log goes to Matt.
5. If Cron A is clean: Matt hits `GET /api/cron/invoice-send?dry=true` for a
   couple days, then adds Cron B to `vercel.json`
6. If Cron A is producing wrong invoices: pause, iterate on the matching /
   estimate-selection logic, repeat

---

## Decisions log

- **Pre-cron notifications to Matt:** REJECTED (2026-05-18). Will not add
  proactive notifications. Skip-path SMS alerts only.
- **Multi-estimate behavior:** SKIP + SMS alert via existing
  `alertPhoneNumber` channel (2026-05-18).
- **Cash/check edge case:** noted but unsolved at the code layer. Matt to
  enforce Mike-marks-paid-immediately operationally (2026-05-18).
- **Email template:** QB default branded template, default billing email
  on file (2026-05-18).
- **Customer matching strategy:** Pipedrive person-match, identical to
  existing `job-reminders` / `job-followups` crons (2026-05-18).
