# Automations readiness page, and the big-idea backlog (2026-11-06)

Matt, 11/06: "We absolutely need this built." The mockup is approved in
principle and is the spec once he signs off on its details:
https://claude.ai/artifact/UpDmcyToXtJ5wK6Hm2bTUS

## Part 1: System > Automations (to build)

### Why

Two stages, from Matt's side (11/06: shadow vs draft is no real difference
to him): **drafts for you** (it suggests; you send, edit or ignore) and
**does it itself** (it acts; you can undo). A "shadow" that only logs is
just drafting nobody looks at, so it is not a stage on the page. The docs
have always said each automation moves up when it has earned it
(`docs/projects/apps-agent.md` autonomy ladder; `docs/projects/agent-vision.md`
Layer 5; command center README §12 "per-automation acceptance rate"). What we
have today is the crawl part only. Drafts get made, but almost nothing records
what Matt did with them, nothing learns from his edits, and nothing tells him
when one is ready.

What each automation records today (audited 11/06):

| Automation | What it records about Matt's response | Learns from it? |
|---|---|---|
| Quote drafter | `tools/src/quote-trigger/harvest-edits.ts` (laptop, by hand) diffs each bot draft against QBO: 37 drafts, 7 sent/accepted, 13 edited, 4 deleted, 13 untouched | Only at a manual Section V re-distill |
| Stale-quote follow-ups | `sentDetectedAt` (any outbound after the draft) and `repliedWithin7d` | No; never compares wording |
| Quote follow-up, intake, CT, referral drafts | Nothing after the note is posted | No |
| Scheduling | yes / no / edit replies on hand-fired proposals only; the 95% exit bar in `docs/projects/scheduling.md` is not measured | No |

Two grading bugs found in the quote numbers:
- The harvester counts the Guarantee line as an owner edit, but
  `packages/quoting/src/draft-quote.ts` appends it itself. 10 of the 13
  "edited" drafts changed nothing else. Re-graded: of 24 decided, 10 used as
  drafted, 10 changed, 4 deleted (42%).
- "Untouched" mixes "emailed as is, still Pending" with "not looked at yet".
  QBO's estimate email status can separate them.

### What to build, in order

1. **Grader (cloud worker, daily).** For every draft any automation made,
   find what Matt actually did and grade it: used as drafted, light edit,
   changed, thrown out, or not graded yet. Texts: the next outbound to that
   contact after the draft, text similarity against the draft. Quotes: move
   harvest-edits into the worker, ignore the auto Guarantee line, read the
   email-sent flag. Scheduling: the slot booked vs the slot suggested. Live
   automations (inbound router): reversals. One Redis record per draft, keys
   in `@aac/shared-utils/redis`. No customer-facing change.
2. **The page.** System gets a Health | Automations switch. One card per
   automation: stage (drafts for you / does it itself), meter (proven and raw against the 90% bar), last 20 outcomes, since
   date. Drill-in: weekly outcomes chart, the bar as a checklist, a **By kind of case** table (per kind: right of graded, raw, proven vs the bar, hurt count, status, and its own auto-send switch, live only once that kind qualifies), what it
   learned, recent drafts with what it wrote vs what Matt sent.
3. **Lessons (weekly).** An LLM pass over the week's changed drafts groups
   Matt's edits into patterns and writes a proposed rule change with its
   evidence. Proposes at 3+ examples; under that it shows "1 example,
   proposes at 3". Matt approves, rejects, or talks it through. Approved
   rules go into the automation's prompt or ruleset by a normal commit; it
   never rewrites itself silently. His best sent texts become its examples.
4. **Graduation.** When every line of an automation's bar is met, it raises
   one item on Today offering the switch. Turning on and off is per
   automation and always Matt's. A live automation that gets reversed twice
   in a week goes back to drafting and says why.

### The bar (decided by Matt, 2026-11-06)

No time box: volume decides, since winter may give 20 drafts in the time
summer gives 200. All four must hold, for every automation (scheduling
included, replacing its old 95% exit criterion):

1. **Proven at least 90% right**: the one-sided 95% Wilson lower bound on
   the share graded right is 90% or more. Rough volume this takes: 25 right
   in a row, 50 at 96%, or about 100 at 95%.
2. **Raw 95%+ right.**
3. **Nothing that would have hurt in the last 50** (e.g. texting someone who
   already said no). One resets the count.
4. **Each kind of case qualifies on its own** (e.g. crack injection vs
   resurfacing quotes; T1 vs T3 check-ins). Kinds without the volume stay
   drafted.

Grades: as-is, cosmetic (counts as right), real change (a wrong fact,
price, date or tone: a miss), would have hurt. The automatic grader is
checked against Matt's own grading first (he hand-grades about 30 once,
then a few a week) before its grades count toward the bar.

