# Gemini degraded

Text: `⚠️ Gemini (drafts, intake replies, scheduling) failing since ...`,
then `✅ Recovered: Gemini (drafts, intake replies, scheduling) is back`.

Source: `packages/watchdog/src/gemini.ts`, evaluated on every watchdog
tick (every 5 minutes, same 2-tick confirm and 6-hour reminder as the
other [watchdog](watchdog.md) conditions).

## What it means

Gemini is failing in the live paths. Customer replies, intake and
follow-up drafts, quote drafts and scheduling classification are failing
or falling back to templates.

Down when either:

- **Live failures**: `router.read_failed` + `dispatch.classifier_rejected`
  happened 3 or more times in the last hour, or
- **Canary**: the hourly canary (worker `/api/gemini-canary`, :07 every
  hour) hasn't passed for 135 minutes (two runs missed or failed).

No verdict until the canary has passed once (fresh deploy).

## How to check

1. The text itself says the counts: "N inbound router read failure(s) and
   N scheduling classifier failure(s) in the last hour; the hourly canary
   last passed ...".
2. System page: "Gemini canary" row (last pass), and "Silent skips" for
   `gemini.canary_failed`, `router.read_failed`,
   `dispatch.classifier_rejected`, `intake.generation_failed`,
   `followup.skeleton_fallback`.
3. Redis: `health:gemini-canary:ts` (last pass),
   `health:conditions:recent:router.read_failed` and
   `health:conditions:recent:dispatch.classifier_rejected` (zsets, one
   member per failure, last 2 hours).
4. Worker function logs for `gemini-canary` and `inbound-tick` have the
   actual error.

## How to fix

Usual causes, in order:

1. Key or billing: check the Gemini key and billing in Google AI Studio
   (all AAC keys are business-billed).
2. Model alias moved: the clients use the `gemini-flash-latest` alias. If
   Google retired or changed what it points at, pin a working model in
   `@aac/api-clients` GeminiClient and push.
3. Google outage: nothing to do; it recovers on its own and you get the
   recovery text.

## How to switch it off

There is no Gemini switch. The paths that use it already degrade on
their own (follow-ups use the template skeleton; the Silent skips counts
show how often). To stop the bot making
quote drafts while Gemini is flaky, turn the quote drafter off
([quote-drafter.md](quote-drafter.md)).
