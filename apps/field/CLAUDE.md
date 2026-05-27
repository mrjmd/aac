# Field — Tech-facing Job-Completion App

You are working in `apps/field/`, the fifth pillar of the AAC monorepo — a
mobile web app for the technician to use during and after each job.

## What This Is

A simple, mobile-first web app. The technician logs in, sees today's calendar
events, taps into a job, marks it complete, uploads before+after photos, and
sets payment status (Cash / Check / Card / Not Yet Paid). The backend triggers
downstream QB writes based on payment branch.

This app replaces the manual flow where Mike texts photos to Matt and Mike
sometimes-forgets to mark payments in QB. It also replaces Cron B
(invoice-send), which was killed per the 2026-05-27 architecture decisions.

## MVP Scope

- Single tech (Mike) with shared-password or magic-link auth — final auth TBD
- Today's calendar list (green events, attendee = configured technician)
- Job detail view: customer name, address, estimate ID if known, existing photos
- "Mark Complete" form: 2+ photos (mobile camera capture via file input), payment status
- Backend payment branching:
  - **Cash / Check** → create QB Payment object linked to the customer's most-recent invoice → marks paid
  - **Card** → verify QB shows the invoice paid; alert Matt if not
  - **Not Yet Paid** → trigger `qb.sendInvoice()` immediately (this is the Cron B replacement)
- Photos to Vercel Blob; URLs stored on the calendar event or PD deal

## Rules

- **Mobile-first.** Designed for phone use. Primary device: Mike's Android. Test on iPhone too.
- **One job at a time.** No bulk operations in MVP.
- **Single tech today, multi-tech ready.** Architect so adding a second tech is config + auth, not refactor.
- **Import API clients from `@aac/api-clients`.** No direct fetch to Google Calendar, QuickBooks, or any other service.
- **Required photos = behavior change mechanism.** "Job is not complete until you upload 2 photos." Soft enforcement (warn) vs. hard (block) is the v1 tuning question.
- **No campaign or marketing logic.** That belongs in `apps/marketing/`.
- **No deep analytics.** That belongs in `apps/command-center/`.

## Architecture

- Next.js 15 (App Router, mobile-first)
- Auth: shared password OR magic-link (TBD — see project spec)
- Photo storage: Vercel Blob
- Reads: Google Calendar (today's events), QuickBooks (linked estimates/invoices), Pipedrive (deal/person context)
- Writes: QuickBooks (Payment creation, Invoice send), Vercel Blob (photo upload), Pipedrive (job-complete log on deal)
- Shared state with middleware + agent: Upstash Redis

## Job-to-invoice matching

v1: uses the same heuristic as Cron A (single customer = single accepted estimate; skip-and-alert on ambiguity).

v2: replaces heuristic with `getDeal(calendarEvent.dealId)` once the deal spine exists in `apps/agent/` (see `docs/projects/apps-agent.md`).

## Related

- Project spec: `docs/projects/apps-field.md` (TBD)
- Architecture decisions: `docs/DECISIONS.md` — especially the 2026-05-27 entries on Cron B kill + field app fifth pillar
- Current plan: `docs/PLAN.md`
