# @aac/grader — What Matt Did With Each Draft

Step 1 of the automations readiness work
(`docs/plans/command-center/automations-and-big-ideas.md`). Every draft any
automation makes gets one record in the `grader:drafts` hash, graded against
what Matt actually sent. The command center Automations page reads these
records; nothing else writes them.

## Run (`runGrader`, worker `/api/grader`, daily)

1. **Collect** (`collect.ts`): live quote drafts from `quote-drafter:runlog`,
   drafted texts from `message-drafts:runlog` (followup, intake, ct-routing,
   referral), queued touches from `stale-quotes:state`. All three are trimmed
   or pruned, so each draft is copied into its own record the first day it is
   seen. An updated quote draft replaces the earlier one until graded.
2. **Grade** every record still `waiting` (`grade.ts`), oldest first, until
   the deadline. A final grade is never revisited.

## Grades

| Grade | Quotes | Texts |
|---|---|---|
| as-is | emailed or accepted with the drafted items, quantities, prices and total | Matt's reply has word similarity ≥ 0.97 to the draft |
| cosmetic | (not used for quotes) | ≥ 0.85 |
| changed | an item, quantity, price or the total differs | below 0.85 |
| thrown-out | deleted in QBO (404 or 400/610) | |
| unused | closed or rejected without emailing, or not emailed in 30 days | nothing texted in the window, or a call came first |
| waiting | not emailed yet | window still open |

- The Guarantee line is ignored (`draft-quote.ts` appends it itself).
  `ownerChanges` is shared with `tools/src/quote-trigger/harvest-edits.ts`.
- SyncToken is not used: emailing or saving in QBO bumps it with nothing
  changed.
- Texts: Matt's first outbound after the draft, plus any more within 20 min
  (one reply split over texts). Automated texts (`AUTO_RE` from
  `@aac/message-drafts`) don't count. Windows: followup 3d, intake 1d,
  ct-routing and referral 2d, stale-quote 7d.
- "Would have hurt" is a hand grade only. The thresholds are provisional
  until Matt's ~30 hand grades calibrate them.

## Kinds of cases (`kinds.ts`)

Quotes from the drafted lines: one-crack, cracks, pipes, bulkhead (fast);
cracks-plus, floor, steps (learn); flat-resurfacing, structural, masonry,
mixed (human, always drafts). Wall type and crack direction aren't on the
lines, so they aren't split out yet. Followup: quiet (fast) vs open-question
(the customer asked something after Matt's last text; human). Stale quotes:
T1/T2 fast, T3 learn. Intake: the drafter's verdict.

## Rules

- Reads QBO, Quo and Redis. Writes only `grader:drafts`, and nothing on a dry
  run. Never contacts anyone.
- Keys come from `@aac/shared-utils/redis` (`graderDrafts`, `graderMode`,
  `graderLastRun`, `graderRunLock`).
