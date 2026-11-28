#!/usr/bin/env bash
# Restore to a NEW, explicitly named recovery database. Never overwrite production.
set -euo pipefail
umask 077
if [[ $# -ne 3 ]]; then
  echo "Usage: restore-encrypted.sh <archive.pgdump.age> <cloudforge_restore_name> <age-private-identity-file>" >&2
  exit 2
fi
archive="$1"
target="$2"
identity="$3"
if [[ ! "$target" =~ ^cloudforge_restore_[a-z0-9_]{2,40}$ ]]; then
  echo "The restore destination must be a new cloudforge_restore_* database." >&2
  exit 2
fi
test -r "$archive" || { echo "Encrypted backup is not readable." >&2; exit 2; }
test -r "$identity" || { echo "Offline recovery identity is not readable." >&2; exit 2; }
command -v age >/dev/null || { echo "age CLI is required." >&2; exit 2; }
command -v docker >/dev/null || { echo "Docker Compose is required." >&2; exit 2; }

# createdb refuses an existing database: no accidental production data loss.
docker compose exec -T postgres sh -ec '
  export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"
  exec createdb -U cloudforge_admin "$1"
' sh "$target"

# Decrypt only in memory and stream to PostgreSQL; pipefail rejects age/restore errors.
age -d -i "$identity" "$archive" | docker compose exec -T postgres sh -ec '
  export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"
  exec pg_restore -U cloudforge_admin -d "$1" --no-owner --no-acl --single-transaction --exit-on-error
' sh "$target"

migrations="$(docker compose exec -T postgres sh -ec '
  export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"
  exec psql -U cloudforge_admin -d "$1" -Atc "SELECT count(*) FROM schema_migrations"
' sh "$target")"
test "${migrations}" -gt 0 || { echo "Recovered schema migrations missing." >&2; exit 1; }
echo "CloudForge restore completed in isolated database: $target"
echo "Verify engineer program hashes, organization records, stock, audit and login before declaring recovery."
