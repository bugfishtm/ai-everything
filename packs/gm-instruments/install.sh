#!/bin/sh
# Links the SoundFont that is already in the image and writes pack.json from it.
set -eu
ln -sf "${SOUNDFONT:-/usr/share/sounds/sf2/FluidR3_GM.sf2}" FluidR3_GM.sf2
python3 generate.py
