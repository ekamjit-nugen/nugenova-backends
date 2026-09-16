#!/bin/sh
# Container startup: apply pending migrations, then run the app.
#
# Every way the container starts — a deploy, `docker compose up -d`, a restart,
# a manual `up -d --build` — lands here, so the schema can never be older than the
# code (the failure mode that took recruitment down: new code, tables missing).
#
# Behaviour:
#   • RUN_MIGRATIONS=false           → skip entirely (e.g. a one-off shell)
#   • MIGRATION_RETRIES (default 5)  → retries with backoff, for a DB still waking up
#   • a failed migration EXITS non-zero → the container does not serve a broken schema
#
# `migration:run` is idempotent: with nothing pending it just logs and exits 0.
set -e

if [ "${RUN_MIGRATIONS:-true}" = "false" ]; then
  echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrations"
else
  retries="${MIGRATION_RETRIES:-5}"
  attempt=1
  until npm run --silent migration:run; do
    if [ "$attempt" -ge "$retries" ]; then
      echo "[entrypoint] migrations failed after $attempt attempt(s) — refusing to start the API" >&2
      exit 1
    fi
    wait=$((attempt * 5))
    echo "[entrypoint] migration attempt $attempt failed — retrying in ${wait}s" >&2
    sleep "$wait"
    attempt=$((attempt + 1))
  done
  echo "[entrypoint] migrations up to date"
fi

exec "$@"
