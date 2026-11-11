"""Render one-shot drum samples with studio-daw's own synth voices (run by install.sh)."""
import json
import os
import sys

sys.path.insert(0, os.environ.get("STUDIO_DAW_DIR", "/opt/studio/tools/studio-daw"))
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from studio_daw import registry  # noqa: E402

registry.load_builtins()
SR = 44100
SOUNDS = [
    ("kick-punchy", "kick", {}, "Punchy kick", ["kick", "bd"]),
    ("kick-deep", "kick", {"pitch": 42, "decay": 0.7, "punch": 110}, "Deep, long kick", ["kick", "bd", "sub"]),
    ("kick-808", "kick", {"pitch": 45, "decay": 1.3, "punch": 90, "click": 0.05, "drive": 1.2}, "808-style boom kick", ["kick", "808", "sub"]),
    ("snare-tight", "snare", {"tone": 200, "decay": 0.16}, "Tight snare", ["snare", "sd"]),
    ("snare-fat", "snare", {"tone": 160, "decay": 0.32, "snappy": 1.0}, "Fat, long snare", ["snare", "sd"]),
    ("clap", "clap", {}, "Hand clap", ["clap"]),
    ("rim", "rim", {}, "Rim shot", ["rim", "sidestick"]),
    ("hat-closed", "hat", {}, "Closed hi-hat", ["hat", "hihat", "chh"]),
    ("hat-open", "ohat", {}, "Open hi-hat", ["hat", "hihat", "ohh"]),
    ("tom-high", "tom", {"pitch": 170}, "High tom", ["tom"]),
    ("tom-mid", "tom", {"pitch": 125}, "Mid tom", ["tom"]),
    ("tom-low", "tom", {"pitch": 85, "decay": 0.5}, "Low tom", ["tom"]),
    ("crash", "crash", {}, "Crash cymbal", ["cymbal", "crash"]),
    ("ride", "ride", {}, "Ride cymbal", ["cymbal", "ride"]),
    ("shaker", "shaker", {}, "Shaker", ["shaker", "percussion"]),
    ("cowbell", "cowbell", {}, "Cowbell", ["cowbell", "percussion"]),
]
os.makedirs("samples", exist_ok=True)
items = []
for sid, voice, params, name, tags in SOUNDS:
    e = registry.VOICES[voice]
    x = np.asarray(e.fn(261.63, 0.1, 0.95, SR, {**e.params, **params}), dtype=np.float64)
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.89  # -1 dBFS
    sf.write(f"samples/{sid}.wav", x.astype(np.float32), SR, subtype="PCM_16")
    items.append({"id": sid, "kind": "sample", "name": name, "file": f"samples/{sid}.wav", "tags": tags,
                  "meta": {"pitched": False, "voice": voice, "params": params}})
kit = {"kick": "kick-punchy", "snare": "snare-tight", "clap": "clap", "rim": "rim", "hat": "hat-closed", "ohat": "hat-open",
       "tom1": "tom-high", "tom2": "tom-mid", "tom3": "tom-low", "crash": "crash", "ride": "ride", "shaker": "shaker", "cowbell": "cowbell"}
items.append({"id": "kit", "kind": "kit", "name": "Studio kit", "description": "Rows: " + " ".join(kit), "tags": ["drums", "kit"], "meta": {"map": kit}})
items.append({"id": "kit-808", "kind": "kit", "name": "808 kit", "description": "Rows: " + " ".join(kit), "tags": ["drums", "kit", "808", "trap"],
              "meta": {"map": {**kit, "kick": "kick-808", "snare": "clap"}}})
manifest = {
    "id": "studio-drums",
    "name": "Studio Drums",
    "version": "1.0.0",
    "type": "music",
    "description": "Synthesized one-shot drum samples (kicks, snares, claps, hats, toms, cymbals, percussion) and two ready kits.",
    "author": "Everything Studio",
    "license": "CC0-1.0",
    "tags": ["drums", "one-shots", "808", "electronic"],
    "software": ["studio-daw"],
    "docs": "README.md",
    "items": items,
}
json.dump(manifest, open("pack.json", "w"), indent=1)
print(f"studio-drums: {len(items)} items")
