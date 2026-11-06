# Can-help gate, standing rules, referrals

**Status:** planned 2026-11-04 (owner request). Steps 1-3 shipped the same day (worker deployed); step 5 built 2026-11-05 (CC deploy pending); step 4 next. Step 3 does not yet save the read for the quote drafter to reuse.
**Evidence:** `analysis/02-strategy/decline-patterns-2026-11.md` (~150 declines mined
from Matt's texts), `analysis/02-strategy/short-crack-pricing-2026-11.md`.

## Why

Sean (+19786092237, 2026-11-04) sent photos of a leaking cinder block bulkhead.
The intake drafter asked for name/address/email (it never looks at photos), and
the quote drafter drafted a \$1,900 Bulkhead Injection. Matt: photos gate every
step; when they show work we can't do, kindly decline fast and get out of the loop.

## Owner decisions (2026-11-04)

- Leaking cinder block = always decline (incl. block bulkheads). Non-leaking block
  stair-step cracks are good business (carbon fiber staples, or repointing).
- Parged-block or stone bulkhead that is actively leaking = decline.
- Short-crack tiers: full \$1,175; partial/short \$875; tiny add-on \$475; any
  crack-only job \$875 minimum. (Section 0 rule 6.)
- Resurfacing pause: large square-footage only (stairs and small panels are fine);
  ends when tech #2 starts, possibly spring. Time-bound.
- (2026-11-05) Bowing or displacement over 1 inch goes to a structural engineer first
  (was 1.5"). Referrals get the company's public number, not the owner's cell
  (Air Guardian main line, not Tanner).

## Build steps

1. **Quote drafter declines (SHIPPED 11/04).** Rulesets carry the decisions above;
   a full decline posts a Quo note with reasons and a suggested reply, no estimate.
2. **Standing rules + referrals as data.** One Redis-backed store in `@aac/quoting`
   (defaults in code, keys in `@aac/shared-utils/redis`):
   - *Referrals:* who, contact, what kinds of work we send them, notes.
   - *Standing rules:* owner policies with `since`, optional `until` / "until
     condition" text, and a `reviewBy` date (e.g. the resurfacing pause).
   Both drafters read the active rules and the referral list into their prompts.
3. **Intake photo read.** When a first inbound has photos, read them (Gemini vision)
   before drafting the first reply. Verdict: `can-help` | `cant-help` (with
   category + referral) | `need-info` (e.g. "is the bulkhead block or poured
   concrete?"). The intake note then carries a kind decline + referral, a single
   clarifying question, or the normal name/address/email ask. Save the read in Redis
   per phone so the quote drafter can reuse it instead of re-reading.
4. **Referral listener.** Any inbound (not just first touch) that the read or the
   T4-style gate marks as out of scope drafts a referral message to a Quo note,
   using the Referrals list. Never sends. BUILT 11/05 as the inbound router's
   referral route (`docs/plans/inbound-router.md` phase 4).
5. **Command center: Referrals page (BUILT 11/05, mockup Pst2iVyZze9Y9TsawzrhRm
   approved).** `/referrals`: who we send what (edit in place, private note),
   time-bound policies (edit, end now), decline rules (edit, pause, + rule) on the
   same page since each rule points at its referrals. A policy whose `reviewBy`
   arrives becomes an admin item (`fromRuleReview`). Rail count = referrals
   missing a phone. The "Referral drafts" section lists decline and referral notes from the drafts runlog.
