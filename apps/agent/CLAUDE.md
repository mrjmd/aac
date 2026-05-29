# Agent — Conversational Agent Platform (PAUSED at Walk 2)

You are working in `apps/agent/`, the sixth pillar of the AAC monorepo —
Matt's text-based interface to AAC. **This app is paused at Walk 2 as of
2026-05-29; only the comms-line listener (Walk 1) is live in prod.**

## ⏸ Paused — read this first

The 2026-05-29 architecture realignment moved most of what this spec
originally claimed into other homes:

| Originally here | Now lives in |
|---|---|
| LLM read-tool surface (the 7 tools) | `packages/agent-tools/` |
| Intent classification | `apps/middleware/` (extends existing Gemini classifier) |
| Scheduling pipeline + SchedulingDirective | `packages/scheduling/` (scaffolded, impl TBD) |
| Stub event creation | `packages/scheduling/` |
| Diagnostic agent (middleware errors → SMS) | `apps/middleware/` |
| Stale-deal nudges (Funnel A Phase 2) | `packages/scheduling/` |

apps/agent's *actual* purpose, going forward, is Matt-facing dialogue.
Listening to customer comms is middleware's job (already wired). Adding a
second webhook listener to the same business line was a code smell I
caught only after Matt pushed on it — this app's scope shrunk accordingly.

apps/agent resumes active development when the agent-vision Layer 1/3/4
work begins:

- **Layer 1 — Voice fidelity** (behavioral cloning from Matt's Quo corpus)
- **Layer 3 — Strategic-partner mode** (extended-think queries)
- **Layer 4 — Self-reflective improvement** (agent reviews its own audit log)

See `docs/projects/agent-vision.md` for the long-term destination.

## Current scope (post-2026-05-29 realignment)

- **Agent comms line webhook handler** — dedicated Quo number `(617) 766-0151`,
  whitelisted to Matt's personal phone. Shipped Walk 1, LIVE in prod.
- **(Future) Propose-dialogue endpoint** — middleware POSTs here when it
  needs to confirm an action with Matt. Agent sends the SMS from the agent
  line, listens for the reply, calls back to middleware with the decision.
- **(Future) Strategic mode / voice-clone / self-reflection runtime** —
  Layer 1/3/4 work.

## Active rules

- **Stateful by design.** Unlike middleware, agent maintains in-flight
  proposal state, conversation context, standing rules.
- **LLM-heavy runtime.** Tool chains may take seconds to minutes. Use
  streaming and longer Vercel function durations (or queue-based async).
- **Import API clients from `@aac/api-clients`.** Import LLM tools from
  `@aac/agent-tools`. No direct fetch to PD / Quo / QB / Gemini.
- **Identity by phone number.** Whoever texts the agent line is identified
  by which phone they texted from, looked up in `AGENT_USER_ROLES` (env
  JSON: `{"+1...": "owner" \| "technician" \| "salesperson" \| "triage"}`).
- **`propose` is a dialogue, not a button.** Multi-turn conversation with
  Matt; not a single confirm-or-deny prompt.
- **Internal-only.** Customers are never exposed to a conversational AI
  surface here. Customer-touching automations live in middleware.

## Architecture

- **Stack:** raw Vercel Serverless Functions (`@vercel/node`), same as
  `apps/middleware/`. Template handler shape:
  `apps/middleware/api/webhooks/google-ads.ts`.
- Shared state with middleware: Upstash Redis (same database, different
  keyspace under `agent:*`).
- Comms line: dedicated Quo phone number `(617) 766-0151`, whitelist on
  Matt's personal number.
- **Role-scoping for tools lives in `apps/agent/lib/tool-registry.ts`.**
  Wraps `buildOwnerToolDefinitions` from `@aac/agent-tools` with
  `AgentRole`-based routing.

## Env

| Var | Required | Purpose |
|---|---|---|
| `QUO_API_KEY` | yes | Shared with middleware |
| `QUO_AGENT_PHONE_NUMBER` | no | Agent comms line; defaults to `+16177660151` |
| `MATT_PERSONAL_PHONE_NUMBER` | yes | E.164 whitelist for owner messages |
| `AGENT_USER_ROLES` | no | JSON: `{"+1...": "owner" \| ...}`. Defaults to empty. |
| `PIPEDRIVE_API_KEY` / `PIPEDRIVE_COMPANY_DOMAIN` / `PIPEDRIVE_SYSTEM_USER_ID` | yes | Shared with middleware |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` / `QUICKBOOKS_REALM_ID` / `QUICKBOOKS_REDIRECT_URI` | yes | Shared with middleware |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | yes | Shared Redis |
| `CRON_SECRET` | prod only | Vercel cron auth — same secret as middleware |
| `NODE_ENV` | — | `development` or `production` |

## What does NOT belong here

- **Webhook reception for customer-facing channels** — `apps/middleware/`
- **Intent classification** — `apps/middleware/` (extends Gemini classifier)
- **Scheduling pipeline** — `packages/scheduling/`
- **Quoting pipeline** — `packages/quoting/`
- **LLM tool implementations** — `packages/agent-tools/`
- **Tech-facing UI** — `apps/field/`
- **Analytics dashboards** — `apps/command-center/`
- **Marketing automation** — `apps/marketing/`
- **Heavy-lift batch processing** — `tools/` or `apps/marketing/`

## Related

- Project spec: `docs/projects/apps-agent.md` (carries the pre-realignment
  scope as historical reference; the post-realignment status table at the
  top of that doc is authoritative)
- Long-term vision: `docs/projects/agent-vision.md` (5-layer ambition that
  governs Layer 1/3/4 work when apps/agent resumes)
- Architecture decisions: `docs/DECISIONS.md` — especially the 2026-05-29
  realignment entry
- Historical context: `docs/_archive/2026-05-27/middleware-phase-2.5-deal-spine.md`
- Current plan: `docs/PLAN.md`
