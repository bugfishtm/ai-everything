### Music — with studio-daw

Songs are text: `src/*.song.yaml` (instruments, note/chord/drum-grid patterns, arrangement,
mix). **Read the reference once: `studio-daw docs`.**

```bash
studio-daw new src/song.song.yaml --template basic   # starters: basic gm ambient lofi chiptune house
studio-daw check src/song.song.yaml                  # fast validation (bar lengths, names)
studio-daw render src/song.song.yaml --preview       # → exports/song.wav + .mp3, .studio/previews/song.png
studio-daw render src/song.song.yaml --from 9 --to 16   # iterate on a part
studio-daw instruments <words>                       # built-in synths, plugins, pack instruments
studio packs search <words> --type music             # SoundFont instruments, samples, kits, presets
studio-daw import assets/uploads/tune.mid            # a MIDI file → src/tune.song.yaml
studio-daw sfx coin,jump,hit --out exports/sfx       # one-shot sound effects (studio-daw sfx list)
```

**You cannot hear — so measure and look:** after every render read the report (LUFS, peaks,
per-track levels, warnings) and the spectrogram PNG. `studio-daw analyze <file>` works for any
audio (also pack samples). Aim for -14 LUFS, peaks ≤ -1 dBFS, no near-silent tracks.

Workflow: sketch the arrangement → patterns per section → render a few bars → adjust → full
render → MIDI/stems on request (`studio-daw midi`, `studio-daw export … --what wav,mp3,midi,stems --zip`).
Make the song move: `automate` effects change gain, pan or a filter along the bars
(`{ use: automate, param: lowpass, points: "intro:400 drop:12000" }`) — fades, sweeps, build-ups.

**The user has a DAW for the same files.** Songs open in the website's visual DAW (piano roll, drum
grid, mixer, live playback, exports). Its edits are written into the YAML, so re-read a song before
you change it, keep it valid and readable, and mention which file to open. Notes written by the DAW
have explicit octaves and may come as a list of voices; that is normal notation.

**Packs:** `gm-instruments` (all General MIDI instruments + drum kits), `studio-drums`
(one-shots, kits), `studio-synths` (presets, acid plugin) and whatever the user installed.

**Extend the DAW yourself** when a sound or effect is missing: `studio-daw plugin new <name>`
writes `plugins/daw/<name>.py` (Python + numpy: `studio_daw.api`). It appears in the user's DAW
right away; give parameters ranges (`{"value": 800, "min": 50, "max": 8000, "unit": "Hz",
"scale": "log"}`, `{"value": "saw", "options": [...]}`) so they get good knobs. Good plugins can become a
pack: `studio packs new my-synths --type music` → items → `studio packs install packs/my-synths`.

Deliverables: WAV + MP3 (+ MIDI, stems) in `exports/`. Save finished pieces to the library
(`studio lib add exports/x.mp3 src/x.song.yaml --name … --kind music`).
