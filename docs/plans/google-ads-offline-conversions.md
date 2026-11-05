# Google Ads offline conversions ("Stream B"): tell Google which clicks became jobs

**Status:** BUILT 2026-11-05 (`@aac/ads-conversions`, worker `/api/ads-conversions` daily, default off). Ref-code prefill live on the website (aac-astro 9c60daf). Next: create the 3 actions (owner OK), worker env, 90-day backfill, mode live.
**Why:** Google bids toward website call/text *taps*. May to Oct 2026 it counted 366 of them; only about 93 were a new person actually calling or texting, 61 were real in-scope leads, and 8 became jobs. Text taps are the worst offender: about 80% never turn into a text. Feeding real outcomes back lets Smart Bidding buy the clicks that become jobs. Evidence: `analysis/google-ads-slow-season-2026-11-05.md`.

## What already exists
- The website stores `gclid` on every ad landing and sends it with each call/text tap as GA4 param `ad_click_id` (`aac-astro/src/layouts/Layout.astro`). It's registered as a GA4 custom dimension and present on 206 of 207 ad taps since July.
- GA4 taps are logged to the minute. Quo has every inbound call and text. The funnel ledger (`analysis/data/funnel/`) follows a phone to QBO quote, won, invoiced.
- Working Google Ads API code (auth, GAQL, mutate) lives in `aac-astro/scripts/lib/google-ads-client.js`. The `@aac/api-clients` GoogleAdsClient is a stub.

## Build
1. **GoogleAdsClient in `@aac/api-clients`:** OAuth refresh, developer token, login-customer (MCC), `search` (GAQL), `uploadClickConversions` (ConversionUploadService, partial failure on). Port from the aac-astro lib, with tests per package rules.
2. **Conversion actions** (type UPLOAD_CLICKS) created in the MA account: `AAC Real lead`, `AAC Quote sent` (value = quote total), `AAC Won job` (value = invoice). Start them as **secondary** (reported, not bid on), so nothing changes in bidding until we flip.
3. **Matcher + uploader job in the worker (daily):**
   - Pull GA4 taps with `ad_click_id` for the last 3 days.
   - Match each to a Quo inbound call/text **from a number whose first-ever contact is that event**, at -2 to +3 minutes. If two or more new numbers fall in the window, skip it as ambiguous.
   - Save `phone → gclid, tapAt` (Redis, key builder in `@aac/shared-utils/redis`).
   - Upload "Real lead" once the lead is classified in-scope. Upload "Quote sent" when a QBO estimate exists for that phone, and "Won job" when it's invoiced. Use a stable `orderId` per conversion so re-runs don't double count.
   - Log matched / ambiguous / uploaded counts, and add a "last run" health check.
4. **Backfill:** Google accepts clicks up to 90 days old. On the first run, upload everything since about Aug 7 (about 40 traced ad leads, including the Sep and Oct wins).
5. **Flip:** after about 4 to 6 weeks of uploads, make `AAC Real lead` the primary goal and demote the tap actions to secondary. Set a new target CPA in real-lead terms (traced cost was about \$300 to \$600 per real lead, so start near the top and walk it down). This resets learning, so do it in January while spend is \$100/day, **before the ~Feb 15 ramp back to \$200/day**. Later, once there are enough wins, move to value bidding on `AAC Won job`.

## Raise the match rate (optional, after the core loop)
- **Prefilled text with a short ref code:** `sms:` links currently open a blank message. A prefilled body ("Hi Attack A Crack, I'd like a quote. (ref K7Q)") ties a text to its tap exactly and probably raises the send rate. Website-only change; the matcher reads the ref from the Quo message body.
- **Ads-only tracking number:** show a second Quo number only to visitors who arrived with a `gclid`. Every call or text to it, even days later, is an ad lead. This is the most complete fix, but it adds a second inbox and every middleware path that assumes the MA line has to handle it. Defer unless the first two still leave too much in the dark.

## Readout ("Stream A")
The same join written monthly as the Ads row on the command center Marketing page: real leads, quotes, won \$, and cost per job by ad group. This is aac-26's lane (command center).

## Not in scope
Calls that come from Google's own call extensions ("Calls from ads", a handful a month) or from people who click an ad and later call through Google Maps. Google needs a consistent signal, not every lead.
