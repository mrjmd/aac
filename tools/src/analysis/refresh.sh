#!/usr/bin/env bash
# Refresh the AAC business diagnostic: pull fresh QBO data + rebuild dashboard.
#
# Run from project root:
#   ./tools/src/analysis/refresh.sh
#
# Then double-click analysis/dashboard.html or run: open analysis/dashboard.html
set -euo pipefail

cd "$(dirname "$0")/../../.."

echo "==> Pulling QBO baseline"
npx tsx tools/src/analysis/pull-qbo-baseline.ts

echo
echo "==> Building dashboard"
npx tsx tools/src/analysis/build-dashboard.ts

echo
echo "==> Done. Open: analysis/dashboard.html"
