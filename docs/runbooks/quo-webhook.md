# Quo webhook disabled

Text: `⚠️ Quo → middleware pipe DOWN since ...`

## What it means

Quo shows conversation activity on the business line that is 15+ minutes
old, and the middleware hasn't processed (acked) a Quo event since before
it. Incoming texts and calls are not syncing: no Pipedrive activity, no
drafts, no scheduling, no inbound router.

The usual cause: Quo auto-disables a webhook when deliveries time out or
fail repeatedly (2026-10-19: one slow event exhausted Quo's retries and
the webhook was switched off). The middleware now acks fast and does the
work after, but a long outage on our side can still trip it.

Source: `packages/watchdog/src/checks.ts` (`quo-pipe`). If the watchdog
can't reach Quo's API at all it gives no verdict either way.

## How to check

1. System page: the middleware card (webhook counts today and yesterday,
   last event per source). Redis `webhooks:quo:last` is the time of the
   last processed Quo event; `webhooks:quo:<date>:count` is today's count.
2. Middleware function logs in Vercel for `/api/webhooks/quo`: no requests
   at all means Quo stopped sending; requests with 401 mean the signing
   secret doesn't match (`QUO_WEBHOOK_SECRET`; Quo signs each webhook URL
   with its own secret).

## How to fix

1. In Quo: Settings → Webhooks → re-enable the middleware webhook (the one
   pointing at the middleware's `/api/webhooks/quo`). Webhooks created in
   the Quo UI can't be changed through Quo's API, so this is a manual step.
2. If it is enabled: check the middleware deploy in Vercel (latest deploy,
   function errors) and whether `/api/health` answers.
3. Events Quo dropped while the webhook was off are not replayed. The
   inbound router's sweep (built for this case) re-arms conversations with
   customer activity in the last 6 hours from Quo's conversation list, so
   their drafts still happen if the router is on; Pipedrive activity
   logging for the outage window is lost. Check those conversations by
   hand if the outage was long.

The watchdog sends `✅ Recovered` once a processed event is newer than
Quo's newest activity.

## How to switch it off

Nothing to switch off on our side. If you need the middleware to stop
processing Quo events, disable the webhook in Quo; the watchdog will then
text that the pipe is down (expected).
