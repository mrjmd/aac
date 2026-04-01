# Middleware Cutover — Rollback Reference

**Date:** 2026-04-01
**Old project:** aac-middleware (`https://aac-middleware.vercel.app`)
**New project:** aac-middleware-monorepo (`https://aac-middleware-monorepo.vercel.app`)

## Old Webhook URLs (restore these to roll back)

| Service | Setting Location | Old URL |
|---------|-----------------|---------|
| **Pipedrive** | Settings > Webhooks > *.person | `https://aac-middleware.vercel.app/api/webhooks/pipedrive` |
| **Quo/OpenPhone** | Settings > Webhooks | `https://aac-middleware.vercel.app/api/webhooks/quo` |
| **Google Ads** | Lead form extension > Webhook URL | `https://aac-middleware.vercel.app/api/webhooks/google-ads` |

## Pipedrive Webhook Config (old)

- **Name:** Aac Middleware
- **Events:** *.person
- **Permission level:** Matt Davis
- **Endpoint URL:** `https://aac-middleware.vercel.app/api/webhooks/pipedrive`
- **Version:** v2
- **Created:** Dec 19, 2025 11:56 AM

## QuickBooks OAuth

- **Old redirect URI:** `https://aac-middleware.vercel.app/api/auth/quickbooks/callback`
- **New redirect URI:** `https://aac-middleware-monorepo.vercel.app/api/auth/quickbooks/callback`
- Both are registered in the Intuit Developer Portal
- Tokens are stored in shared Redis — both old and new middleware can use them
- To roll back: visit `https://aac-middleware.vercel.app/api/auth/quickbooks/connect` to re-authorize with the old redirect URI

## Google Ads Webhook Key

- `google_key` value is set as `GOOGLE_ADS_WEBHOOK_KEY` env var on both Vercel projects

## Rollback Steps

1. Re-create Pipedrive webhook pointing to old URL (*.person events, v2)
2. Update Quo/OpenPhone webhook URL back to old URL
3. Update Google Ads lead form webhook URL back to old URL
4. (Optional) Re-authorize QuickBooks OAuth via old connect URL
5. Old Vercel project (`aac-middleware`) is still running — no redeployment needed

## Notes

- Both old and new middleware share the same Upstash Redis instance
- Deduplication prevents double-processing if both receive the same event
- No data migration needed in either direction