Rules that follow from it:
- Count graded drafts since the automation's last rule change; older ones
  describe a different version. Frequent small fixes slow graduation, and
  the page should show that.
- Turning one on covers only the kinds of cases that cleared the bar (or,
  once a calibrated confidence exists, only the cases it is sure about);
  the rest keep drafting.
- Each card shows a forecast ("at this pace, proven 90% around Nov 20").
  Improvement curves flatten, so waiting for 98% is usually not worth it.
- After it is on: a random 1 in 5 of its sends is still graded, plus
  everything Matt undoes. Two undos in a week or a "would have hurt" puts
  it back to drafting.

First candidates: the "just sent your quote" text and stale-quote T1.

## Part 2: Big-idea backlog (captured, not scheduled)

Matt asked these be written down; none is approved for building.

### A. Claude conversations and agent control inside the command center

Goal: run and steer the agents that improve the system from the command
center, without paying per token for everything.

- A full chat inside the command center needs the Claude API (Agent SDK),
  billed per token. A Claude subscription can't power our own app.
- What the subscription does cover: Claude Code itself (this terminal, the
  desktop and web apps at claude.ai/code) and scheduled cloud routines.
- Workable middle: the command center holds a task queue ("look into X",
  "approve lesson Y and ship it"). A routine or a Claude Code session picks up
  queued tasks, works in the repo, and writes the result back as an item. The
  command center links straight to the session for the conversation itself.
- Check current plan terms and usage limits before building.

### B. Weekly research agent

A weekly routine that reads this repo's plans and CLAUDE.md files to know
what we run, searches for new tools, models, APIs and techniques, and posts
3-5 specific "here is how this would improve X" ideas into a command center
Ideas queue (approve / park / dismiss, with dismiss reasons feeding next
week's run). Needs a write path for items from outside the apps. Fits the
subscription as a routine.

### C. Cheap yes/no checks instead of full LLM calls

The startup is TypeSafe AI and the model is **Jev** (limited early access
since 2026-09-15). It answers only fixed-answer questions (yes/no, pick one,
a rating) and returns a probability per answer, claimed calibrated, in about
70-500 ms. OpenAI reportedly has a "Decisions API" preview along the same
lines (not officially documented as of 11/06).

For AAC, speed and cost barely matter: our Gemini volume costs pennies. The
gain is **calibrated confidence**, which is exactly what the readiness page
and auto-send gates need (photo-quote self-reported confidence barely
separates good from bad: 71% vs 56%).

Fixed-answer decisions we ask Gemini today:
- Stale quotes: `needsReply` (yes/no) and `intent` (declined /
  went-elsewhere / later / engaged / none), `packages/stale-quotes/src/prompts.ts`.
- Intake: lead / solicitation / other, and the can-help verdict,
  `packages/message-drafts/src/voice.ts`.
- Router: classification and intents, `packages/inbound-router/src/read.ts`
  (bundled with extraction of name, address, photo notes, so only the
  decision half would move).
- Scheduling intent, `GeminiClient.classifySchedulingIntent`.
- New: the grader's "is what Matt sent essentially the draft?".

Next step if pursued: request early access, add a client in
`@aac/api-clients`, and replay past labeled cases (stale-quote extractions,
intake verdicts, quote edit labels) through it next to Gemini. Switch only
where it is as accurate and its probabilities actually separate right from
wrong. New vendor in early access, so not on any live path until then.

### D. Leaving Quo for our own phone system on Twilio (years out)

- Usage cost is probably not the blocker. At AAC volume (a few thousand texts
  and some hundreds of call minutes a month), Twilio usage plus 10DLC
  registration likely lands in the same range as Quo seats. Price it for real
  before deciding.
- The real cost is everything Quo's apps do: the phone app on Matt's and the
  team's phones (push, calling, voicemail, transcripts, shared inbox), number
  porting, carrier registration and deliverability, call recording consent.
- What would justify it: Quo's API blocking something we need (no drafts or
  scheduled-send API, the 10/19 webhook auto-disable, destructive PATCH).
- Cheap insurance now: keep every Quo call behind `QuoClient` so a swap is
  one client.

### E. More than one technician

Every scheduling, field-app and pay path assumes Mike. Before tech #2
(Mar 2027 plan): technician as a field on every job, event and photo;
per-tech skills and limits (e.g. no large resurfacing for Mike); per-tech
calendars or attendees in `suggestSlot`; per-tech callbacks and
accountability metrics; field app scoped to the signed-in tech. Recording
"who did this job" now is cheap and saves a backfill.

### F. A sales view

One command center with roles, not a separate app (the field app stays the
tech's on-site tool). A salesperson sees their leads, quotes, follow-up
queue and drafts. The owner sees their activity: response time, follow-ups
done vs due, quotes sent, close rate, what was dropped. Roles already exist
in the agent spec (`owner`, `technician`, `salesperson`).
