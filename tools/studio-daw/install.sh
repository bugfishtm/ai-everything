#!/bin/sh
# Build-time dependencies of studio-daw (runs as root during `docker build`).
set -eu
/opt/venv/bin/pip install --no-cache-dir "pyyaml>=6"
