# @aac/shared-utils — Shared Utilities

You are working in the shared utilities package. This is the foundation layer
that ALL other packages, apps, and tools depend on.

## Rules

- **No breaking changes** without checking all consumers.
  Run `pnpm turbo build` from the repo root to verify.
- **`strict: true` is mandatory.** No `any` types. No `@ts-ignore`.
- **Phone normalization is THE single source of truth.** There is exactly one
  `normalizePhone()` function in this entire monorepo, and it lives here in
  `src/phone.ts`. It must handle every edge case. It is Vitest-protected.
- **Redis keys are defined here and ONLY here.** The key schema in `src/redis.ts`
  is the global contract between all apps. Never hardcode Redis key strings
  in any app.
- **Run tests after every change:** `pnpm test`

## Exports

| Module | Purpose |
|--------|---------|
| `phone.ts` | Phone normalization (E.164), parsing, matching, Redis format |
| `address.ts` | Street addresses: `streetKey`/`sameStreet`/`addressesMatch` (house + street + unit identity), `streetLine` (street line, "St" ≡ "Street"; multi-day chains), `houseNumberAndWordMatch` (loose; visit photos) |
| `calendar.ts` | Calendar conventions: color IDs, HOLD/STUB prefixes, technician emails, busy rules (`isBusyEvent`, `selectBusyEvents`, `isTechOutOfOffice`) |
| `eastern.ts` | Eastern business day: `easternDate`, `easternDayRange`, `easternOffset`, `easternWallTime`, `shiftDate`, `daysBetween`, `isCalendarDate` |
| `redis.ts` | Key schema builders, TTL constants |
| `health.ts` | Health bookkeeping, Redis client as a parameter: `logHealthError`, `trackCronRun`, `writeHeartbeat`, `trackWebhookProcessed`, and `countCondition` (silent-skip counts per Eastern day in `health:conditions:{day}`, 14-day TTL; optional entity; rolling 2h window for `ROLLING_CONDITIONS`; names and labels in `CONDITIONS`). Readers (middleware /api/health, command center System health, agent error-surface, watchdog, triage) depend on the exact keys and value shapes |
| `inbound-settle.ts` | Inbound router settle rule: `settleDueAt` (last + 2 min, capped at first + 10 min) |
| `qbo-tokens.ts` | `qboTokenStore(redis)`: the shared QBO token slot + refresh lock, as QuickBooksClient callbacks |
| `webhook-signature.ts` | `verifyOpenPhoneWebhookSignature` (Quo HMAC), `timingSafeEqualString` (constant-time secret/bearer compare, fails closed on empty) |
| `return-path.ts` | `safeReturnPath(next, origin?)`: post-login return-to guard (same-origin path + query, else `/`) |
| `logger.ts` | Structured JSON logging |
| `types.ts` | Shared TypeScript interfaces (Lead, Estimate, WebhookEvent, etc.) |
