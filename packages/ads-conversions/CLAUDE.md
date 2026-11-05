# @aac/ads-conversions — Google Ads offline conversions

Plan: `docs/plans/google-ads-offline-conversions.md` ("Stream B"). Tells
Google which ad clicks became real leads, quotes and jobs, so Smart Bidding
buys clicks that turn into work instead of website taps.

- `match.ts` — pure: GA4 tap (gclid) ↔ Quo inbound. Ref code first
  ("(Ref: K7QM)" prefilled on MA text buttons), then a -2/+3 min window on
  a new number's first contact. Ambiguous windows are skipped.
- `stages.ts` — pure: Real lead / Quote sent / Won job for one click, from
  Quo activity and QBO estimates/invoices. One orderId per stage per phone.
- `run.ts` — one run: GA4 → Quo → match → Redis → stages → upload via the
  Data Manager API (Ads' UploadClickConversions is allowlist-only since
  2026-06-15 and returns CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE for us).
  Modes `off | dry | live`; dry matches in memory, uploads with validateOnly, stores nothing
  but the run summary.
- `setup.ts` — the three UPLOAD_CLICKS actions, created SECONDARY.

## Rules

- Runs from the worker (`apps/worker/api/ads-conversions.ts`, daily) and
  `tools/src/ads-conversions/run.ts` (backfill / manual dry runs).
- Never change bidding or goals from code. Creating actions and flipping
  the primary goal are owner-approved, manual steps.
- Keys come from `@aac/shared-utils/redis` (`adsClicks`, `adsConversionsSent`,
  `adsConversionsLastSummary`, `cronLastRun('ads-conversions')`).
