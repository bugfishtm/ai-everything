---
name: song-production
title: Produce a song
description: Use when the user asks for a complete song, track, theme, jingle or loop made with studio-daw — from an idea ("a sad lo-fi beat", "boss fight music") to a finished, checked render.
areas: [music, game, video]
---

# Produce a song

A finished song is planned first, written in sections, and checked by measuring — not by hoping.

## 1. Pin the brief (one short message, only if it is not already clear)

Genre and mood, tempo feel (slow / mid / fast), length, loop or song, where it is used (game
level, video, listening). If the user gave an idea, decide the rest yourself and say what you chose.

## 2. Plan before notes

Write the plan into the song file as comments at the top:

- key and scale, bpm, time signature
- sections with bar counts (intro 4 · verse 8 · chorus 8 · bridge 4 · outro 4 …)
- which instruments play in which section (the arrangement is what makes it a song)
- one hook: a short melodic or rhythmic idea that comes back

## 3. Build it

```bash
studio-daw new src/<name>.song.yaml --template basic     # or gm (SoundFont instruments), ambient, lofi, chiptune, house
studio-daw import assets/uploads/<file>.mid              # start from a MIDI file the user uploaded
studio-daw instruments <words>     # what can play: built-ins, pack instruments, plugins
studio packs search <words> --type music
```

- Write `arrangement` first, then the patterns it names. Keep every bar complete (`|` is checked).
- Registers: bass in octave 1–2, chords 3–4, melody 4–5. Do not stack everything in one octave.
- Drums: kick and snare carry the pulse, hats give the speed; change the pattern for fills at
  the end of sections (every 4th or 8th bar).
- Variation: transpose, drop an instrument, halve the drums, add a counter melody — a section
  that repeats unchanged more than twice gets boring.
- Feel: `swing` for shuffled styles, `humanize: 0.2–0.4` for played ones, none for strict electronic.
- Movement: `automate` effects make sections breathe — a filter that opens into the chorus, a pad that
  fades in, the bass muted for one bar before a drop (`studio-daw docs`, section Automation).

## 4. Check by measuring

```bash
studio-daw check src/<name>.song.yaml                 # after every edit
studio-daw render src/<name>.song.yaml --from 1 --to 8 --preview    # a part while iterating
studio-daw render src/<name>.song.yaml --preview      # the whole song at the end
```

Read the report and the preview PNG (waveform + spectrogram with section markers):

- a track far below the others (rms) is inaudible → raise it or thin out what masks it
- peaks at or above -0.1 dBFS → lower track gains (leave -3 … -12 dB per track)
- the spectrogram shows holes (no bass, no highs) or a wall (everything all the time)
- sections must look different from each other in the preview — if not, the arrangement is flat

## 5. Deliver

- `exports/<name>.mp3` and `.wav`; say the length, bpm, key and the sections in two lines.
- For games: a loop must end where it starts — no fade-out, the last bar leads back into bar 1.
- Offer what is useful next: stems (`--stems`), MIDI (`studio-daw midi`), a shorter loop version.
- The user can open the song in the website DAW and edit it by hand — keep the YAML tidy.
