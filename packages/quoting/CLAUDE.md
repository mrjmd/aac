# @aac/quoting — Quote Drafting Pipeline

You are working in the quote-drafting package. This is the canonical home
for the photo-analysis + business-rules-informed quote drafting + QB
Estimate creation pipeline.

## What This Is

Empty at scaffold time. Documented here so future sessions don't bolt
quoting into apps/middleware — quoting is a *core reusable service*, not
a middleware feature.

## Future entry points

- `apps/middleware` — agent-driven quote drafting (Matt prompts the agent, agent calls quoting)
- (future) `apps/website` — instant-quote-from-photos public-facing UI
- (future) `apps/partner-app` — realtor / home-inspector entry surface

## Future shape (subject to design)

- Photo intake + storage handoff (Vercel Blob or similar)
- Photo analysis via Gemini Vision or Claude Vision
- Business-rules layer encoding job-size heuristics, service-line pricing, regional adjustments
- LLM draft generation with quote summary + line items
- QB Estimate creation via `@aac/api-clients/quickbooks`
- Handoff to `@aac/scheduling` on acceptance

## Rules (provisional — refine when actually building)

- **Pure logic.** No webhook reception. No authentication.
- **Deps injected.** Don't construct clients.
- **Strict TypeScript.**
- **Quality gates.** Per [[ai-quality-gates]] memory: never present raw AI
  output. Automated checks before showing to user or sending to customer.
- **Vitest with mocked deps.**

## Related

- `@aac/scheduling` — downstream of accepted quotes
- `@aac/agent-tools` — read tools any LLM-driven quoting flow may use
- `docs/projects/quoting.md` — TBD design spec
