# Multi-Day Job Awareness — Design (pre-code)

**Status:** implemented 2026-09-28 (steps 1–4), pending deploy of field +
middleware. Step 5 audit done: invoice-create's daily skips already line up
with multi-day chains (estimate-match guards catch them); add the
continuation guard whenever that cron is next touched — not urgent.

## The problem

Multi-day jobs (Ed Spooner 9/10 + 9/11 + 9/16, Kevin Maldarelli 9/17 + 9/18 +
9/21) are represented as several green calendar events, continuation days
usually titled `NAME [cont]`. Nothing in the system knows these events are one
job, which causes three real failures:

1. **Customer-facing noise mid-job.** The `job-followups` cron sends the
   review-prompt SMS the morning after *every* green job day — so the customer
   gets "how did we do, leave us a review!" while we're coming back tomorrow.
   Matt: "That always confuses people, and I've never fixed it."
   (`invoice-send` is NOT in vercel.json crons, so the review SMS is the only
   scheduled customer-facing post-job message. The other path is the field
   app's Not Yet Paid branch, which emails the QB invoice immediately.)
2. **Field flow expects completion every day.** Mike can't truthfully
   "Mark Complete" on day 1 of 3, so records sit in `checked_in` /
   `before_photo_taken` forever and triage screams about them.
3. **Triage D1 judges every day-event independently** — continuation days
   look like separate uninvoiced jobs.

## Detection: what makes two events "one job"?

A green (colorId 10) event E has a **continuation** if another green event
exists with a **later start within 10 days**, matching either:

- **base title** — title with a trailing `[cont]` (any bracketed suffix)
  stripped, compared case-insensitively with the existing `tokensAlike`
  tolerance; or
- **normalized location** — same street line (lowercased, punctuation
  stripped). Catches the days Matt forgets the `[cont]` suffix.

10-day window: observed gaps are 1–5 days (weekends, weather); 10 gives slack
without linking genuinely separate repeat jobs at the same address.

An event whose continuation exists is a **non-final day**. Only the final day
of a chain is treated as "the job ended".

Known edge cases (accepted):
- Continuation cancelled/deleted after day 1 → that job's follow-up is never
  sent (its D-1 already passed). Rare; acceptable loss.
- Genuine second job at the same address within 10 days → follow-up for job 1
  skipped. Rare; acceptable.

## Implementation plan (in rollout order, safest first)

### 1. `@aac/shared-utils` — pure helper + tests
`findContinuation(event, candidates)` over a minimal structural type
(`{ id, summary, location, start, colorId }`) so shared-utils gains no
dependency on api-clients. Pure function, exhaustively unit tested (title
variants, location normalization, window boundaries, out-of-order input).
No consumer changes in this step.

### 2. Triage `analyze.ts` D1 — skip non-final days
Before judging a job event, skip it if a later green continuation exists
(matching via the shared helper's logic). Only final days are judged for
invoice/flow gaps. Kills the `[cont]` noise permanently.

### 3. Field app — "Wrap Up Day" on non-final days
- Event detail computes continuation from the day list it already fetches.
- Non-final day: primary action becomes **"Wrap up for today"** — photos
  optional (`extra` label), **no payment step**, so the Not Yet Paid branch
  (which emails the invoice) is unreachable mid-job. Sets `phase:
  'completed'` with a new optional field `continuedByEventId` on the record
  (no new Phase value — every existing consumer keeps working; the field is
  self-documenting for triage and audits).
- Final day: unchanged full flow (photos + payment + QB branching).
- **Server-side guard** in the payment-branch action: refuse payment
  branching when a continuation exists (defense in depth against UI drift).

### 4. Middleware `job-followups` — skip mid-job follow-ups [SACROSANCT — minimal]
- One additive change inside the handler: after listing yesterday's events,
  make one extra `calendar.listEvents` for `[today, +10d]` green events; for
  each candidate with a continuation, return a new
  `status: 'skipped_multiday_continuation'` **before** `markCronAction`, so
  the final day's own event still dedups and sends normally.
- The final-day follow-up then references the final event — `formatWhen`
  and variant selection work unchanged.
- Unit tests for the skip path + a regression fixture shaped like Ed
  Spooner's September chain. Verified via `?dry=true` before deploy.

### 5. `invoice-create` cron — audit, then decide (separate change)
It runs at 7am on the day of every green job and its duplicate guard is only
"invoice for this customer in last 24h" — a 3-day job with gaps *should*
produce duplicate invoices. But Ed's/Kevin's invoices are single and dated
9/24 (after their jobs), so the cron may not be doing what its header says.
**Audit its recent runs first** (`cron:runs` in Redis / logs) before touching
it; the likely fix is "create only on the final day," using the same helper.

## Reminder policy (revised 2026-10-21, Matt's call)
A multi-day customer gets exactly TWO automated texts: one reminder before
day one — which announces the full booking ("we also have you booked for N
more days") — and one follow-up after the final day. Continuation days get
no reminder of their own (`skipped_multiday_continuation` in job-reminders).
The original "keep sending day-before reminders for continuation days" note
below was written when those reminders were silently failing anyway (the
`[cont]` title broke Pipedrive person matching, fixed same day); when the
match fix would have un-broken them, Matt ruled daily reminders out.
- No calendar-schema change (no extended properties). The title/location
  convention is the source of truth; the helper encodes it.
