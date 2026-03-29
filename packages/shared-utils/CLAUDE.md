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
| `redis.ts` | Key schema builders, TTL constants |
| `logger.ts` | Structured JSON logging |
| `types.ts` | Shared TypeScript interfaces (Lead, Estimate, WebhookEvent, etc.) |
