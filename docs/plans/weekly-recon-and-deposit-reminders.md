# Weekly Books Reconciliation + Technician Deposit Reminders

**Status:** Plan, not started. Written 2026-11-01, revised same day with Matt's decisions.
**Origin:** The October 2026 books reconciliation (see `analysis/qbo-2026-recon/` and the
"2026 Books Reconciliation Runbook" artifact). Two failures drove it:

1. The QBO bank feed broke at the Beacon conversion in January 2026 and nobody noticed for
   ten months. The gap had reached about \$225k of phantom cash by the time we found it, with
   a 690-item uncategorized backlog.
2. Eleven customer payments (\$18,650, Jun 19 to Oct) were logged in the field app as cash or
   check and never reached any AAC bank account. Mike texted "Checks should be all set" on
   9/27, and nothing landed.

Both are the same problem: **a claim about money (QBO register, invoice marked "paid") that
nobody checks against the bank.** A weekly loop catches either one within 7 days.

```
Mon am    Recon: categorize the week's bank activity, tie QBO to Relay, find cash/checks
          that are "paid" but not banked -> exceptions for Matt + outstanding list for Friday
Fri 8am   Deposit reminder to tech: this week's cash/checks + anything recon flagged
Fri EOB   Tech deposits at Relay; marks them in field app /bank (creates QB Deposit)
next Mon  Recon confirms each one matched a real Relay deposit
```

## Decisions (Matt, 2026-11-01)

| # | Decision |
|---|---|
| 1 | **Relay is the bank.** All deposits go to Relay. Beacon is legacy (balance \$93.71) |
| 2 | **Deadline: end of business Friday** for everything collected that week |
| 3 | No deposit-receipt photo. The real issue is "paid ≠ banked" (Part 3) |
| 4 | Monday reminder = triage card + one fallback text if the recon hasn't run by noon |
| 5 | Check Relay API. **Result: no public Relay API.** Plaid supports Relay (institution `ins_117228`); see Phase 2 |
| 6 | Check deposits go to **Relay Income (0867)** and get swept like card payouts |
| 7 | **No stale flags to techs:** anything flagged Monday is re-checked in QBO at send time before it goes in a Friday text. **No Plaid dependency.** |

---

## Part 1: Weekly reconciliation (Monday morning)

The recon has two jobs: **keep the books current** (categorize) and **check them against the
bank** (tie out). Categorizing comes first. Most weekly volume is recurring vendors, and a
clean For Review queue makes the tie-out checks meaningful.

### Job A: Categorize

Lessons from 10/29-10/30: about 90% of the 1,000+ items were recurring payees with an obvious
account. Three layers:

1. **QBO bank rules (one-time setup, then automatic).** QBO's native Banking rules can
   auto-categorize, and optionally auto-post, by payee text. Create rules for the October
   mapping: Home Depot/Lowe's/Sherwin/Amazon/EMI/Grainger -> Materials; Google -> Advertisement;
   fuel stations -> Auto Expense; Datapay OBC -> Wages, Tax impound -> Payroll taxes,
   Billing -> Processing Fees; Anthropic/Vercel/DigitalOcean/Semrush/Canva -> Computer &
   Software; Titan -> Insurance; Openphone -> Telephone; Relay sweeps -> Transfers between the
   right sub-accounts. This alone should clear most items with no session at all.
   - Caveats from October: QBO **mis-suggests** some items (Datapay OBC -> Payroll taxes; check
     deposits -> Income). Rules for these must be explicit, never "accept suggestion". The
     Profit-First sweeps are identical in amount between Opex and Payroll, so transfer rules
     must key on the sub-account, not the amount.
2. **Monday session posts the rest of the obvious items.** Claude reads each Relay sub-account's
   For Review queue, maps items using a versioned payee->account table
   (`tools/src/recon/category-map.ts`, seeded from the October batches), then **shows Matt the
   batch (count + sum per account) and posts on approval**. Same verified-count-and-sum method
   as October.
3. **Judgment items go to Matt as a short list**, with a best guess each. Examples: Venmo, ATM
   cash, restaurants/Topgolf (possible draws), unknown payees, check deposits. Each answer
   becomes a new rule or map entry, so the list shrinks over time.

