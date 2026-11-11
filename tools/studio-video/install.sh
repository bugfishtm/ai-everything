#!/bin/sh
# Build-time dependencies of studio-video (runs as root during `docker build`).
# Pillow and numpy come with the image (docker/requirements.txt); ffmpeg reads and writes the media.
set -eu
/opt/venv/bin/pip install --no-cache-dir "pyyaml>=6"
