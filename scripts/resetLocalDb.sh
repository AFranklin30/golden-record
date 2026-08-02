#!/usr/bin/env bash
# scripts/resetLocalDb.sh
# Golden Record Fan Identity Platform — OKC Thunder — Thunder Innovations Cohort
#
# Drops and recreates the local Postgres database, then replays every
# migration in order. LOCAL ONLY — refuses to run against anything else.
#
# Why a full rebuild instead of surgical cleanup: resolution_trace and
# audit_log are append-only by trigger, and both FK-pin fan / conflict_queue
# / org. There is no clean way to delete a partially-seeded org once either
# table has rows for it. A rebuild is the only clean reset path.
#
# Run: bash scripts/resetLocalDb.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "BLOCKED: DATABASE_URL is not set. Add it to .env and point it at localhost:5432." >&2
  exit 1
fi

case "$DATABASE_URL" in
  *localhost*) ;;
  *)
    echo "BLOCKED: DATABASE_URL does not contain 'localhost'." >&2
    echo "  DATABASE_URL: $DATABASE_URL" >&2
    echo "  This script must never run against Cloud SQL or a remote host." >&2
    exit 1
    ;;
esac

DB_NAME=$(node -e "console.log(new URL(process.argv[1]).pathname.replace(/^\//, ''))" "$DATABASE_URL")
DB_HOST=$(node -e "console.log(new URL(process.argv[1]).hostname)" "$DATABASE_URL")
DB_PORT=$(node -e "const u=new URL(process.argv[1]); console.log(u.port || '5432')" "$DATABASE_URL")
DB_USER=$(node -e "console.log(new URL(process.argv[1]).username)" "$DATABASE_URL")

echo "Resetting local database '$DB_NAME' on $DB_HOST:$DB_PORT ..."

dropdb   --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --if-exists "$DB_NAME"
createdb --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" "$DB_NAME"

echo "Replaying migrations..."
for f in migrations/migration_*.sql; do
  echo "  === $f ==="
  # Intentionally no -v ON_ERROR_STOP=1: several migrations contain
  # self-verification statements that are EXPECTED to error under psql's
  # default mode (e.g. an RLS self-test that fails under the superuser
  # connection by design, an append-only DELETE test proving a trigger
  # blocks the operation). ON_ERROR_STOP aborts the whole file mid-way and
  # leaves the schema incomplete — confirmed the hard way this session.
  psql "$DATABASE_URL" -f "$f"
done

echo ""
echo "Reset complete. Verifying final schema..."
psql "$DATABASE_URL" -c "\dt" -c "SELECT count(*) AS table_count FROM information_schema.tables WHERE table_schema = 'public';"
