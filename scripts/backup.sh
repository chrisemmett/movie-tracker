#!/usr/bin/env sh
# Snapshot the STACKS collection (database + uploaded cover images) to a
# timestamped folder under ./backups. Run from anywhere; paths are resolved
# relative to the repo. Requires the stack to be running (docker compose up).
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# Load credentials from .env if present (falls back to compose defaults).
if [ -f .env ]; then
  # shellcheck disable=SC1091
  . ./.env
fi
DB_NAME="${DB_NAME:-movietracker}"
DB_USER="${DB_USER:-movietracker}"
DB_PASSWORD="${DB_PASSWORD:-movietracker}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/$STAMP"
mkdir -p "$OUT"

echo "→ Dumping database to $OUT/db.sql"
docker compose exec -T db \
  mysqldump --single-transaction --no-tablespaces \
  -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" > "$OUT/db.sql"

echo "→ Archiving uploaded cover images to $OUT/uploads.tar.gz"
if docker compose exec -T app sh -c 'cd /data/uploads 2>/dev/null && tar czf - .' \
     > "$OUT/uploads.tar.gz" 2>/dev/null && [ -s "$OUT/uploads.tar.gz" ]; then
  :
else
  echo "  (no uploads found, or the app container isn't running — skipping images)"
  rm -f "$OUT/uploads.tar.gz"
fi

echo "✓ Backup complete: $OUT"
echo "  Restore later with: scripts/restore.sh $OUT"
