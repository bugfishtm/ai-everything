# studio-daw — music from text

Songs are YAML files (`*.song.yaml`). They are the save format: readable, diffable,
editable by you and by Claude. `studio-daw render` turns them into WAV/MP3 (+ stems,
MIDI, a spectrogram preview and a numeric report).

```bash
studio-daw new src/theme.song.yaml            # starter song (--template basic|gm|ambient|lofi|chiptune|house)
studio-daw check src/theme.song.yaml          # validate fast (bar lengths, names, params)
studio-daw render src/theme.song.yaml --preview   # → exports/theme.wav + .mp3, .studio/previews/theme.png
studio-daw render src/theme.song.yaml --from 9 --to 16   # just bars 9–16 while iterating
studio-daw instruments piano                  # what can I play? (built-ins, plugins, packs)
studio-daw effects
studio-daw analyze exports/theme.wav --preview   # loudness, peak, spectrum balance
studio-daw midi src/theme.song.yaml           # → exports/theme.mid (tempo map, GM programs, drums on ch 10)
studio-daw export src/theme.song.yaml --what wav,mp3,midi,stems --zip   # everything + song text in one zip
studio-daw import assets/uploads/tune.mid     # MIDI file → src/tune.song.yaml (tracks, patterns, sections)
studio-daw sfx coin,jump,hit --out assets/sfx # one-shot sound effects for games/videos (studio-daw sfx list)
```

**People edit songs too.** The website opens `*.song.yaml` in a visual DAW (arrangement, piano
roll, drum grid, mixer, exports). It writes its edits back into the YAML — only the touched
values, so comments and your layout stay — and it uses this engine for everything (parsing,
sounds, render). Expect files you did not write: explicit octaves (`A2:q.`), notes after the
duration they inherit (`F5:e Ab5 C6`), several voices as a list when notes overlap, velocities
as dynamics or `!90`. Keep songs valid YAML and readable; re-read a song before editing it.

**Listening without ears:** after rendering, read the report (LUFS, peaks, per-track
levels, warnings) and look at the preview PNG (waveform + spectrogram with section
markers). `analyze` works on any audio file, e.g. samples in packs.

## Song file

```yaml
song:
  title: Night Drive
  bpm: 92                 # 20–400
  time: 4/4               # 3/4, 6/8 … (durations are always counted in quarter notes)
  swing: 0.2              # 0–0.5: delays every second 16th (swing_unit: 8 for 8ths)
  humanize: 0.3           # 0–1 timing/velocity variation (seed: 1 makes it repeatable)
  tail: 2.5               # seconds rendered after the last bar (reverb tails)

instruments:              # name → what plays it
  drums: { use: drums }                                   # built-in synth kit
  bass:  { use: bass, cutoff: 700, octave: 2 }            # built-in synth + params
  piano: { use: gm-instruments/acoustic-grand-piano }     # pack item (SoundFont preset)
  kick:  { use: studio-drums/kick-deep }                  # pack sample
  vox:   { use: sample, file: assets/vox.wav, root: C4 }  # project sample, pitched
  perc:  { kit: { kick: studio-drums/kick-deep, snare: snare, hat: hat } }   # your own kit
  acid:  { use: acid }                                    # plugin from plugins/daw/acid.py

patterns:                 # reusable blocks: instrument → music
  beat:
    drums: |              # step grid, one row per sound, default step = 16th
      kick:  x---x---x---x---
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-xoxo
  harmony:
    pad: { chords: "Am7 | Fmaj7 | C | G" }            # one chord per bar by default
  line:
    bass: "A:q. A:e r:e E:e G:q | F:q. F:e r C3:e E:q"   # notes
    piano: ["E5:h D5:h", "C4:w"]                      # a list = several voices at once

arrangement:              # sections in order; patterns loop to fill the section
  - { section: intro, bars: 4, play: [harmony] }
  - { section: verse, bars: 8, play: [beat, harmony, line] }
  - { section: drop,  bars: 8, play: [beat, { pattern: line, transpose: 12 }], bpm: 96 }

mix:                      # per instrument (can also be written inside `instruments`)
  bass:  { gain: -3, pan: 0, effects: [ { use: sidechain, source: drums, amount: 0.4 } ] }
  piano: { gain: -6, pan: -0.2, reverb: 0.3, delay: 0.15 }   # reverb/delay = wet amount shortcuts
  pad:   { mute: true }                                       # mute / solo: true

master: { target: -14, ceiling: -1, fade_out: 4, effects: [ { use: eq, high: 1.5 } ] }
```

Without `arrangement`, all patterns play together (`song.loop: 4` repeats them).

### Notes (`"C4:q E4 G4:e"`)

