---
name: video-edit
title: Edit a video
description: Use when the user wants a video cut together with studio-video — a trailer, slideshow, short, explainer, intro or a montage of footage, pictures, stick scenes and music — from the material to a finished MP4 that was looked at.
areas: [video, game, music, image, general]
---

# Edit a video

A video is a plan on a timeline. Know the material first, write the plan, then the file.

## 1. Know the material

```bash
studio-video probe assets/<file>                 # how long, how large, does it have sound?
studio-video frames assets/<file> --count 12     # read the PNG: what is in it, and when?
```

Do this for every video file before cutting — you cannot choose the good 4 seconds of a
clip you have not looked at. Pictures: `studio-image info`. No footage at all? Make it:
stick scenes (`studio-stickman`), pictures and title art (`studio-image`), music and effects
(`studio-daw`), title cards and moving backgrounds (built into studio-video).

## 2. Plan

Write the cut as comments at the top of the file: length, format (`[1280, 720]`, or
`[1080, 1920]` for phones), and the beats:

```
# 0–3    title card, music starts
# 3–9    gameplay: the jump sequence (file 0:14–0:20)
# 9–13   three features, one caption each
# 13–16  end card with the call to action
```

One message per clip. Trailers: clips of 2–4 s. With music, cut on bars (at 120 bpm one bar = 2 s).

## 3. Build

```bash
studio-video new src/<name>.video.yaml --template trailer|slideshow|social|blank
studio-video list transitions        # also: generators, fonts
```

- `clips:` in order. `file:` with `from` / `to`, `image:` with `zoom` and `pan`, `title:` cards,
  `scene:` (a `*.stick.yaml`), `picture:` (a `*.image.yaml`). Give clips a `name`.
- Transitions: cuts and `crossfade` for most; one strong one (`flash`, `zoom`) for the big moment.
- `overlays:` text with `clip: <name>` so it moves with the clip; at most six words, 1.5 s or longer.
- `audio:` music under everything (`song:` or `file:`, `gain: -8`, `duck: 8` when clips have
  sound, `fade_out`), an effect on cuts that matter (`sfx: swoosh`), nothing before a punchline.
- `subtitles:` for everything that is said.

## 4. Look — every time

```bash
studio-video check src/<name>.video.yaml
studio-video info src/<name>.video.yaml          # exact times of everything
studio-video sheet src/<name>.video.yaml         # read the contact sheet
studio-video render src/<name>.video.yaml --draft      # fast, with sound
```

In the contact sheet: Is every text inside the frame and readable on its background? Does a
caption sit on top of a subtitle? Is a clip black or frozen (wrong `from` / `to`)? Do the
transitions connect the right clips? Fix what `check` warns about.

## 5. Deliver

```bash
studio-video render src/<name>.video.yaml --preview     # → exports/<name>.mp4 (+ .srt)
```

Say the length, the format and what happens in one line; mention `--gif` / `--webm` and a
vertical version when that is useful. The user can press Check / Draft / Render on the file in
the Files tab.
