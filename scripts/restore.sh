#!/usr/bin/env sh
# Restore a STACKS backup created by scripts/backup.sh.
# Usage: scripts/restore.sh backups/<timestamp>
# The stack must be running (docker compose up). This OVERWRITES current data.
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

DIR="${1:-}"
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "Usage: scripts/restore.sh backups/<timestamp>" >&2
  echo "Available backups:" >&2
  ls -1 backups 2>/dev/null | sed 's/^/  /' >&2 || echo "  (none)" >&2
  exit 1
fi
if [ ! -f "$DIR/db.sql" ]; then
  echo "No db.sql found in $DIR" >&2
  exit 1
fi

if [ -f .env ]; then
  # shellcheck disable=SC1091
  . ./.env
fi
DB_NAME="${DB_NAME:-movietracker}"
DB_USER="${DB_USER:-movietracker}"
DB_PASSWORD="${DB_PASSWORD:-movietracker}"

printf 'This will OVERWRITE the current database and images with %s. Continue? [y/N] ' "$DIR"
read -r ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

echo "→ Restoring database from $DIR/db.sql"
docker compose exec -T db \
  mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < "$DIR/db.sql"

if [ -f "$DIR/uploads.tar.gz" ]; then
  echo "→ Restoring uploaded cover images"
  docker compose exec -T app sh -c 'mkdir -p /data/uploads && cd /data/uploads && tar xzf -' \
    < "$DIR/uploads.tar.gz"
fi

echo "✓ Restore complete."
