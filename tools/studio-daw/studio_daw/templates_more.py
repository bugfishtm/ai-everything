"""More starter songs for `studio-daw new --template …` (genre sketches that show the mixer tools)."""

MORE_SONG_TEMPLATES = {
    "lofi": """# {{TITLE}} — lo-fi hip hop sketch (reference: studio-daw docs)
song:
  title: {{TITLE}}
  bpm: 78
  time: 4/4
  swing: 0.28          # lazy shuffle
  humanize: 0.5

instruments:
  drums: { use: drums }
  bass:  { use: bass, cutoff: 500, octave: 2 }
  keys:  { use: epiano, octave: 4 }
  pad:   { use: pad, octave: 4 }

patterns:
  beat:
    drums: |
      kick:  x-----x---x-----
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-x-xo
  chords:
    keys: { chords: "Dm7 | G7 | Cmaj7 | A7", voicing: open, velocity: 0.6 }
  low:
    bass: "D:q. D:e r:q A1:q | G1:q. G1:e r:q D:q | C:q. C:e r:q G1:q | A1:q. A1:e r:q E:q"
  air:
    pad: { chords: "Dm7 | Dm7 | Cmaj7 | Cmaj7" }
  tune:
    keys: "r:q F5:e E5:e D5:q A4:q | r:q D5:e B4:e G4:h | r:q E5:e D5:e C5:q G4:q | r:q C#5:e E5:e A4:h"

arrangement:
  - { section: intro, bars: 4, play: [chords] }
  - { section: a,     bars: 8, play: [beat, chords, low] }
  - { section: b,     bars: 8, play: [beat, chords, low, tune] }
  - { section: outro, bars: 4, play: [chords, air] }

mix:
  drums: { gain: -2, effects: [ { use: lowpass, cutoff: 6000 }, { use: saturate, drive: 1.8, tone: 0.3 } ] }
  bass:  { gain: -6, effects: [ { use: sidechain, source: drums, amount: 0.35 } ] }
  keys:  { gain: -3, pan: -0.1, reverb: 0.3, effects: [ { use: tremolo, rate: 4, depth: 0.25 }, { use: lowpass, cutoff: 3800 } ] }
  pad:   { gain: 3, reverb: 0.5 }

# automation: the whole mix opens up from a muffled intro (points are bar:value or section:value)
master: { target: -16, ceiling: -1, fade_out: 3, effects: [ { use: automate, param: lowpass, points: "intro:900 a:14000" } ] }
""",
    "chiptune": """# {{TITLE}} — 8-bit game tune (reference: studio-daw docs)
song:
  title: {{TITLE}}
  bpm: 150
  time: 4/4

instruments:
  lead:  { use: square, octave: 5, attack: 0.002, decay: 0.08, sustain: 0.5, release: 0.04 }
  harm:  { use: square, octave: 4, decay: 0.05, sustain: 0.3 }
  bass:  { use: triangle, octave: 2 }
  drums: { use: drums }

patterns:
  beat:
    drums: |
      kick:  x---x---x---x---
      snare: ----x-------x---
      hat:   --x---x---x---x-
  arp:
    harm: "(C4:s E4 G4 C5)*4 | (A3:s C4 E4 A4)*4 | (F3:s A3 C4 F4)*4 | (G3:s B3 D4 G4)*4"
  low:
    bass: "C:e C:e r:e C:e C:e r:e C:e C:e | A1:e A1:e r:e A1:e A1:e r:e A1:e A1:e | F1:e F1:e r:e F1:e F1:e r:e F1:e F1:e | G1:e G1:e r:e G1:e G1:e r:e G1:e G1:e"
  tune:
    lead: "E5:q G5:e E5:e C5:q r:q | C5:q E5:e C5:e A4:q r:q | A4:q C5:e A4:e F4:q A4:q | B4:q D5:q G5:h"

arrangement:                     # a loop for a game level: it ends where it starts (no fade-out)
  - { section: intro, bars: 4, play: [arp, low] }
  - { section: a,     bars: 8, play: [beat, arp, low, tune] }
  - { section: b,     bars: 8, play: [beat, low, tune] }
  - { section: turn,  bars: 4, play: [beat, arp, low] }

mix:
  lead:  { gain: -2, delay: 0.15 }
  harm:  { gain: -12, pan: 0.3, effects: [ { use: bitcrush, bits: 6 } ] }
  bass:  { gain: -9 }
  drums: { gain: -6, effects: [ { use: bitcrush, bits: 7, downsample: 3 } ] }

master: { target: -16, ceiling: -1 }
""",
    "house": """# {{TITLE}} — house track with a build, a drop and a break (reference: studio-daw docs)
song:
  title: {{TITLE}}
  bpm: 124
  time: 4/4

instruments:
  drums: { use: drums }
  bass:  { use: bass, cutoff: 900, octave: 2 }
  stab:  { use: saw, octave: 4, attack: 0.005, decay: 0.18, sustain: 0.0, release: 0.08, detune: 0.12 }
  pad:   { use: pad, octave: 4 }

patterns:
  four:
    drums: |
      kick:  x---x---x---x---
      clap:  ----x-------x---
      hat:   --x---x---x---x-
      ohat:  --------------x-
  hats:
    drums: |
      hat:   x-x-x-x-x-x-x-x-
  groove:
    bass: "r:e A:e r:e A:e r:e A:e r:e A:e | r:e F:e r:e F:e r:e F:e r:e F:e | r:e C3:e r:e C3:e r:e C3:e r:e C3:e | r:e G:e r:e G:e r:e G:e r:e G:e"
  chords:
    stab: "r:e [Am7]:e r:q r:e [Am7]:e r:q | r:e [Fmaj7]:e r:q r:e [Fmaj7]:e r:q | r:e [C]:e r:q r:e [C]:e r:q | r:e [G]:e r:q r:e [G]:e r:q"
  wash:
    pad: { chords: "Am7 | Fmaj7 | C | G" }

arrangement:
  - { section: intro, bars: 8,  play: [four, wash] }
  - { section: build, bars: 8,  play: [four, hats, groove, wash] }
  - { section: drop,  bars: 16, play: [four, hats, groove, chords, wash] }
  - { section: break, bars: 8,  play: [wash, chords] }
  - { section: drop2, bars: 16, play: [four, hats, groove, chords, wash] }
  - { section: outro, bars: 8,  play: [four, wash] }

mix:
  drums: { gain: -3 }
  bass:  { gain: 0, effects: [ { use: sidechain, source: drums, amount: 0.6 } ] }
  stab:                          # the filter closes towards the break and opens again for the second drop
    gain: -3
    pan: 0.15
    delay: 0.2
    reverb: 0.25
    effects: [ { use: automate, param: lowpass, points: "drop:9000 break:500 drop2:9000" } ]
  pad:                           # pumping with the kick, chopped by a gate, faded in over the intro
    gain: 2
    reverb: 0.4
    effects:
      - { use: sidechain, source: drums, amount: 0.5 }
      - { use: gate, pattern: "x-xxx-xx", step: 0.25, depth: 0.6 }
      - { use: automate, param: gain, points: "intro:-12 build:0" }

master: { target: -11, ceiling: -1, fade_out: 4 }
""",
}
