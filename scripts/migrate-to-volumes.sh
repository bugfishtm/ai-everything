#!/usr/bin/env bash
# Move an installation of the previous layout — folders in ./data plus a separate
# mysql:8.4 container — into the one-container layout (Docker volumes + built-in
# database). Projects, library, packs, Claude logins, users, chats and settings
# are kept. The old ./data folder is left untouched (delete it once all is well).
#
#   ./scripts/migrate-to-volumes.sh
#
# Run it from the project folder with the NEW docker-compose.yml in place.
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash on Windows: give docker Windows paths and stop MSYS from rewriting "-v a:b"
if pwd -W >/dev/null 2>&1; then here() { pwd -W; }; export MSYS_NO_PATHCONV=1; else here() { pwd; }; fi
project="${COMPOSE_PROJECT_NAME:-ai-everything}"
uid_base="${UID_BASE:-20000}"
old="${OLD_DATA_DIR:-$(here)/data}"
work="$old/.migration"

if [ ! -d "$old/mysql" ] || [ ! -d "$old/projects" ]; then
  echo "No old installation found in ./data (expected ./data/mysql and ./data/projects) — nothing to migrate."
  exit 0
fi
if docker volume inspect "${project}_studio-db" >/dev/null 2>&1; then
  echo "The volume ${project}_studio-db already exists — the migration ran before (or the new layout is in use)."
  echo "Delete it first if you really want to migrate again:  docker compose down -v"
  exit 1
fi
mkdir -p "$work"

echo "1/6  Stopping the old containers …"
# (the project was called claude-everything before it became ai-everything)
old_containers="${project}-studio-1 ${project}-db-1 claude-everything-studio-1 claude-everything-db-1"
# shellcheck disable=SC2086
docker stop $old_containers >/dev/null 2>&1 || true

echo "2/6  Reading the old MySQL database …"
docker rm -f ce-migrate-mysql >/dev/null 2>&1 || true
docker run -d --name ce-migrate-mysql -v "$old/mysql:/var/lib/mysql" mysql:8.4 \
  --lower-case-table-names=1 --skip-grant-tables --skip-networking >/dev/null
for _ in $(seq 1 90); do
  docker exec ce-migrate-mysql mysqladmin ping --silent >/dev/null 2>&1 && break
  sleep 1
done
docker exec ce-migrate-mysql mysqldump --no-create-info --complete-insert --skip-triggers --no-tablespaces \
  --skip-add-locks --set-gtid-purged=OFF --default-character-set=utf8mb4 \
  --ignore-table=studio.schema_migrations studio >"$work/studio-data.sql"
docker rm -f ce-migrate-mysql >/dev/null
echo "      $(grep -c '^INSERT' "$work/studio-data.sql") table(s) with data dumped"

echo "3/6  Building the new image and creating the container + volumes (first build: a few minutes) …"
docker compose build studio
docker compose up --no-start studio
image="$(docker compose images -q studio | head -1)"
[ -n "$image" ] || image="${STUDIO_IMAGE:-ai-everything:latest}"

echo "4/6  Copying projects, library, packs, homes and SDKs into the data volume …"
docker run --rm --entrypoint bash -v "${project}_studio-data:/new" -v "$old:/old:ro" \
  -e UID_BASE="$uid_base" "$image" -c '
    set -e
    for d in projects library packs home sdk; do
      [ -d "/old/$d" ] && cp -a "/old/$d" /new/
    done
    # per-user folders belong to the per-user Linux accounts (uid = UID_BASE + user id)
    for root in /new/projects /new/home; do
      for dir in "$root"/[0-9]*; do
        [ -d "$dir" ] || continue
        id=$(basename "$dir"); u=$((UID_BASE + id))
        chown -R "$u:$u" "$dir"
      done
    done
    rm -rf /new/home/.studio/db-password
    echo "      $(du -sh /new | cut -f1) copied"'

echo "5/6  Importing the database …"
docker compose run --rm --no-deps -T studio studio-db import <"$work/studio-data.sql"

echo "6/6  Starting the Studio …"
docker compose up -d --remove-orphans studio
echo
echo "Done. Open the Studio and check your projects. The old files stay in ./data —"
echo "remove them when everything works, together with the stopped old containers:"
# shellcheck disable=SC2086
echo "  docker rm $old_containers 2>/dev/null"
