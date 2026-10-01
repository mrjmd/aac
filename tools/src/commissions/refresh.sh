#!/bin/bash
# Ed commission report — full refresh: collect → analyze → render.
# Run from repo root:  ./tools/src/commissions/refresh.sh [--open]
# After the report is sent to payroll, lock in the cycle with:
#   npx tsx tools/src/commissions/analyze.ts --commit
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

npx tsx tools/src/commissions/collect.ts
npx tsx tools/src/commissions/analyze.ts
npx tsx tools/src/commissions/render.ts

if [[ "${1:-}" == "--open" ]]; then
  open analysis/commissions.html
fi
