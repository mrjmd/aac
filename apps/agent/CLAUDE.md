# Agent — Conversational Agent Platform

You are working in `apps/agent/`, the sixth pillar of the AAC monorepo — the
conversational agent platform that handles the agent comms line, deal spine,
intent classification, and the LLM tool surface.

## What This Is

The platform layer for Matt's text-based interface to AAC's operational
systems. The agent receives signals (inbound customer messages on the main
line, Matt's directives on the agent comms line, middleware error events,
deal-stage transitions) and produces actions (proposals to Matt, executed
writes, queries, diagnoses).

This is the canonical home for the Phase 2.5 deal-spine work originally
designed for middleware — split out per the 2026-05-27 architecture decision
because middleware is sacrosanct (minimal changes, stateless webhook
processing) and the agent platform has different change cadence + state
model + runtime needs.

## Scope

- **Conversation runtime:** intent classification, multi-turn proposal state, autonomy ladder
- **Deal spine:** Pipedrive deal CRUD as load-bearing infrastructure (downstream consumers: apps/field v2, calendar scheduling, quote auto-draft)
- **Read-tool surface:** unified set of LLM-callable functions for cross-system queries (`getCustomerContext`, `searchCalendar`, `listDeals`, `getInvoiceSummary`, etc.)
- **Agent comms line webhook handler** — separate dedicated Quo number, whitelisted to Matt's personal phone
- **Diagnostic agent:** middleware error events → diagnosis + proposed fix → Matt via SMS
- **Standing-rule memory:** corrections and rules from Matt's text directives persist as structured constraints

## Rules

- **Stateful by design.** Unlike middleware, agent maintains in-flight proposal state, conversation context, standing rules.
- **LLM-heavy runtime.** Tool chains may take seconds to minutes. Use streaming and longer Vercel function durations (or queue-based async).
- **Import API clients from `@aac/api-clients`.** No direct fetch to Pipedrive, Quo, QuickBooks, or Gemini.
- **Deal as spine.** Pipedrive deals are agent-managed only. No manual deal touches outside the agent. Matt's only deal interface is via the agent comms line or by reading PD UI.
- **Autonomy is per action type.** No global autonomy flag; each action class has its own trust level that Matt promotes explicitly.
- **`propose` is a dialogue, not a button.** Multi-turn conversation with Matt; not a single confirm-or-deny prompt.

## Architecture

- Next.js 15 (or alternative TBD per spec — App Router likely)
- Reads/writes: Pipedrive (deals, persons, activities), Quo (messages, conversation history), QuickBooks, Google Calendar, Gemini (LLM)
- Shared state with middleware: Upstash Redis (same database, different keyspace)
- Comms line: dedicated Quo phone number `(617) 766-0151`, whitelist on Matt's personal number

## What Does NOT Belong Here

- Webhook reception for customer-facing channels (stays in `apps/middleware/`)
- Tech-facing UI for job completion (that's `apps/field/`)
- Analytics dashboards (that's `apps/command-center/`)
- Marketing automation (that's `apps/marketing/`)
- Heavy-lift batch processing (that's `tools/` or `apps/marketing/`)

## Related

- Project spec: `docs/projects/apps-agent.md` (TBD)
- Architecture decisions: `docs/DECISIONS.md` — especially 2026-05-27 entries on apps/agent split + deal-spine prerequisite
- Historical context: `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md` (the original 44k-byte spec that motivated splitting agent out of middleware; remains the most detailed design thinking available — refer to it when in doubt about intent)
- Current plan: `docs/PLAN.md`
