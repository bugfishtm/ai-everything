---
name: music-video
title: Animate to music
description: Use when an animation must fit music — a stick figure dance or fight on the beat, a music video for a studio-daw song, or a video where cuts and moves follow the rhythm.
areas: [video, music]
---

# Animate to music

The song is the clock. Get the tempo and the section map first, then put every move on a beat.

## 1. The song

Make it (see the skill `song-production`) or take an existing one:

```bash
studio-daw render src/<song>.song.yaml          # → exports/<song>.mp3
studio-daw check src/<song>.song.yaml --json    # bpm, bars, seconds
```

Write down: bpm, time signature and the sections with their first bar, e.g.
`intro 1–4 · verse 5–12 · drop 13–20 · outro 21–24`. A song whose tempo changes between
sections cannot be mapped with one `bpm` — keep the tempo constant for a music video.

## 2. The scene follows the bars

```yaml
scene:
  audio: src/<song>.song.yaml    # the studio-daw song itself: rendered when needed, its bpm becomes the scene's
  audio_gain: 0                  # dB; sfx_gain: -6 keeps effects under the music
  # with a finished audio file instead (exports/<song>.mp3) set the tempo yourself:  bpm: 120
```

- Times are `"bar:beat"`: `t: "13:1"` is the first beat of the drop. Lengths in beats: `dur: "2b"`.
- Big changes (new figure, camera cut, costume, background energy) go on the first beat of a section.
- Strong moves land on beats 1 and 3, hits on the snare (2 and 4), small moves on off-beats.
- `do: dance, beats: 16` dances on the beat; `fx: bounce` or `fx: nod` keeps idle figures in time.
- `do: combo, gap: "1b"` lands one hit per beat.

## 3. Check sync

```bash
studio-stickman info src/<name>.stick.yaml            # every item with seconds and bar:beat
studio-stickman render src/<name>.stick.yaml --draft --from "13:1" --to "17:1"
```

Compare the times in `info` with the song sections. If everything is late by the same amount,
the audio file has silence at the start: set `audio_offset` (seconds).

## 4. Shape the energy

Quiet sections: wide camera, few moves, long holds. Loud sections: closer camera, faster
moves, particles (`burst: confetti`), flashes on accents. End on a held pose with the last note.

## 5. More than one scene

A whole music video is usually several scenes plus titles: put them on a timeline with
`studio-video` — `clips: [ { title: … }, { scene: src/verse.stick.yaml }, { scene: src/chorus.stick.yaml,
transition: flash } ]` and the song once under everything (`audio: [ { song: src/<song>.song.yaml } ]`;
set `volume: 0` on scenes that carry the same music themselves). Cut on bars. See the skill `video-edit`.

## 6. Deliver

`studio-stickman render src/<name>.stick.yaml --preview` → MP4 with the song and the effects mixed.
