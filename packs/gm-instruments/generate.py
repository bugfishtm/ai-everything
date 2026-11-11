"""Generate pack.json from the SoundFont installed in the image (run by install.sh)."""
import json
import os
import re
import struct
import sys

SF2 = os.environ.get("SOUNDFONT", "/usr/share/sounds/sf2/FluidR3_GM.sf2")
FILE = "FluidR3_GM.sf2"

GM = """Acoustic Grand Piano|Bright Acoustic Piano|Electric Grand Piano|Honky-tonk Piano|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet|
Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|
Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|
Acoustic Guitar Nylon|Acoustic Guitar Steel|Electric Guitar Jazz|Electric Guitar Clean|Electric Guitar Muted|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|
Acoustic Bass|Electric Bass Finger|Electric Bass Pick|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|
Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani|
String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Choir|Orchestra Hit|
Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|
Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|
Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|
Lead 1 Square|Lead 2 Sawtooth|Lead 3 Calliope|Lead 4 Chiff|Lead 5 Charang|Lead 6 Voice|Lead 7 Fifths|Lead 8 Bass and Lead|
Pad 1 New Age|Pad 2 Warm|Pad 3 Polysynth|Pad 4 Choir|Pad 5 Bowed|Pad 6 Metallic|Pad 7 Halo|Pad 8 Sweep|
FX 1 Rain|FX 2 Soundtrack|FX 3 Crystal|FX 4 Atmosphere|FX 5 Brightness|FX 6 Goblins|FX 7 Echoes|FX 8 Sci-fi|
Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|
Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|
Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot"""
GM_NAMES = [n.strip() for n in GM.replace("\n", "").split("|")]
FAMILIES = ["piano", "chromatic percussion", "organ", "guitar", "bass", "strings", "ensemble", "brass",
            "reed", "pipe", "synth lead", "synth pad", "synth effects", "ethnic", "percussive", "sound effects"]
RANGES = {"bass": "E1-G3", "piano": "A0-C8", "strings": "C2-C7", "brass": "E2-C6", "reed": "Bb2-A5", "pipe": "C4-C7", "guitar": "E2-E6"}
KITS = {0: "Standard", 8: "Room", 16: "Power", 24: "Electronic", 25: "TR-808", 32: "Jazz", 40: "Brush", 48: "Orchestra", 56: "SFX"}
DRUMS = {
    "kick": 36, "kick2": 35, "snare": 38, "snare2": 40, "rim": 37, "clap": 39, "hat": 42, "pedal": 44, "ohat": 46,
    "tom1": 50, "tom2": 47, "tom3": 45, "floor": 43, "crash": 49, "crash2": 57, "ride": 51, "ridebell": 53,
    "china": 52, "splash": 55, "cowbell": 56, "tamb": 54, "shaker": 70, "cabasa": 69, "conga": 63, "congalow": 64,
    "bongo": 60, "bongolow": 61, "timbale": 65, "agogo": 67, "clave": 75, "block": 76, "triangle": 81, "whistle": 72, "guiro": 74,
}


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def presets(path):
    data = open(path, "rb").read()
    i = data.find(b"phdr")
    size = struct.unpack("<I", data[i + 4 : i + 8])[0]
    rec = data[i + 8 : i + 8 + size]
    out = []
    for j in range(0, len(rec) - 38, 38):  # the last record is the EOP terminator
        name = rec[j : j + 20].split(b"\0")[0].decode("latin-1").strip()
        program, bank = struct.unpack("<HH", rec[j + 20 : j + 24])
        out.append((bank, program, name))
    return out


def main():
    found = presets(SF2)
    avail = {(b, p): n for b, p, n in found}
    items = [{"id": "soundfont", "kind": "soundfont", "name": "FluidR3 GM SoundFont", "file": FILE,
              "description": "The whole SoundFont file (for fluidsynth or other tools).", "meta": {"format": "sf2"}}]
    for prog, name in enumerate(GM_NAMES):
        if (0, prog) not in avail:
            continue
        fam = FAMILIES[prog // 8]
        meta = {"format": "sf2", "bank": 0, "program": prog, "family": fam, "sf2_preset": avail[(0, prog)]}
        if fam in RANGES:
            meta["range"] = RANGES[fam]
        items.append({"id": slug(name), "kind": "instrument", "name": name, "file": FILE, "tags": [fam, "gm"], "meta": meta})
    for (bank, prog), name in sorted(avail.items()):
        if bank != 128:
            continue
        kit = KITS.get(prog, name)
        items.append({"id": f"{slug(kit)}-kit", "kind": "drumkit", "name": f"{kit} drum kit", "file": FILE,
                      "description": "Grid row names: " + " ".join(DRUMS), "tags": ["drums", "kit", "gm"],
                      "meta": {"format": "sf2", "bank": 128, "program": prog, "sf2_preset": name, "sounds": DRUMS}})
    manifest = {
        "id": "gm-instruments",
        "name": "General MIDI Instruments",
        "version": "1.0.0",
        "type": "music",
        "description": f"All {sum(1 for i in items if i['kind'] == 'instrument')} General MIDI instruments and "
                       f"{sum(1 for i in items if i['kind'] == 'drumkit')} drum kits of the FluidR3 GM SoundFont, rendered with FluidSynth.",
        "author": "Frank Wen (FluidR3 GM SoundFont)",
        "license": "MIT",
        "tags": ["general midi", "soundfont", "orchestra", "piano", "drums"],
        "software": ["studio-daw"],
        "docs": "README.md",
        "items": items,
    }
    json.dump(manifest, open("pack.json", "w"), indent=1)
    print(f"gm-instruments: {len(items)} items from {len(found)} SoundFont presets")


if __name__ == "__main__":
    sys.exit(main())
