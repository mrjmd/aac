# Research: Owner Dashboard UX Patterns (2026-11-02)

Web research for `README.md`. Sources are product help docs/changelogs; vendor claims flagged. Unverified items listed at the end.

## 1. Field-service / trades dashboards

**Jobber Home** ([help](https://help.getjobber.com/hc/en-us/articles/23846836592023)): setup guide, Today's appointments, Payments, Reminders, Business performance. Today's appointments header shows the day's \$ value plus Total / Active / Completed / Overdue / Remaining. Reminders only appear when there's something. Business performance shows receivables with the **top 3 overdue clients by name**, jobs this week vs last week, month revenue. Mobile "Business health" is fixed to the calendar week ([update](https://productupdates.getjobber.com/76944-track-your-business-health-from-the-jobber-app)).
- Steal: render sections only when non-empty; name the specific overdue clients.
- Anti-pattern: Jobber's own help contradicts itself on what "revenue" means. Pin one definition per metric.

**Housecall Pro** ([help](https://help.housecallpro.com/en/articles/6974306-homepage-overview-and-faq)): **Open Items** first: open estimates, unpaid invoices, unscheduled jobs, each with count + \$ total, each linking to the filtered list. Stats toggle Today/WTD/MTD/QTD with **same period last year** comparisons. Stats hideable, not reorderable.
- Steal: "count + \$ + click to filtered list" tiles; YoY for a seasonal business.

**ServiceTitan** ([help](https://help.servicetitan.com/v1/docs/dashboard-business-metrics.md)): revenue meter with a **"Missed"** figure estimating revenue lost to unbooked calls, unconverted jobs and cancellations. Trends: 18 months monthly / 26 weeks weekly. Every KPI has an Info icon: definition, calculation, **which date field** (completion, sold-on, invoice, call date), and drills to a report column.
- Steal: a "Missed" metric (demand is AAC's constraint); show each metric's date basis (QBO/PD/GA timezone drift is a known AAC issue).

**Workiz / BuildOps**: Workiz has show/hide widgets with role permissions ([help, 403; snippet only](https://help.workiz.com/hc/en-us/articles/18054340308113)). BuildOps leans on project profit-to-date, margin, over/under-billing ([G2](https://g2.com/products/buildops/reviews)), relevant to a Commercial page.

## 2. Small-business home screens

**Shopify Home** ([help](https://help.shopify.com/en/manual/shopify-admin/shopify-home)): four customizable metric tiles, then order tasks grouped by type with counts. **Cards are dismissible except order tasks**: money-critical work can't be swiped away. Insights capped at **3 per day**, expire after 24h, nothing shown if nothing is notable. **Sidekick Pulse** shows up to **5** recommendation cards; dismissing asks **why**, which personalizes future cards; nothing goes live without approval ([Pulse](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/pulse), [changelog](https://changelog.shopify.com/posts/proactive-business-recommendations-from-sidekick)).

**Stripe**: home shows analytics plus notifications for unresolved disputes/verifications; widgets add/remove ([docs](https://docs.stripe.com/dashboard/basics)); charts labeled "estimated" ([support](https://support.stripe.com/questions/dashboard-home-charts-overview)).

**QuickBooks Online**: home widgets add/move/resize ([help](https://quickbooks.intuit.com/learn-support/en-us/help-article/product-setup/customize-home-page-quickbooks-online/L0ryPsyjD_US_en_US)). The **Business Feed** is a prioritized summary of **actions QuickBooks already did for you, for review/approval** ([Intuit](https://investors.intuit.com/news-events/press-releases/detail/1258/intuit-introduces-ground-breaking-virtual-team-of-ai-agents-to-fuel-growth-for-businesses)).
- Steal: a separate "automation did this, confirm" lane, distinct from "you need to act."

**Ramp** ([support](https://support.ramp.com/introduction-to-homepage)): merged Inbox and MyRamp into one Homepage of tasks + updates. The action list *is* home.

## 3. Action inbox / triage UX

**Linear Triage** ([docs](https://linear.app/docs/triage)): Accept / **Decline** (moves to Canceled with optional reason comment, kept not deleted) / Duplicate (merge) / **Snooze** (returns at time **or on new activity, whichever first**). Triage rules auto-apply on entry; AI suggests properties and duplicates. **Linear Inbox** ([docs](https://linear.app/docs/inbox)): default "Priority" tab; unsubscribe at the source.

**Superhuman** ([Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done)): Done archives; **a reply automatically brings the thread back**. Reminders return at a set time; auto-reminders fire if no one replies.

**Things 3** ([Today](https://culturedcode.com/things/support/articles/4001304/)): Today is a *filter* (start date or deadline today). Manual drag order. Calendar events on top, "This Evening" at bottom. Future dates go to Upcoming and flow into Today automatically ([when](https://culturedcode.com/things/support/articles/2803579/)).

**Sunsama**: unfinished tasks roll over; after N consecutive rollovers they auto-archive ([rollover](https://help.sunsama.com/docs/task-rollover-and-recurring-tasks-the-basics)). Daily priority resets daily, backlog priority persists ([priority](https://help.sunsama.com/docs/usage-guides/tasks/task-priority)). AI planning marks agent-created items with "+", shows uncertain moves as "judgement calls," and offers Undo / Undo all / Re-plan ([daily planning](https://help.sunsama.com/docs/usage-guides/daily-planning)).

**Todoist** ([sorting](https://www.todoist.com/help/articles/default-sorting-order-in-todoist-mqmgerY7)): smart sort is due time, then priority, then manual order; free drag only in Manual mode; overdue items can't be manually sorted. Lesson: mixing algorithmic and manual order confuses people.

**Motion (anti-pattern)**: auto-scheduling "shuffles tasks unpredictably" and overrides user choices ([ClickUp](https://clickup.com/blog/motion-review/), [Saner](https://blog.saner.ai/motion-reviews); competitor/affiliate blogs, directional only).

## 4. Dashboard principles

**Stephen Few**: a dashboard is the most important information on **one screen**, monitored **at a glance**. Top mistakes: exceeding one screen, inadequate context, excessive detail/precision ([UXmatters](https://uxmatters.com/mt/archives/2007/04/book-review-information-dashboard-design.php), [Data School](https://www.thedataschool.co.uk/anh-vu/are-you-making-these-13-dashboard-design-mistakes/)).

**NN/g** ([preattentive](https://www.nngroup.com/articles/dashboards-preattentive/)): **operational** dashboards support immediate action; **analytical** ones support investigation. Encode quantity with length/position (bars/lines), avoid gauges/pies/3D, never color alone.

**EOS Scorecard** ([EOS](https://www.eosworldwide.com/scorecard), [blog](https://www.eosworldwide.com/blog/the-eos-scorecard-how-to-measure-what-actually-drives-your-business)): **5-15** weekly measurables, one owner + weekly goal each, **13 weeks** visible, reviewed weekly; off-track goes to the Issues List. Favor leading activity measures; revenue/profit confirm rather than drive. Always-hit goals are too soft. Red/green, no yellow ([Ninety](https://www.ninety.io/eos/blog/effective-eos-scorecard), secondary).

**Scaling Up OPSP**: one annual/quarterly **Critical Number** + **3-5 quarterly priorities** ([summary](https://app.glueup.com/resources/protected/organization/861/event/9211/f209dcf0-bc41-4669-9703-bf50dc113f6f.pdf), [Align](https://aligntoday.com/wp-content/uploads/2019/09/Using-Align-to-Measure-Progress.pdf)).

## 5. AI chief-of-staff products (2025-2026)

- **ServiceTitan Atlas** (Sept 2025 co-pilot flagging booking-rate dips; 2026 repositioned as a "chief-of-staff-level agent that takes action") ([SiliconANGLE](https://siliconangle.com/2025/09/18/servicetitan-launches-atlas-ai-sidekick-automate-contractor-operations/), [press](https://www.servicetitan.com/press/servicetitan-announcing-new-and-expanded-capabilities-at-pantheon-2026)). Vendor claims only.
- **Jobber Copilot**: inline insights with thumbs up/down ([PR](https://prnewswire.com/news-releases/jobber-launches-copilot-the-first-of-several-ai-powered-products-aimed-at-making-home-service-business-ownership-simpler-than-ever-before-302264047.html)).
- Gets right: capped cards, dismiss-with-reason, approval before anything goes live, labeling what AI did, undo.
- Gets wrong: reshuffling; summary-only briefings with no record of what the owner did, so they never learn ([Product Hunt category](https://www.producthunt.com/categories/ai-chief-of-staff), mostly unreviewed vendor products).

## Synthesized design rules

1. Today is home; metrics are secondary.
2. Distinct terminal states with timestamps: Done, Snoozed (time or new evidence), Dismissed (this item, with reason, kept), Muted (this class, a rule).
3. Dismiss asks why (one tap); reasons feed detectors.
4. New *material* evidence resurrects items; store an evidence fingerprint at dismissal.
5. Never reorder what the owner ordered; new AI items land in a "New since you looked" band.
6. Label AI-generated items; offer undo / re-plan for the day's generation.
7. Promote = set a "when"; items flow into Today on their date.
8. Make rollovers visible; force a decision after N days (don't silently archive money items).
9. Money/legal items can't be dismissed, only resolved or snoozed.
10. Cap AI output; quiet days are success.
11. Separate "AI did this, confirm" from "you need to act."
12. Weekly = EOS scorecard (8-12 leading measures, 13 weeks, red cell becomes an item).
13. Monthly = Critical Number + 3-5 priorities + long trends (analytical).
14. Every number drills to records; every number has an ⓘ with definition, source, date field.
15. Show a "Missed" demand metric and same-period-last-year comparisons.
16. One screen per view, bars/lines only, color always paired with text/icon, render only non-empty sections.

## Could not verify

Workiz help (403, snippet only); Square not researched; Ramp Homepage details beyond the support summary; how Things 3 marks newly-due items; Superhuman Auto Archive logic; Sunsama default rollover-archive threshold (third parties say 4 days); Linear shortcut numbering differs between old changelog and current docs; EOS no-yellow and strict 13-week grid partly from secondary sources; Few's full 13-mistake list is from secondary summaries; all AI chief-of-staff claims are vendor-reported.
