#!/usr/bin/env bash
# Host-side, encrypted PostgreSQL backup. Never writes an unencrypted dump to disk.
set -euo pipefail
umask 077

: "${CLOUDFORGE_BACKUP_DIR:?Set an off-host/managed backup directory}"
: "${CLOUDFORGE_BACKUP_RECIPIENT:?Set the age X25519 public backup recipient}"
if [[ ! "$CLOUDFORGE_BACKUP_RECIPIENT" =~ ^age1[023456789acdefghjklmnpqrstuvwxyz]{50,}$ ]]; then
  echo "A valid age X25519 recipient is required." >&2
  exit 2
fi
command -v age >/dev/null || { echo "age CLI must be installed on the backup host." >&2; exit 2; }
command -v docker >/dev/null || { echo "Docker Compose is required." >&2; exit 2; }
mkdir -p -- "$CLOUDFORGE_BACKUP_DIR"
destination="$CLOUDFORGE_BACKUP_DIR/cloudforge-$(date -u +%Y%m%dT%H%M%SZ)-$$.pgdump.age"
temp="${destination}.partial"
trap 'rm -f -- "$temp"' EXIT

# The database password stays inside the PostgreSQL container's Docker secret.
# stdout is encrypted before reaching the destination file.
docker compose exec -T postgres sh -ec '
  export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"
  exec pg_dump -U cloudforge_admin -d cloudforge -Fc --no-owner --no-acl
' | age -r "$CLOUDFORGE_BACKUP_RECIPIENT" > "$temp"

test -s "$temp" || { echo "Encrypted backup is empty." >&2; exit 1; }
chmod 600 "$temp"
mv -- "$temp" "$destination"
trap - EXIT
echo "Encrypted CloudForge backup created: $destination"
echo "Archive uses the offline age recovery identity. Verify retention and test restoration separately."
