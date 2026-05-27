# Project Spec — apps/field (Tech-facing Job-Completion App)

**Status:** Spec — pre-build
**Owner:** Matt
**Created:** 2026-05-27
**Pillar:** 5 (apps/field/)
**Build dependency:** Independent of apps/agent for v1 (uses Cron A heuristics). v2 depends on deal spine in apps/agent.

---

## Goal

Replace three current pain points with one structured per-job interface for the technician:

1. **Photo capture chaos.** Today Mike texts before/after photos to Matt, sometimes hours/days after the job, sometimes batching multiple jobs. Matt manually reconstructs which photos belong to which job.
2. **Cash/check payment marking discipline.** Mike sometimes forgets to mark cash/check payments in QB. This was the unsolvable-at-code-layer failure mode in `middleware-auto-invoicing.md` that motivated killing Cron B.
3. **No explicit "job done" signal.** Job completion is inferred from "calendar event date passed," which is fragile (cancelled jobs, postponements, partial completions).

The field app produces:
- Photos tagged unambiguously per-job at completion time
- Payment-status ground truth captured at job-end
- Explicit completion event that downstream systems can react to

## User flow (MVP)

1. Mike opens the app on his phone at `field.attackacrack.com`
2. Logs in via magic link sent to `mike@attackacrack.com`
3. Sees **today's calendar — every event he is invited to**, not just green/job events. This covers jobs, assessments, callbacks, anything Mike is the attendee on.
4. Taps an event → detail view: customer name, address, event type, linked QB Estimate ID + total if known, any prior photos
5. Performs the job (or assessment, or callback)
6. Taps "Mark Complete" → form (behavior depends on event type — see below):
   - **Before photo** (camera capture)
   - **After photo** (camera capture)
   - **Optional additional photos** (0+ more)
   - **Payment status**: radio buttons — Cash / Check / Card / Not Yet Paid
   - Submit
7. Backend processes per payment branch (below)
8. Mike sees confirmation, returns to today's list

## Backend behavior — payment branching

When Mike submits a completion:

### Cash / Check
- Photos → Vercel Blob; URLs stored on the QB invoice OR PD deal record
- Find the customer's most-recent unpaid invoice (Cron A's same heuristic)
- Create a QB Payment object linked to the invoice (POST /payment with `Line: [{Amount: invoice.TotalAmt, LinkedTxn: [{TxnId: invoice.Id, TxnType: 'Invoice'}]}]`)
- Mike's selection of "Cash" vs "Check" stored as the PaymentMethod
- Invoice now shows Balance = 0
- Log job completion to PD activity on the linked person

### Card
- Photos → Vercel Blob
- Look up customer's most-recent invoice
- If Balance == 0 (already paid via QB Payments processing or other card flow): accept, log completion
- If Balance > 0: **abort the completion**. SMS Matt: "Mike marked Card paid for {customer} but QB still shows balance \${X}." Mike sees an error: "Card payment not yet visible in QB — Matt has been notified, please wait for him to confirm before re-submitting." Matt reconciles, then Mike resubmits.

### Not Yet Paid
- Photos → Vercel Blob
- Look up customer's most-recent invoice (or alert if none exists)
- Call `qb.sendInvoice(invoiceId)` immediately → QB emails the invoice to the customer
- Log completion + "awaiting payment" status
- **(This branch is the Cron B replacement.)**

### Multi-estimate / multi-invoice ambiguity
- Same skip-and-alert pattern Cron A uses
- Don't guess; SMS Matt the ambiguity description and let him resolve

### No invoice exists for the customer
- Block Mike from submitting
- Show error: "No invoice found for {customer}. Please contact Matt to create the invoice, then re-submit."
- This is intentionally the same UX as today's manual flow — Mike escalates to Matt by phone/text. With Cron A live this should be rare.
- Do NOT auto-create the invoice in the field app (keeps Cron A as the single source of invoice-creation logic).

## Auth (MVP)