**Hard rules for posting:**
- Check/cash deposits are **always Matched** to the Undeposited Funds Payment (or the field
  app's QB Deposit). Never posted as income, since that double-counts revenue.
- Intuit payouts are always Matched to the system QB Payments deposit.
- Nothing posts without Matt's approval in the session. Read-only by default.

### Job B: Tie out

| # | Check | Catches |
|---|---|---|
| R1 | Each Relay sub-account's feed has a transaction under 3 business days old | Dead feed (the January failure) |
| R2 | QBO posted balance = Relay bank balance, per sub-account (after Job A) | Phantom cash, double-landed payouts |
| R3 | For Review count + oldest item per account, after Job A | Backlog building up again |
| R4 | Every cash/check Payment older than 5 business days has left Undeposited Funds | Paid but never deposited (the \$18,650) |
| R5 | Every QB Deposit, including field-app ones, matches a real Relay deposit (same amount, within 5 business days) | Marked deposited in field app, money never landed |
| R6 | Each QB Payments payout has exactly one matching Relay Income (0867) transaction | Payout re-point regressions, duplicates |
| R7 | Beacon 1082: any new activity at all | Something still hitting the old bank (it should be dormant) |

R4 and R6 (API side) run from the QBO API today. The rest need bank-side data.

### Getting bank data

- **QBO API does not expose bank-feed (For Review) transactions or feed balances.** Those exist
  only in the QBO Banking UI.
- Relay is connected to QBO's native feed (reconnected 10/29). So **one QBO login gives
  everything** R1-R3, R5 and R7 need, through Chrome MCP. No separate Relay login is required,
  except to spot-check R2 against Relay's own balance if they ever disagree.

**Phase 1 (recommended, build now): Monday desk session.**
1. Triage dashboard (launchd `com.aac.triage`, 08:15) shows a **Monday-only "Weekly recon"
   card**: "Log into QBO, then run the weekly recon." It shows last week's result.
2. A Claude Code session runs `tools/src/recon/api-checks.ts` (API side), then drives Chrome
   through the QBO Banking page per account: Job A, then Job B.
3. Output: `analysis/recon/YYYY-MM-DD.md`, plus exceptions and the **outstanding deposits list
   written to Redis** (key builder in `@aac/shared-utils/redis`) for Friday's reminder.
   A clean week is one line: "Books tie. 0 exceptions."
4. **Fallback:** if no recon report exists by noon Monday, one text to Matt. Nothing else.

**Phase 2 (optional, nothing depends on it): Plaid for programmatic Relay data.**
R5 can mostly run from the QBO API already: a field-app Deposit that's still uncleared (`Clr`
blank) 5 business days later is unmatched. Plaid would only remove the Monday login for the
categorizing and balance checks.
- No public Relay developer API exists. Third-party sources list Plaid as Relay's aggregator
  (institution `ins_117228`), and tools like Fintable use it for transactions and balances.
- To verify: Plaid production access and cost for a single business, whether all 8 Relay
  sub-accounts come through as separate accounts, and Transactions + Balance coverage.
- If it pans out: `PlaidClient` in `@aac/api-clients` (Cardinal Rule 2), and Job B moves to a
  worker cron (Monday 07:00 ET) with no human login. R5 and R2 become fully automatic. Job A
  still needs the QBO Banking UI for posting, but QBO rules plus a short Monday list should make
  that small.
- Not recommended: storing bank or QBO credentials for headless login.

### Build steps (Phase 1)

1. Set up the QBO bank rules from the October mapping (Chrome MCP session with Matt). **Biggest
   win for the effort.**
2. `tools/src/recon/category-map.ts`: payee -> account table, seeded from the October batches.
3. `tools/src/recon/api-checks.ts`: R4, R6, and the API side of R5. Promote from
   `tools/src/scratch/undeposited-match.ts`, `intuit-check-batches.ts`, `bank-recon-check.ts`,
   `decompose-registers.ts`. Share the undeposited-funds logic with `apps/field/lib/bank.ts`
   (one implementation, DRY; see Part 3).
4. `tools/src/recon/RUNBOOK.md`: the Chrome MCP procedure, plus the UI quirks from October (wait
   ~9s before search, find-click-refind for checkboxes, select-all is the current page only,
   pending counters are stale, trust the Posted balance).
5. Report writer + Redis outstanding list + triage "Weekly recon" section + noon fallback text.

**Precondition:** the 2026 backlog needs to be resolved first (Phillip James, plus the remaining
Beacon 66 / Relay Opex judgment items). R1, R4 and R5 are useful immediately regardless.

---

## Part 2: Technician deposit reminders (Friday morning)

