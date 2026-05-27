#!/usr/bin/env bash
# Deploy field with a clean state wipe — used during rapid iteration so the
# same calendar event can be re-tested. NOT a production-safe replacement
# for `deploy`; once Mike starts using this app for real, only use plain
# `deploy` so his real completion history is preserved.
set -euo pipefail

ORG="team_xO1tybQ8vFTha22hn8eaHc9v"
PROJ="prj_URMxWdQ7HXIjBpjWo1vTB4jCqh7z"
REPO_ROOT="$(git rev-parse --show-toplevel)"

cd "$REPO_ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ pulling production env vars…"
VERCEL_ORG_ID="$ORG" VERCEL_PROJECT_ID="$PROJ" \
  vercel env pull "$TMP/.env" --environment=production --yes >/dev/null

echo "→ wiping field:completion:* records…"
set -a; source "$TMP/.env"; set +a
( cd apps/field && pnpm exec tsx scripts/reset-field-state.ts )

echo "→ deploying…"
VERCEL_ORG_ID="$ORG" VERCEL_PROJECT_ID="$PROJ" \
  vercel deploy --prod --yes
