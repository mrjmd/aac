# @aac/lead-leaks — leads we dropped before a quote

The round-2 plan's "Missed" revenue (docs/plans/command-center/round-2-funnel-queues-system.md §3)
as a queue: who asked for work in the last 90 days and never got a quote
because we dropped them, and what that's worth.

## Stages

- `no_reply` (A): asked, never got a human answer, no photos or details yet.
  Quo's missed-call auto-text doesn't count as an answer (an outgoing text
  within 60s of a missed call with no voicemail).
- `no_quote` (B): sent photos or details, or we talked scope, no quote.
- `assessed` (C): we visited, no quote.

Not leaks, counted only: quoted or booked, `quiet` (we asked last and they
never answered: a nudge list), solicitations, existing customers, declined,
deferred, CT (goes to Luc), phone tag. Quotes that went stale after sending
belong to `@aac/stale-quotes`.

## How a run works (`runLeadLeaks`)

1. Every 1:1 business-line thread active in the window (internal numbers out).
2. Settled without a read (`settledPhones`): a QBO estimate dated in the
   window for a customer with that phone (quoted); a job, callback or
   future assessment on the calendar whose description carries the phone
   (booked). A past assessment is the stage C hint for the model.
3. The rest: messages, calls, up to 3 transcripts and 3 voicemails, then one
   Gemini read (`SYSTEM_PROMPT`). Bare missed calls skip the model and stay
   a lead for 7 days (`MISSED_CALL_DAYS`); after that they count as phone tag.
4. Every read is cached in `lead-leaks:verdicts` by the thread's
   lastActivityAt (and assessment date); an unchanged thread costs nothing.
5. Saves `lead-leaks:latest`. Past `deadlineMs` it stops starting reads and
   says so in `gaps`.

## Value (`leakValue`)

The funnel study's method: one average lead = 0.749 quotes per lead × 54.2%
win rate × \$2,073 average won deal = \$842. Known scope = likely ticket
(`SCOPE_TICKET`, pricing policy anchors) × win rate. Assessed with unknown
scope = \$2,073 × win rate. A bare missed call = a quarter lead (about 1 in
4 inbound contacts is a real lead). Re-fit with the study each January.

## Rules

- Reads only. Writes only its own `lead-leaks:*` keys (the command center
  writes `lead-leaks:handled`). Never sends anything.
- No `process.env` here; callers construct the clients.
