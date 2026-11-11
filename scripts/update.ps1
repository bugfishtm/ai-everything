# Update ai-everything: rebuild the image with your changes, then restart.
# Claude Code is not part of the image — the Studio updates it by itself at start
# (CLAUDE_CODE_VERSION=latest) or keeps the version you pinned.
# Usage (PowerShell, in the project folder):
#   .\scripts\update.ps1          # fast: only changed layers are rebuilt
#   .\scripts\update.ps1 -Full    # also pull newer base images (OS security updates) and rebuild everything
param([switch]$Full)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($Full) {
  docker compose build --pull --no-cache studio
} else {
  docker compose build studio
}
if ($LASTEXITCODE -ne 0) { throw 'docker compose build failed' }

docker compose up -d
docker compose ps
Write-Host 'Updated. Claude Code updates itself when the Studio starts (see Admin -> Claude Code).' -ForegroundColor Green
