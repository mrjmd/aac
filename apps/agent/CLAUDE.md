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

- **Stack:** raw Vercel Serverless Functions (`@vercel/node`), same as `apps/middleware/`. No Next.js. The monorepo pattern is UI apps on Next.js (`apps/field`, `apps/command-center`, `apps/marketing`), API-only apps on raw Vercel functions (`apps/middleware`, `apps/agent`). Template handler shape: `apps/middleware/api/webhooks/google-ads.ts`.
- Reads/writes: Pipedrive (deals, persons, activities), Quo (messages, conversation history), QuickBooks, Google Calendar, Gemini (LLM)
- Shared state with middleware: Upstash Redis (same database, different keyspace under `agent:*`)
- Comms line: dedicated Quo phone number `(617) 766-0151`, whitelist on Matt's personal number
- **Identity by phone number.** Whoever texts the agent line is identified by which phone they texted from, looked up in `AGENT_USER_ROLES` (env JSON: `{"+1...": "owner" \| "technician" \| "salesperson" \| "triage"}`). Only `owner` has a concretely defined tool scope at Crawl/Walk start.
- **Internal-only.** Customers are never exposed to a conversational AI surface here. Customer-touching automations may use LLM-composed copy but must always feel like an automated message from a human.
- **Read-tool surface is role-scoped at the registry layer, not the response layer.** The LLM session for a given caller is only registered with tools that caller is allowed to use.

## Env

| Var | Required | Purpose |
|---|---|---|
| `QUO_API_KEY` | yes | Shared with middleware |
| `QUO_AGENT_PHONE_NUMBER` | no | Agent comms line; defaults to `+16177660151` |
| `MATT_PERSONAL_PHONE_NUMBER` | yes | E.164 whitelist for owner messages |
| `AGENT_USER_ROLES` | no | JSON: `{"+1...": "owner" \| ...}`. Defaults to empty. |
| `PIPEDRIVE_API_KEY` / `PIPEDRIVE_COMPANY_DOMAIN` / `PIPEDRIVE_SYSTEM_USER_ID` | yes | Shared with middleware |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | yes | Shared Redis |
| `CRON_SECRET` | prod only | Vercel cron auth — same secret as middleware |
| `NODE_ENV` | — | `development` or `production` |

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