**Decision (locked 2026-05-27):** Magic link via email for v1. Whitelist of
authorized emails in env (just Mike's email at MVP).

**Session behavior:** Long-lived sessions with "trust this device" checkbox at
login → 90+ day session token. Mike should not have to re-authenticate
day-to-day. Re-auth only on explicit logout or device change.

**Forward-looking — Google OAuth migration:** Magic-link is fine indefinitely.
The original concern (v2 needing Drive access for photo attachment) was
sidestepped by the v2 photo design (see Photo storage architecture below):
photos stay in Blob, calendar event description links back to a field-app
page. Drive never enters the picture. Migrate to Google OAuth only if a
different feature later forces it.

## Photo upload

- File input with `accept="image/*"` and `capture="environment"` → opens native camera on mobile
- Client-side compression before upload (target \~1-2 MB per photo from raw 4-12 MB phone capture)
- Upload to Vercel Blob via the SDK
- Store returned URL in the job-completion record

### Photo storage architecture

**v1:** Photos live in Vercel Blob, written only by the field app. Each blob
has explicit metadata: `{ jobId, calendarEventId, uploaderEmail, timestamp,
label: 'before' | 'after' | 'extra' }`. Index in Redis keyed by
`{calendar-event-id}`.

Field-app photos and customer-sent photos (which live in Quo / Matt's texts /
calendar event attachments today) never mix. No attribution ambiguity.

**v2:** Calendar event description gets a deep-link to
`field.attackacrack.com/jobs/{eventId}/photos`, which renders the gallery from
Blob. Photos are NOT attached to the calendar event itself, and NOT written to
Drive. This sidesteps three problems:
- No need for Mike to OAuth Google
- No mixing with photos Matt manually attached to events
- No Drive API integration work

Auth migration to Google OAuth (mentioned in Auth section) is therefore *not*
forced by photo storage. It only becomes worth doing if a different feature
demands it.

## Job-to-invoice matching

**v1 (heuristic):** Same logic as Cron A:
- Lookup PD person via calendar event matcher
- Lookup QB customer via PD person
- Find most-recent invoice for that customer
- If multiple ambiguous → skip-and-SMS-Matt

**v2 (deal-spine):** Once `apps/agent/` exposes deal spine, calendar event has a `[deal:N]` marker → lookup deal → get linked invoice unambiguously. This eliminates the multi-job-per-customer failure mode (builders, contractors).

## Build phases

| Phase | Scope | Time |
|---|---|---|
| 1 | Project scaffold (Next.js 15, deploy to Vercel, magic-link auth, Mike whitelisted) | 0.5 day |
| 2 | Today's calendar list + job detail view (read-only) | 0.5 day |
| 3 | Mark-complete form (photos to Blob, payment status selection) | 0.5 day |
| 4 | Backend payment branching (QB Payment creation, sendInvoice, alert SMS) | 1 day |
| 5 | Polish (loading states, error handling, basic AAC branding) | 0.5 day |
| 6 | Mike training + first-week shadowing | 1 day (operational) |
| **Total** | **3-4 engineering days + 1 training day** | |

## Locked decisions (2026-05-27)

| # | Decision | Notes |
|---|---|---|
| Subdomain | `field.attackacrack.com` | Generic; extends beyond just Mike (Edward eventually) |
| Auth | Magic link via email | See Auth section above; long sessions, OAuth migration deferred to v2 |
| Required photos | **Hard block** — must upload both before + after to submit | Enforce discipline at the UI |
| Card branch (QB shows balance > 0) | **Abort + alert Matt** | Mike can't mark complete; you reconcile manually before he can submit |
| No QB invoice exists | **Block Mike + force escalation** | Same as today's manual flow: Mike calls/texts Matt, Matt fixes upstream, then Mike submits. Should be rare now that Cron A runs. |
| PD activity logging | On the person (v1) | Migrate to deal-attached in v2 when apps/agent ships |

## Still open

- **Brand fidelity:** Pull website CSS / Tailwind config OR Tailwind-from-scratch with logo + brand colors only? (Defer until scaffold phase; low-stakes.)

## Related

- Architecture decisions: `docs/DECISIONS.md` (2026-05-27 entries on field app + Cron B kill)
- Plan position: priority #1 of four; ships in parallel with apps/agent
- Pillar CLAUDE.md: `apps/field/CLAUDE.md`
- Current plan: `docs/PLAN.md`
