"""Starter files for `studio-daw new` and `studio-daw plugin new`."""

SONG_TEMPLATES = {
    "basic": """# {{TITLE}} — studio-daw song (reference: studio-daw docs)
song:
  title: {{TITLE}}
  bpm: 96
  time: 4/4
  swing: 0.15        # 0 … 0.5, delays every second 16th
  humanize: 0.3      # small timing/velocity variation

instruments:
  drums: { use: drums }                       # built-in synth kit
  bass:  { use: bass, cutoff: 700, octave: 2 }
  keys:  { use: epiano, octave: 4 }
  pad:   { use: pad }

patterns:
  beat:
    drums: |
      kick:  x-------x-x-----
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-xox-
  groove:
    bass: "A:q. A:e r:e E:e G:q | F:q. F:e r:e C3:e E:q | C3:q. C3:e r:e G:e C3:q | G:q. G:e r:e D3:e F#:q"
    pad:  { chords: "Am7 | Fmaj7 | C | G" }
  melody:
    keys: "mf E5:q D5:e C5:e A4:h | C5:q A4:e G4:e F4:h | E4:q G4:e C5:e E5:q. D5:e | D5:w"

arrangement:
  - { section: intro,  bars: 4, play: [groove] }
  - { section: verse,  bars: 8, play: [beat, groove] }
  - { section: chorus, bars: 8, play: [beat, groove, melody] }
  - { section: outro,  bars: 4, play: [groove] }

mix:
  drums: { gain: 0, effects: [ { use: eq, high: 4 } ] }
  bass:  { gain: -7, effects: [ { use: sidechain, source: drums, amount: 0.3 } ] }
  keys:  { gain: 0, pan: -0.15, reverb: 0.25, delay: 0.12 }
  pad:   { gain: 2, pan: 0.2, reverb: 0.45 }

master: { target: -14, ceiling: -1 }
""",
    "gm": """# {{TITLE}} — uses the General MIDI pack (studio packs show gm-instruments)
song:
  title: {{TITLE}}
  bpm: 84
  time: 3/4

instruments:
  piano:   { use: gm-instruments/acoustic-grand-piano }
  strings: { use: gm-instruments/string-ensemble-1, octave: 3 }
  drums:   { use: gm-instruments/standard-kit }

patterns:
  waltz:
    piano:   "D3:q [D@4]:q [D@4]:q | A2:q [A@3]:q [A@3]:q | B2:q [Bm@3]:q [Bm@3]:q | G2:q [G@3]:q [G@3]:q"
    strings: { chords: "D:3 | A:3 | Bm:3 | G:3", octave: 3 }
    drums: |
      kick:  x-----x-----
      hat:   --x-x---x-x-
  tune:
    piano: "mf F#5:h E5:q | D5:h. | D5:q E5:q F#5:q | B4:h. | A4:q B4:q C#5:q | D5:h E5:q | F#5:h. | r:h."

arrangement:
  - { section: A, bars: 4, play: [waltz] }
  - { section: B, bars: 8, play: [waltz, tune] }

mix:
  piano: { reverb: 0.2 }
  strings: { gain: -2, reverb: 0.4 }
  drums: { gain: 6 }
""",
    "ambient": """# {{TITLE}} — slow evolving ambient piece
song:
  title: {{TITLE}}
  bpm: 60
  time: 4/4

instruments:
  pad:   { use: pad, attack: 2.5, release: 4, cutoff: 1400 }
  bell:  { use: bell, octave: 5 }
  pluck: { use: pluck, octave: 4 }

patterns:
  drift:
    pad: { chords: "Cmaj7:2bar Am9:2bar Fmaj7:2bar G6:2bar", voicing: open }
  sparkle:
    bell:  "r:h G5:q E5:q | r:w | r:h C6:q B5:q | r:w"
    pluck: "C4:e G4:e E5:e G4:e C4:e G4:e E5:e G4:e | A3:e E4:e C5:e E4:e A3:e E4:e C5:e E4:e"

arrangement:
  - { section: open, bars: 8, play: [drift] }
  - { section: glow, bars: 16, play: [drift, sparkle] }

mix:
  pad:   { gain: -6, reverb: 0.6 }
  bell:  { gain: -10, reverb: 0.7, delay: 0.3 }
  pluck: { gain: -12, pan: 0.3, reverb: 0.5, delay: 0.25 }

master: { target: -16, fade_out: 6 }
""",
}

PLUGIN_INSTRUMENT = '''"""{{NAME}} — a studio-daw instrument plugin (loaded from plugins/daw/).

Use it in a song:   instruments: { lead: { use: {{NAME}}, cutoff: 1200 } }
Parameters in `params` become defaults; songs override them. Each one is a knob in the website DAW:
a plain default gets a guessed range, {"value": …, "min": …, "max": …, "unit": …, "scale": "log"}
sets it exactly, {"value": "saw", "options": [...]} makes a dropdown.
"""
from studio_daw.api import adsr, instrument, lowpass, np, osc


@instrument("{{NAME}}", params={
    "attack": {"value": 0.01, "min": 0, "max": 2, "unit": "s", "scale": "pow"},
    "decay": {"value": 0.2, "min": 0, "max": 4, "unit": "s", "scale": "pow"},
    "sustain": {"value": 0.6, "min": 0, "max": 1},
    "release": {"value": 0.3, "min": 0, "max": 6, "unit": "s", "scale": "pow"},
    "cutoff": {"value": 2000, "min": 40, "max": 16000, "unit": "Hz", "scale": "log"},
    "wave": {"value": "saw", "options": ["saw", "square", "triangle", "sine"]},
}, doc="Describe the sound in one line (shown by: studio-daw instruments and in the DAW)")
def {{NAME}}(freq, dur, vel, sr, p):
    # freq: Hz, dur: held seconds, vel: 0..1, sr: sample rate, p: merged params
    env = adsr(int(dur * sr), sr, p["attack"], p["decay"], p["sustain"], p["release"])
    n = len(env)
    x = osc(p["wave"], freq, n, sr) * 0.6 + osc("square", freq * 1.005, n, sr) * 0.4
    x = lowpass(x, p["cutoff"], sr, q=1.1)
    return x * env * vel ** 1.5 * 0.4          # mono or (n, 2) stereo numpy array
'''

PLUGIN_EFFECT = '''"""{{NAME}} — a studio-daw effect plugin (loaded from plugins/daw/).

Use it in a song:   mix: { keys: { effects: [ { use: {{NAME}}, amount: 0.5 } ] } }
Parameters are knobs in the website DAW ({"value": …, "min": …, "max": …} sets the range). Plugin
effects are heard in the exact render (Render / export); the DAW's live preview skips them.
"""
from studio_daw.api import effect, np


@effect("{{NAME}}", params={"amount": {"value": 0.5, "min": 0, "max": 1}}, doc="Describe the effect in one line")
def {{NAME}}(x, sr, p, ctx):
    # x: stereo float array (n, 2); ctx: bpm, beat (seconds per beat), stems, track, warnings
    wet = np.tanh(x * (1 + 4 * p["amount"]))
    return x * (1 - p["amount"]) + wet * p["amount"]
'''

from .templates_more import MORE_SONG_TEMPLATES  # noqa: E402

SONG_TEMPLATES.update(MORE_SONG_TEMPLATES)
