#!/bin/bash
# Regenerate the triage dashboard: collect → analyze → render.
# Run from anywhere; cds to repo root. Nightly via launchd (com.aac.triage);
# safe to run manually any time. See docs/projects/triage-dashboard.md.
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "── triage refresh $(date '+%Y-%m-%d %H:%M:%S') ──"

# TRIAGE_OPEN=1 (set by the launchd plist) pops the dashboard in the default
# browser after refresh — the 8:15 run doubles as the morning briefing.
open_dashboard() {
  if [ "${TRIAGE_OPEN:-0}" = "1" ]; then
    open "$PWD/analysis/triage.html"
  fi
}

# Skip the refresh if findings are already fresh (e.g. a manual run earlier
# this morning). Scheduled runs still open the dashboard either way. Manual
# runs (no TRIAGE_SCHEDULED) always refresh.
FINDINGS=analysis/data/triage/findings.json
if [ "${TRIAGE_SCHEDULED:-0}" = "1" ] && [ -f "$FINDINGS" ]; then
  age_min=$(( ( $(date +%s) - $(stat -f %m "$FINDINGS") ) / 60 ))
  if [ "$age_min" -lt 240 ]; then
    echo "findings.json is ${age_min}min old — fresh enough, skipping scheduled refresh"
    open_dashboard
    exit 0
  fi
fi

# Overnight runs hit transient network failures (DNS not up yet on wake,
# ECONNRESET mid-fetch) — retry the network-touching steps before giving up.
retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    if [ "$attempt" = 3 ]; then return 1; fi
    echo "!! $* failed (attempt $attempt/3) — retrying in 90s…"
    sleep 90
  done
}

retry npx tsx tools/src/triage/collect.ts
retry npx tsx tools/src/triage/analyze.ts
# refresh bot-draft edit labels so the dashboard section shows ownership
# states (best-effort — the section renders fine without it)
npx tsx tools/src/quote-trigger/harvest-edits.ts || true
npx tsx tools/src/triage/render.ts
echo "Open: analysis/triage.html"
open_dashboard
