---
name: mix-and-master
title: Mix and master a song
description: Use when a studio-daw song sounds muddy, thin, harsh, too quiet or too loud, when instruments cannot be heard, or when the user asks to mix, balance, master or "make it sound better".
areas: [music, game, video]
---

# Mix and master a song

Work from measurements. Change one thing, render, compare the numbers.

## 1. Measure the current state

```bash
studio-daw render src/<name>.song.yaml --preview --stems
studio-daw analyze exports/<name>.wav --preview
```

Note: integrated loudness (LUFS), peak (dBFS), the level of every track (rms) and the spectrum
balance. Look at the preview PNG.

## 2. Balance (gain first, effects later)

- Order of loudness in most styles: kick ≈ lead/vocal line > snare > bass > chords/pads > extras.
- Fix levels with `mix: { <track>: { gain: -6 } }`. A good mix is mostly gain and pan.
- Pan to make room: bass, kick, snare and lead in the middle; doubles, hats, pads and
  percussion left/right (`pan: -0.3 … 0.3`).

## 3. Typical problems

| Hear / measure | Fix |
|----------------|-----|
| muddy, booming (a lot of energy at 150–400 Hz) | `highpass` on everything that is not bass or kick (120–200 Hz); move chords up an octave |
| bass and kick fight | `sidechain` on the bass (`source: drums, amount: 0.3–0.5`); bass notes shorter (`gate`) |
| thin, no weight | bass one octave lower, add `sub` on the bass synth, fewer highpass filters |
| harsh, piercing (2–5 kHz) | `eq` cut there on leads, lower the hats, `lowpass` on saw sounds |
| dull, no air | hats / shaker a little louder, `eq: { high: 1.5 }` on the master |
| flat, everything in front | reverb and delay as shortcuts: `reverb: 0.2–0.4` on pads and leads, none on bass and kick |
| pumping, distorted | peaks too hot: lower track gains before the master does the work |
| sections all sound the same | `automate`: open a filter into the chorus (`param: lowpass`), fade pads in (`param: gain`), drop the bass for a bar |

`studio-daw effects` lists every effect with its parameters.

## 4. Master

```yaml
master: { target: -14, ceiling: -1, fade_out: 3 }
```

- `target`: -14 LUFS for streaming and video, -16 for background music in games, -9 … -11 for
  loud club styles (only when the mix has the headroom).
- `ceiling: -1` keeps the peak safe for MP3. Never above -0.3.
- No fade-out on loops.

## 5. Verify and report

Render again and compare: LUFS at the target (±1), peak below the ceiling, no track more than
~12 dB under the others unless it is meant as texture. Tell the user what you changed and the
before/after numbers in a few lines.
