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

1. Mike opens the app on his phone (subdomain TBD — likely `tech.attackacrack.com` or `field.attackacrack.com`)
2. Logs in (auth method TBD — see decisions below)
3. Sees today's jobs — list of green calendar events with him as attendee
4. Taps a job → detail view: customer name, address, linked QB Estimate ID + total if known, any prior photos
5. Performs the job
6. Taps "Mark Complete" → form:
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
- If Balance > 0: alert Matt via SMS — "Mike marked Card paid for {customer} but QB still shows balance \${X}. Verify."

### Not Yet Paid
- Photos → Vercel Blob
- Look up customer's most-recent invoice (or alert if none exists)
- Call `qb.sendInvoice(invoiceId)` immediately → QB emails the invoice to the customer
- Log completion + "awaiting payment" status
- **(This branch is the Cron B replacement.)**

### Multi-estimate / multi-invoice ambiguity
- Same skip-and-alert pattern Cron A uses
- Don't guess; SMS Matt the ambiguity description and let him resolve

## Auth (MVP)

| Option | Time | Pros | Cons |
|---|---|---|---|
| Shared password | <30 min | Trivial to ship | Bad multi-tech story; password leaks are silent |
| Magic link via email | \~1-2 hr | Per-user identification; standard pattern | Email reception delay if Mike's email is slow |

**Recommendation:** Magic link. Sets up multi-tech cleanly when needed. Whitelist of authorized emails configured in env (just Mike's email at MVP).

## Photo upload

- File input with `accept="image/*"` and `capture="environment"` → opens native camera on mobile
- Client-side compression before upload (target \~1-2 MB per photo from raw 4-12 MB phone capture)
- Upload to Vercel Blob via the SDK
- Store returned URL in the job-completion record

### Photo storage architecture

**v1:** URLs stored in Redis keyed by `{calendar-event-id}` and/or written to QB invoice description / PD deal custom field.

**v2:** Photos attached to the Google Calendar event itself (via Drive API — file upload to Drive → attach to event). Defer to v2 because Drive integration adds 0.5-1 day.

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

## Open questions for Matt

1. **Subdomain:** `tech.attackacrack.com`? `field.attackacrack.com`? Other?
2. **Brand fidelity:** Pull website CSS / Tailwind config OR Tailwind-from-scratch with logo + brand colors only?
3. **Required photos: hard block or warning?** "Must upload 2" prevents submission OR allows submission with a "you didn't upload photos" warning that fires an SMS to Matt.
4. **Card branch — what if QB shows the invoice unpaid?** Alert Matt and abort (don't mark complete)? Or accept Mike's word and create a QB Payment for Card (overriding QB's state)?
5. **What if there's no QB invoice yet for the customer?** (e.g., Cron A didn't run because no Accepted estimate matched, or job was added to calendar same-day.) MVP options: (a) skip + alert Matt, (b) create invoice on the fly from the most-recent estimate, (c) prompt Mike for the estimate ID. Recommendation: (a).
6. **PD deal logging:** when Mike marks complete, write a PD activity on which entity? The person? A deal? (v1: person, since deals aren't fully integrated yet.)

## Related

- Architecture decisions: `docs/DECISIONS.md` (2026-05-27 entries on field app + Cron B kill)
- Plan position: priority #1 of four; ships in parallel with apps/agent
- Pillar CLAUDE.md: `apps/field/CLAUDE.md`
- Current plan: `docs/PLAN.md`
