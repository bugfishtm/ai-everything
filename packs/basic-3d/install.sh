#!/bin/sh
# Builds the pack's models from their text sources with studio-3d (dogfooding).
set -eu
HERE="$(pwd)"
export STUDIO_PACKS_PATH="$(dirname "$HERE")"
mkdir -p models
for s in src/*.scene.yaml; do
  n=$(basename "$s" .scene.yaml)
  STUDIO_PROJECT_DIR="$HERE" studio-3d build "$s" --out "models/$n.glb" > /dev/null
done
echo "basic-3d: built $(ls models | wc -l) models"
