# @aac/metrics — every business number, computed once

The command center plan's metrics layer (`docs/plans/command-center/README.md`
§8): Overview, area pages, the scoreboard files and the Ed/CAC views all
read numbers from here, so each one has a single definition and date basis.

- Pure `build*` functions take source data and return the number plus its
  definition; thin `get*` wrappers fetch through `@aac/api-clients`.
- Every number says where it came from and how fresh it is (e.g. a bank
  register's "posted through" date). QBO balances are not bank balances
  until the register is reconciled; label them that way.
