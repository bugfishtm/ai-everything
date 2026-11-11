# General MIDI Instruments

All 128 General MIDI instruments and the drum kits of the FluidR3 GM SoundFont (MIT license),
played through FluidSynth.

```yaml
instruments:
  piano:   { use: gm-instruments/acoustic-grand-piano }
  strings: { use: gm-instruments/string-ensemble-1, octave: 3 }
  bass:    { use: gm-instruments/electric-bass-finger, octave: 2 }
  drums:   { use: gm-instruments/standard-kit }        # also room-kit, power-kit, electronic-kit, tr-808-kit, jazz-kit, brush-kit, orchestra-kit
patterns:
  beat:
    drums: |
      kick:  x---x---x---x---
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-x-x-
```

Item ids are the General MIDI names in lowercase with dashes (e.g. `electric-piano-1`,
`acoustic-guitar-nylon`, `pad-2-warm`, `lead-1-square`, `choir-aahs`, `french-horn`).
`studio packs show gm-instruments` lists them all; `studio-daw instruments <words>` searches.

Drum grid rows: kick kick2 snare snare2 rim clap hat pedal ohat tom1 tom2 tom3 floor crash crash2 ride
ridebell china splash cowbell tamb shaker cabasa conga congalow bongo bongolow timbale agogo clave block
triangle whistle guiro — or MIDI note numbers (35–81).

Outside studio-daw: `fluidsynth -ni -F out.wav "$(studio packs path gm-instruments/soundfont)" song.mid`.
