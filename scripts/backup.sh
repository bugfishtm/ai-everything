#!/usr/bin/env bash
# Back up an Everything Studio installation (docker compose) into ./backups/<date>/:
#   studio-db.sql.gz     consistent dump of the built-in database (the Studio's and the WordPress sites')
#   studio-data.tar.gz   the whole data volume (projects, library, packs, homes, SDKs, secrets)
#
#   ./scripts/backup.sh                 # the Studio keeps running
#   ./scripts/backup.sh --no-sdk        # skip the (re-downloadable) Android SDK
#
# Restore on a fresh installation (volumes empty, Studio stopped):
#   docker compose up --no-start
#   docker run --rm -v ai-everything_studio-data:/data -v "$PWD/backups/<date>":/b alpine \
#     tar xzf /b/studio-data.tar.gz -C /data
#   gunzip -c backups/<date>/studio-db.sql.gz | docker compose run --rm -T studio studio-db import
#   docker compose up -d
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash on Windows: give docker Windows paths and stop MSYS from rewriting "-v a:b"
if pwd -W >/dev/null 2>&1; then here() { pwd -W; }; export MSYS_NO_PATHCONV=1; else here() { pwd; }; fi
project="${COMPOSE_PROJECT_NAME:-ai-everything}"
dest="${BACKUP_DIR:-backups}/$(date +%Y-%m-%d_%H%M%S)"
mkdir -p "$dest"
dest_abs="$(cd "$dest" && here)"

exclude=()
[ "${1:-}" = "--no-sdk" ] && exclude=(--exclude=./sdk)

echo "Database → $dest/studio-db.sql.gz"
docker compose exec -T studio studio-db dump --all | gzip >"$dest/studio-db.sql.gz"

echo "Data volume → $dest/studio-data.tar.gz"
docker run --rm -v "${project}_studio-data:/data:ro" -v "$dest_abs:/backup" alpine \
  tar czf /backup/studio-data.tar.gz "${exclude[@]}" -C /data .

ls -lh "$dest"
echo "Backup done: $dest"
