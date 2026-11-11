#!/bin/sh
# Build-time dependencies of studio-3d (runs as root during `docker build`).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
# booleans (manifold3d), 2D outlines (shapely + earcut), YAML, marching cubes for blob (scikit-image)
/opt/venv/bin/pip install --no-cache-dir "pyyaml>=6" manifold3d shapely mapbox_earcut networkx scikit-image
# three.js for the preview renderer (MIT)
mkdir -p "$HERE/vendor"
cd "$HERE/vendor" && npm install --no-audit --no-fund --no-save --prefix "$HERE/vendor" three@0.187.0 >/dev/null
test -f "$HERE/vendor/node_modules/three/build/three.module.js"