| Token | Meaning |
|-------|---------|
| `C4` `F#3` `Bb2` `e5` | note (C4 = middle C). Without octave: the instrument's `octave` (default 4) or the last `o3` |
| `:q` | duration: `w` 4, `h` 2, `q` 1, `e` ½, `s` ¼, `t` ⅛ beats; dotted `q.` `h..`; triplet `e3`; numbers `1.5`, `1/3`; bars `2bar`. **Stays in effect** for the next notes |
| `r` `-` `~` | rest (`r:h`) |
| `_` | tie: lengthen the previous note(s) (`C4:h _:q`) |
| `C4+E4+G4` | several notes at once |
| `[Am7]` `[Dm/F]` `[G7@3]` | chord symbol inside a note line (`@n` = octave) |
| `!90` or `!0.7` | velocity (0–127 or 0–1), e.g. `C4:q!110` |
| `^` | accent, `'` staccato: `E4:e'^` |
| `pp p mp mf f ff` | dynamics for the following notes |
| `o3` `>` `<` | set / raise / lower the default octave |
| `(C4 E4 G4)*4` `C4:e*8` | repeat |
| `|` | bar line — checked: a warning tells you if a bar is too long/short |

Chords (`{ chords: "…" }`): `C Am F#m7 Bbmaj7 G7sus4 Dm/F Cadd9 E7#9 …`, duration like notes
(`Am7:2`, default one bar), options `octave` (default 3), `voicing: close|open|drop2`, `velocity`.

Explicit form: `{ notes: "…", octave: 5, gate: 0.6, velocity: 0.8, transpose: -12 }`,
or exact events: `{ events: [ {t: 0, n: C4, d: 1.5, v: 0.8}, {t: 2, k: snare} ] }`.

### Grids

`x` hit, `X` accent, `o` ghost, `1`–`9` velocity, `-`/`.` rest; `|` and spaces are ignored.
Rows that are shorter repeat. `{ grid: "…", step: e }` changes the step (default `s` = 16th).
Row names are sounds of the instrument: built-in `drums` (kick snare clap rim hat ohat tom1 tom2 tom3
crash ride shaker cowbell), General MIDI kits (kick snare rim clap hat ohat pedal tom1-3 floor crash ride
china splash cowbell tamb shaker conga bongo clave block triangle … or MIDI note numbers),
or the names of a `kit:`.

## Instruments

`studio-daw instruments [words]` lists everything with parameters. Built-ins:
`sine triangle square saw` (attack decay sustain release detune), `bass` (cutoff resonance sub),
`lead` (cutoff vibrato detune), `pad` (voices spread cutoff), `strings`, `pluck` (decay brightness),
`epiano` (tine), `bell` (ratio index decay), `organ` (drawbars leslie), drums `kick snare hat ohat clap
tom crash ride rim shaker cowbell`, and the kit `drums` (`sounds: { kick: { pitch: 45 } }` tweaks parts).

Pack items (`pack/item`, see `studio packs search … --type music`):
`instrument`/`drumkit` (SoundFont presets, rendered with FluidSynth), `sample` (one-shot, or pitched
when it has a `root`), `kit` (sounds → samples), `preset` (JSON `{use, params}` for a synth),
`plugin` (Python code, see below).

## Effects

`gain pan width eq lowpass highpass reverb delay chorus distortion saturate compressor limiter sidechain
tremolo autopan phaser gate bitcrush fade automate` — `studio-daw effects` shows parameters.
`delay.time` is in beats. Effects run in the order they are listed; `reverb:` / `delay:` next to
`gain` are shortcuts for a wet amount at the end of the chain.

### Automation — things that change along the song

```yaml
mix:
  pad:
    effects:
      - { use: automate, param: gain, points: "1:-18 5:0 21:0 25:-40" }        # fade in over bars 1–5, out from 21
      - { use: automate, param: lowpass, points: "intro:400 drop:12000", q: 2 } # filter opens until the drop
      - { use: automate, param: pan, points: "1:-0.8 9:0.8" }
master:
  effects: [ { use: automate, param: lowpass, points: "break:800 drop2:16000" } ]   # works on the master too
```

`param`: `gain` (dB), `pan` (-1 … 1), `lowpass` / `highpass` (Hz), `width` (0 … 2). `points` are
`position:value` pairs; a position is a bar number (bars count from 1, `2.5` = the middle of bar 2) or
the name of a section (its first bar). The value moves in a straight line between the points
(filters: evenly in pitch) and stays at the first / last value outside of them. Several `automate`
effects on one track are fine. Also time based: `gate` (chops a held sound: `pattern: "x-x-xx-x"`,
`step: 0.25` beats), `autopan` (`beats` per round trip), `phaser`, `tremolo`.

## Extending the DAW (plugins)

```bash
studio-daw plugin new acid                   # → plugins/daw/acid.py (instrument)
studio-daw plugin new wobble --kind effect   # → plugins/daw/wobble.py
```

Plugins are Python files using `studio_daw.api` (numpy, oscillators, envelopes, filters):

