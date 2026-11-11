#!/usr/bin/env sh
# Update ai-everything: rebuild the image with your changes, then restart.
# Claude Code is not part of the image — the Studio updates it by itself at start
# (CLAUDE_CODE_VERSION=latest) or keeps the version you pinned.
#   ./scripts/update.sh          # fast: only changed layers are rebuilt
#   ./scripts/update.sh --full   # also pull newer base images (OS security updates) and rebuild everything
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--full" ]; then
  docker compose build --pull --no-cache studio
else
  docker compose build studio
fi
docker compose up -d
docker compose ps
echo "Updated. Claude Code updates itself when the Studio starts (see Admin → Claude Code)."
