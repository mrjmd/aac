# Ed Commission Report

Recurring, payroll-ready commission report for Ed Crowell (outside salesperson,
referral-partner channel). Built 2026-09-30.

## The rule

Ed earns **20% of the invoice total** on a job once its QBO invoice is **paid in
full** (`Balance === 0`), when the customer is Ed-attributed in Pipedrive.
Pipedrive is the canonical attribution source; QBO is the canonical money
source.

A Pipedrive person is **Ed-attributed** if any of:

1. `Referred by` (person field `34e9bd78…`) = Edward Crowell (person **5225**), or
2. `Referred by` = another Ed-attributed person (chain — e.g. a lead referred
   by a realtor Ed manages), or
3. the contact is **owned by** the Edward Crowell PD user (**24313124**).

The closure is computed over all persons every run. Known test records
(persons 5266, 5272) are excluded. Process rule that makes the chain work:
**partners Ed recruits (realtors, inspectors, BNI) must be owned by the Ed PD
user** — then their referrals attribute automatically.

## Pipeline

```
tools/src/commissions/
  collect.ts       PD persons+deals, QBO invoices+payments+estimates → snapshot.json
  analyze.ts       attribution closure + commission calc + ledger diff → findings.json
                   `--commit` = lock the current new events into ledger.json
  render.ts        → analysis/commissions.html + analysis/data/commissions/email.md
  refresh.sh       collect → analyze → render   [--open]
  pull-ed-thread.ts  audit tool: full Matt↔Ed Quo thread → ed-thread.json/.txt
  close-estimate.ts  mark a dead QBO quote Closed so it leaves the potential bucket
```

State lives in `analysis/data/commissions/` (gitignored):

- `ledger.json` — every commission already reported to payroll. "New this
  cycle" = paid invoices for attributed customers not yet in the ledger.
- `email.md` — the payroll-ready block (dollar signs escaped for md renderers).

## Pay-cycle workflow

1. `./tools/src/commissions/refresh.sh --open` — fresh pull + report.
2. Sanity-check the "New commissions" table, email `email.md` on to payroll.
3. `npx tsx tools/src/commissions/analyze.ts --commit` — locks those events
   into the ledger so the next cycle only shows genuinely new ones.

## Validation audit (2026-09-30)

Full Matt↔Ed Quo thread (Dec 2025 → Sep 2026, 1,065 msgs) was mined for
tossed leads and cross-checked against PD + QBO:

- **5 commission events confirmed, \$1,285 lifetime at 20%**: Mike Flavin
  (\$1,575 → \$315, via manual link — PD person 4526 never got the QB field),
  Suzanne Stevens (\$475 → \$95), Melanie Crowley (\$1,775 → \$355), Brian
  Frizzetti (\$1,075 → \$215), Shawn Hanrahan (\$1,525 → \$305).
- Cleanly resolved as no-commission: Kim Robbins (est 1306 Closed), Mike
  Leger/"Ledger" (est 1317 Closed), Margie Mercadante (est 1370 Closed —
  the unnamed 5/29 \$1,175 chat quote).
- Resolved 2026-09-30 follow-ups: Donna Souza + Jeff Brown estimates Closed
  in QBO (Souza was a plumbing issue; Brown went DIY — his decline email is
  in Gmail ~7/17, relayed in the Ed thread); Stephanie Tierney tagged
  Referred-by-Ed in PD by Matt; Champion Builders manually linked to Tom
  Dacey (effectiveFrom 2026-06-10 — Matt confirmed same person).
- **Still open**: Hanover Group / Tiger referral repair — no QBO customer
  matches; Ed Spooner ruled out by Matt; **Matt is asking Ed directly**.
  Kimberly Allen inv 1229 \$2,975 paid 8/15 (= Julie Price, 80 Cherry St —
  Ed involvement unclear, \$595 if his). Champion inv 1162 (\$1,075 paid
  2026-03-04) predates the 6/10 effectiveFrom — include? Flavin's "second
  building" job (never materialized in QBO).

## Known caveats / v2 candidates

- **Commission base is the full invoice total** incl. any add-ons; if a job is
  invoiced without ever linking the PD person to QB (`QB Customer ID` field
  empty), the job is invisible — the attribution audit (`ed-thread` extraction,
  2026-09-30) is the backstop for this.
- Partial payments don't trigger commission until the balance hits zero.
- A chain root who is neither referred-by-Ed nor Ed-owned breaks attribution
  for their referrals (e.g. a BNI member owned by the Matt user). Keep partners
  Ed-owned.
- Email delivery is manual (copy `email.md`); auto-send per pay cycle is a
  follow-up once the numbers are trusted.
- Matt↔Ed chat is **line-to-line** in Quo: Massachusetts line (+16176681677) ↔
  Ed line (+13392175091). Searching by Ed's cell (+15089422440) finds nothing.
