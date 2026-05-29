# @aac/agent-tools — LLM Tool Surface

You are working in the shared LLM tool surface package. Every tool exported
here is a pure function `(deps, [config], input) → Promise<Summary>` shaped
for direct binding into Anthropic tool-use or Gemini function-calling.

## What This Is

The seven read tools the agent (and any other LLM-calling code in the
monorepo) uses to ask questions across PD, QB, Quo, and Google Calendar:

- `getCustomerContext` — holistic view of a contact (person + deals + Quo + events)
- `searchCalendar` — list calendar events by range / location / color
- `listDeals` — list deals by stage / person / date range
- `getDeal` — one deal + linked person/estimate/invoice/events
- `findJobsMissingInvoices` — green events with no matching QB invoice
- `getInvoiceSummary` — aggregate QB invoices in a range
- `searchConversation` — Quo SMS history for a contact, with optional substring filter

Tools return **summary** shapes (compact, LLM-friendly projections) defined
in `types.ts` — not the raw client types.

## Rules

- **Pure functions only.** No `process.env`. No module-level state.
- **Deps injected.** Each tool takes `ToolDeps = { pd, qb, quo, cal }` as
  the first argument. The package never constructs clients.
- **Throw on transport errors. Never throw on not-found.** Not-found returns
  `null` (or empty array, or a summary with null fields). The LLM should
  see "no record" as a normal result, not an exception.
- **Strict TypeScript.** No `any`. No `@ts-ignore`.
- **Vitest with vi.fn-mocked deps.** Don't hit real APIs in tests.
- **Tools don't own role-scoping.** Apps decide which tools each caller may
  use. This package exports `buildOwnerToolDefinitions(deps, config)` as a
  convenience for the owner toolset; role-routing logic stays in the app.

## What does NOT belong here

- Webhook handlers (those live in apps/middleware or apps/agent)
- Identity / role lookup (apps/agent's `roles.ts`)
- Stateful conversation context (apps/agent only)
- Write tools — not until they're explicitly designed; this package is read-only today

## Dependencies

- `@aac/api-clients` — Client types + `parseDealMarker` helper
- `@aac/shared-utils` — Logger, key builders if/when needed