```python
from studio_daw.api import instrument, effect, osc, adsr, lowpass, np

@instrument("acid", params={"cutoff": 500, "resonance": 6, "decay": 0.25}, doc="303 style bass")
def acid(freq, dur, vel, sr, p):
    env = adsr(int(dur * sr), sr, 0.003, p["decay"], 0.0, 0.05)
    x = osc("saw", freq, len(env), sr)
    return lowpass(x, p["cutoff"] * (1 + 3 * vel), sr, q=p["resonance"]) * env * vel

@effect("crusher", params={"bits": 6})
def crusher(x, sr, p, ctx):          # x: stereo (n, 2); ctx: bpm, beat, stems, track
    q = 2 ** (p["bits"] - 1)
    return np.round(x * q) / q
```

Every `plugins/daw/*.py` of the project is loaded automatically — also while the user has the song
open in the website DAW: new instruments/effects show up there, their parameters become knobs and
their notes are rendered for live playback. A plugin that fails to load does not break other songs:
`check`/`render` report it as a warning (and as the reason when a song uses a missing name).

**Knobs in the DAW.** Ranges are guessed from parameter names (cutoff → Hz, log; attack/decay/release
→ seconds; mix/amount → 0–1 …). Say it exactly where it matters:

```python
@instrument("glass", params={
    "brightness": {"value": 0.6, "min": 0, "max": 1, "label": "bright"},
    "ratio":      {"value": 3.01, "min": 0.5, "max": 8, "scale": "log"},
    "decay":      {"value": 1.2, "min": 0.05, "max": 6, "unit": "s", "scale": "pow"},
    "shape":      {"value": "sine", "options": ["sine", "saw", "square"]},
}, doc="Shimmering FM glass keys")
def glass(freq, dur, vel, sr, p): ...      # p["brightness"] is the number, as before
# or keep plain defaults and add: ui={"cutoff": (50, 8000, "Hz", "log"), "wave": ["saw", "square"]}
```

Keys: `value`, `min`, `max`, `step`, `unit`, `scale` (`log`, `pow`, `linear`), `options`, `label`, `doc`.
Plugin effects are applied in the exact render; the DAW's live preview skips them (it marks them).

To share a plugin, put it in a
pack (item `kind: plugin`, `file: plugins/acid.py`, `meta: { target: studio-daw, voice: acid }`),
`studio packs install`, then publish it on the website. Plugin code in Global Space packs only runs
after an admin reviewed it.

## Importing MIDI

`studio-daw import <file.mid> [--out src/x.song.yaml] [--bars 4] [--quantize 16] [--synths] [--max-bars N]`
turns a MIDI file into a song: every track becomes an instrument (a General MIDI preset from the
`gm-instruments` pack, or a built-in synth with `--synths`), the piece is cut into sections of `--bars`
bars, parts that repeat share one pattern. Notes are written as exact events
(`{ t: 0, n: C4, d: 1, v: 0.8 }`, t and d in beats), drums as step grids. Timing snaps to 16ths
(`--quantize 32`, `48` for triplets, `0` keeps it). Then change instruments, add a mix — it is a normal song.

## Sound effects

`studio-daw sfx list` shows the built-in one-shots: jump, coin, pickup, powerup, hit, hurt, explosion,
laser, shoot, click, select, blip, error, win, lose, bounce, swoosh, step, door, splash, zap, alarm,
magic, thud. `studio-daw sfx coin,jump --out assets/sfx` writes `coin.wav`, `jump.wav` (peak -3 dBFS);
`all` makes every one. Shape them with `--pitch 1.3` (higher), `--dur 0.7` (shorter), `--seed 5` (other
noise); `--variants 4` writes four related versions (`hit-1.wav` …) so repeated sounds do not get dull;
`--mp3` for MP3. Need something else? Write a one-bar song for it, or an instrument plugin.

## Exports

`studio-daw midi <song>` writes a type-1 MIDI file: the notes as written (no humanize; swing kept),
a tempo map following the sections' `bpm`, one track per instrument, General MIDI programs for
SoundFont presets and the built-in synths, drums on channel 10 (kit sounds mapped to GM notes).
`studio-daw export <song> --what wav,mp3,midi,stems,yaml [--zip] [--from BAR --to BAR] [--name N]`
writes the chosen files to `exports/`; `--zip` adds `exports/<name>-export.zip` with the song text,
the renders, MIDI, stems, the project plugins and samples the song uses and a README. `<song>` can be
`-` to read the YAML from stdin (`--path` names it) — the website DAW exports unsaved edits that way.

## Tips for good results

- Write the arrangement first (intro → verse → chorus …), then fill patterns; keep bars complete.
- Render short ranges (`--from/--to`) while iterating; render the whole song at the end.
- Check the report: tracks far below the others (rms) are inaudible; peaks ≥ -0.1 dBFS mean clipping.
- Leave headroom with track gains (-3 … -12 dB); the master is normalized to `target` LUFS (-14 default).
- Make sections differ: drop instruments, open a filter with `automate`, fade a pad in — in the preview the sections should look different.
- Bass in octave 1–2, chords 3–4, melodies 4–5. Use `humanize` and `swing` for feel.
- Save reusable results as assets (`studio lib add exports/x.wav src/x.song.yaml …`) or packs.