### The message

Friday 8:00 ET, one text per technician with anything to deposit:

> Reminder: per the field app, this week you collected checks from Jane Smith (\$1,225, 10/28)
> and Bob Jones (\$4,850, 10/30), and cash from Sam Lee (\$675, 10/31). All of these, plus
> anything collected today, need to be deposited at Relay by end of business today. Mark them
> in the field app under "At the bank" when you do.
>
> Still outstanding from earlier: Ann Cohen check (\$2,100, 9/14). Marked deposited 10/24 but
> no deposit showed up at the bank: Ed Spooner check (\$5,975).

(The second paragraph appears only for items re-checked in QBO the same morning; see
"Re-verify before sending" below.)

If a tech has nothing this week and nothing outstanding: **no message.**

### What goes on the list

**This week's items plus everything outstanding:**

1. **This week:** cash/check Payments the tech recorded in the field app (Mon-Fri) that are
   still in Undeposited Funds.
2. **Outstanding (older):** any cash/check Payment attributed to this tech that is still in
   Undeposited Funds from an earlier week (R4).
3. **Recon-flagged:** items the tech marked deposited in the field app where Monday's recon
   found no matching Relay deposit (R5 failures, read from the Redis list Part 1 writes). These
   don't appear in Undeposited Funds anymore, because the field app's QB Deposit removed them,
   so only the recon can surface them.

**Re-verify before sending (Matt, 2026-11-01).** Nothing goes to a tech as an issue unless it
was re-checked at send time and is still true. A Monday flag is four days old by Friday; the tech
may have deposited Tuesday, or Matt may have found a recording error. The rule covers items 2
and 3. Item 1 is a neutral reminder, not a claim that something is wrong.

**The Friday re-check is a QBO API call at send time. No bank login and no Plaid.**

- **Item 2 (older undeposited):** re-query Undeposited Funds. If the Payment is still there, it is
  verified that no deposit has been recorded. Phrase it as exactly that: "not recorded as
  deposited yet; if you already deposited it, mark it in the field app." If he deposited but
  didn't mark it, that's a real gap and the text is still accurate.
- **Item 3 (recon-flagged):** re-query the QB Deposit's **cleared flag**. QBO's TransactionList
  report has a `Clr` column (`is_cleared`). When a Relay feed transaction is matched to a
  Deposit, the Deposit shows `C`. Still blank on Friday = still no matched Relay deposit, which
  goes in the text. Shows `C` = it landed, so clear the flag silently. Also clear it if the Deposit
  was deleted or edited, or if Matt resolved it on triage (Redis).

**Verified 2026-11-01** (`tools/src/scratch/deposit-clr-probe.ts`): all 90 system Intuit deposits
matched to the feed on 10/29-10/30 read `Clr = C`; Payments in Undeposited Funds read blank.
**Still needed: a negative control.** No unmatched Deposit exists right now, so confirm that a
fresh field-app Deposit reads blank before its feed match and flips to `C` after. Do this on the
first real deposit after build, before the first live text.

**One dependency: matches have to be confirmed.** QBO suggests a match when the Relay
transaction arrives in For Review, but `Clr` doesn't flip until someone clicks Match. If Mike
deposits Tuesday and nobody confirms it, Friday would wrongly report it. Fix: a **Thursday
triage card, shown only when flagged items exist**: "N flagged deposits still uncleared in QBO.
Open Banking and confirm any suggested matches before Friday 8am." It's a 1-minute task and
only appears on weeks with a problem. If Matt doesn't get to it, Friday holds item 3 for Matt
and doesn't send it to the tech. (Item 2 doesn't depend on matching.)

Item 1 comes live from QBO at send time. If the recon didn't run that week, the text still sends.

**Attribution:** join QB Payment ID to field-app completion records
(`keys.fieldCompletion(eventId)`: `paymentStatus` cash/check, `paymentId`, completed-by email).
Payments with no field-app record (mailed checks, Matt-entered) go to **Matt's** triage list,
never a tech's. Mailed checks are not the tech's responsibility (e.g. Markis \$7,800).

### Delivery

- **Line:** internal agent line (+16177660151), not the business line (only Matt texts from
  +16176681677). Technician cells must be on the planned internal-number skip list in the Quo
  webhook (PLAN.md deferred item), or replies get processed as customer conversations.
