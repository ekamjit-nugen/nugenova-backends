#!/usr/bin/env bash
#
# Prove the container that is now serving is the one we just built.
#
# Migrations run before the swap, so an old container left serving would answer
# every request with "relation ... does not exist" while looking alive. Health
# must report the commit we built AND status ok before a deploy is a deploy.
#
# This lives in a file rather than inline in deploy.yml because the inline
# version silently broke: the SSH action mangles the script in transit, the
# remote bash failed to parse it, and the workflow reported a red deploy on a
# deploy that had in fact succeeded — the worst failure mode, because it teaches
# you to ignore the light. Flat one-liners survive that trip; a `case` block did
# not. Keeping it here means it is also lintable and runnable by hand.
#
# Usage: verify-deploy.sh <expected-git-sha> [attempts]
#   Reads PORT from ./.env when present, else 4100.
set -euo pipefail

SHA="${1:-}"
ATTEMPTS="${2:-30}"
if [ -z "$SHA" ]; then
  echo "verify-deploy: expected git sha is required" >&2
  exit 2
fi

PORT=""
if [ -f .env ]; then
  PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2 | tr -d '\r"' || true)"
fi
HEALTH="${HEALTH_URL:-http://127.0.0.1:${PORT:-4100}/api/v1/health}"

echo "   probing $HEALTH for $SHA"
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  body="$(curl -fsS --max-time 5 "$HEALTH" || true)"
  if [ -z "$body" ]; then
    echo "   attempt $attempt: no answer yet"
  elif ! printf '%s' "$body" | grep -q "\"version\":\"$SHA\""; then
    echo "   attempt $attempt: still the old build — $body"
  elif printf '%s' "$body" | grep -q '"status":"ok"'; then
    echo "   healthy on $SHA"
    exit 0
  else
    echo "   attempt $attempt: right build, not healthy yet — $body"
  fi
  attempt=$((attempt + 1))
  sleep 4
done

echo "::error::Deploy did NOT take: $HEALTH never reported status=ok for $SHA."
echo "The database is already migrated, so the container that is serving is out of date — fix it now."
exit 1
