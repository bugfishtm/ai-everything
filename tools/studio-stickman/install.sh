#!/bin/sh
# Build-time dependencies of studio-stickman (runs as root during `docker build`).
# Pillow, numpy and scipy come with the image (docker/requirements.txt); ffmpeg encodes the video.
set -eu
/opt/venv/bin/pip install --no-cache-dir "pyyaml>=6"