- **Runtime:** `apps/worker/api/deposit-reminder.ts`, cron Friday 12:00 + 13:00 UTC, with the
  handler sending only in the run where it's 8am ET (handles DST). `QuoClient.sendMessage` from
  `@aac/api-clients`.
- **Recipients:** technician roster (`TECHNICIAN_EMAILS` + phone numbers in the same config).
  Tech #2 needs no code change.
- **Matt sees** the same per-tech summary on the triage dashboard Friday (not a text).
- **Flag** `DEPOSIT_REMINDERS_ENABLED`; first week is a dry run that texts Matt only.

### Field app: Relay only

The `/bank` deposit picker currently lists QBO bank accounts with no default. Restrict or
default it to **Relay Income (0867)**, the account QB Payments already deposits into, so
field-app Deposits land in the account Relay's feed matches against. Check deposits go to
Income (0867), and the Profit First sweeps distribute them like card payouts (confirmed by Matt
2026-11-01).

### Expectations (for Matt to finalize and give Mike in writing)

1. All cash and checks collected in a week are deposited **at Relay by end of business
   Friday**. Anything collected Friday is deposited Friday. Nothing held over a weekend.
2. Mark the deposit in the field app "At the bank" the same day.
3. Never cash, endorse over, or hold a customer check or cash past the deadline. Lost or damaged
   check: tell Matt the same day.
4. Mailed checks are Matt's responsibility.
5. If the Friday text lists something you already deposited, reply to Matt. A mismatch usually
   means a recording error, and it gets fixed that week instead of months later.

**Rollout:** Matt talks to Mike first and gives him the written version. The reminders reinforce
a standard Mike already knows about; they shouldn't be how he finds out. Clear the current
backlog (the 11 items, \$18,650, plus the Ed Spooner \$5,975 check) before the first send.

---

## Part 3: "Paid" ≠ banked

When a tech picks cash/check at Mark Complete, the field app creates a QB Payment linked to the
invoice (`apps/field/lib/payment-branches.ts`). The invoice balance drops to \$0 and **QBO shows
it as Paid** while the money sits in Undeposited Funds, which could be indefinitely.

**The QBO accounting is correct and should stay.** The customer did pay. Leaving the invoice open
would trigger reminders and dunning to customers who already paid, and would misstate A/R.
Undeposited Funds is exactly the "received, not banked" bucket.

**The problem is downstream code and habits that treat invoice Paid as cash in the bank:**

| Consumer | Today | Fix |
|---|---|---|
| **Ed's commission report** (`tools/src/commissions/analyze.ts:119`) | `Balance === 0` -> commission earned. **Confirmed: Ed earns 20% on a check that was never deposited.** | Commission is earned only when every Payment on the invoice is banked (card payout, or cash/check pulled into a QB Deposit that R5 matched). Otherwise list it as "paid, awaiting deposit". |
| Field app completion screen | "Paid" outcome | Show "Recorded, deposit by Friday" for cash/check, so the tech isn't told the job is closed out |
| Triage / any revenue or A/R view | Paid = done | Add an aging line for "paid, not banked" from Undeposited Funds (R4), visible every day, not just Mondays |
| Binder / P&L | Cash-basis revenue includes Undeposited Funds payments | Fine for the books, but the recon report should show the Undeposited Funds balance next to revenue |

**Build:** one shared helper, `getUndepositedPayments` (moved out of `apps/field/lib/bank.ts` into
`@aac/api-clients` or a small package), plus a `isBanked(payment)` that combines it with R5
match results. Used by the field app, the recon, the Friday reminder and the commission report.

---

## Build order

1. Matt: talk to Mike + finalize the expectations doc; clear the current undeposited backlog.
2. QBO bank rules (Part 1 Job A, layer 1).
3. Shared undeposited helper + commission fix (Part 3). Small, and it stops paying commission on
   unbanked checks now.
4. Field app `/bank` default to Relay Income (0867).
5. Recon Phase 1 (api-checks, category map, runbook, triage card, Redis outstanding list,
   fallback text).
6. Friday reminder with all three items, re-checked in QBO at send time. Plus the Thursday
   "confirm matches" triage card. Negative-control the `Clr` flag on the first real deposit, then
   a dry-run week to Matt, then live.
7. Optional: evaluate Plaid for Relay (Phase 2). Only removes the Monday QBO login. Nothing
   depends on it.

## Open questions

None currently. Resolved 2026-11-01: check deposits go to Relay Income (0867); Matt will tell Ed
about the commission timing change himself.
