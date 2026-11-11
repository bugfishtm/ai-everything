# studio-video — videos from text timelines

Videos are YAML files (`*.video.yaml`): clips one after another with transitions, text and
pictures on top, subtitles, music and sounds. `studio-video render` turns them into an MP4
(+ GIF / WebM, + an `.srt` file). Clips can be video files, pictures, title cards — and things
the other Studio tools make: stick scenes (`studio-stickman`), pictures (`studio-image`), songs
and sound effects (`studio-daw`). They are rendered for you and cached.

```bash
studio-video new src/trailer.video.yaml            # starter (--template trailer|slideshow|social|blank)
studio-video check src/trailer.video.yaml          # validate fast: files, times, names
studio-video info src/trailer.video.yaml           # the timeline as a table: what is shown and heard when
studio-video sheet src/trailer.video.yaml          # contact sheet PNG of the key moments — LOOK at it
studio-video render src/trailer.video.yaml --preview     # → exports/trailer.mp4 + .studio/previews/trailer.png
studio-video render src/trailer.video.yaml --draft --from 8 --to 14   # half size, 15 fps, one part: fast
studio-video render src/trailer.video.yaml --gif --webm  # more formats
studio-video still src/trailer.video.yaml 2.5 "0:07"     # single frames as PNG
studio-video probe assets/gameplay.mp4             # length, size, frame rate, sound of ANY media file
studio-video frames assets/gameplay.mp4 --count 12 # contact sheet of a video file: see what the footage contains
studio-video list transitions                      # catalogue: transitions, generators, fonts
studio-video plugin new blinds --kind transition   # extend the tool (plugins/video/blinds.py)
```

**Watching without eyes:** videos cannot be read, pictures can. Before cutting footage run
`probe` (how long is it?) and `frames` (what is in it, and when?). After every change run `sheet`
(or `render --preview`) and read the PNG: a grid of the key moments with time stamps and clip
names. `info` prints the whole timeline with exact times. Work in this order: `check` → `sheet`
→ `render --draft` → `render`.

## Video file

```yaml
video:
  title: Night Drive Trailer
  size: [1280, 720]        # even numbers; [1080, 1920] for a vertical video
  fps: 30
  background: "#000000"    # behind pictures that do not fill the frame
  volume: 0                # dB on the final mix

clips:                     # the main track: one after another
  - name: opening
    title: "NIGHT DRIVE"            # a title card
    sub: "a tiny racing game"
    dur: 3
    background: { gradient: ["#1b2140", "#0b0d18"], angle: 90 }
    fade_in: 0.5
  - name: gameplay
    file: assets/gameplay.mp4       # a video file
    from: 3                         # seconds into the file (or "0:03")
    to: 9                           # or dur: 6
    volume: 0.6                     # its own sound (mute: true = silent)
    transition: crossfade           # how it comes in from the clip before
  - { image: assets/shot.png, dur: 4, zoom: [1.0, 1.15], pan: [left, right], transition: { type: slide-left, dur: 0.6 } }
  - { scene: src/fight.stick.yaml, from: 2, to: 6 }        # a studio-stickman scene
  - { picture: src/cover.image.yaml, dur: 3 }              # a studio-image picture
  - { color: "#000000", dur: 1 }
  - { generator: plasma, dur: 4 }                          # a computed clip (list generators)

overlays:                  # on top of the clips
  - { text: "Wishlist now", t: 8, dur: 3, at: [640, 620], size: 48, box: "#000000aa" }
  - { text: "Drift!", clip: gameplay, t: 1.5, dur: 2, at: [640, 120], size: 72, in: rise }
  - { image: assets/logo.png, t: 0, dur: end, at: [1200, 60], width: 120, opacity: 0.8 }

subtitles:                 # lines at the bottom — also written as exports/<name>.srt
  - { t: 1.0, dur: 2.5, text: "Night falls." }
  - { text: "The race begins." }                           # no t: right after the one before

audio:                     # music and sounds, mixed with the clips' own sound
  - { song: src/theme.song.yaml, gain: -8, duck: 8, fade_out: 2 }     # a studio-daw song
  - { file: assets/voice.mp3, t: 3.2 }
  - { sfx: explosion, clip: gameplay, t: 4.0, gain: -4 }              # a studio-daw sound effect
```

Coordinates are pixels of `video.size`, `(0, 0)` top left. Times are seconds (`12.5`) or
minutes:seconds (`"1:23"`).

### Clips

Exactly one kind per clip:

| Kind | Options |
|------|---------|
| `file: x.mp4` | `from`, `to` or `dur` (cut out of the file), `speed` (0.5 = slow motion, 2 = fast; the sound follows), `volume`, `mute`, `fit` |
| `image: x.png` | `dur`, `zoom: [start, end]` (≥ 1), `pan: [start, end]` (left · right · top · bottom · center · corners, or `[fx, fy]`), `fit`, `background` |
| `title: "…"` | `sub`, `dur`, `background` (color · `{ gradient: […], angle }` · `{ image: file, dim: 0.4 }`), `color`, `size`, `font`, `align` (left · center · right), `animate` (rise · fade · zoom · none) |
| `color: "#000"` | `dur` |
| `scene: x.stick.yaml` | `from`, `to`, `speed`, `volume` — rendered with studio-stickman (its sound effects come along) |
| `picture: x.image.yaml` | `dur`, `zoom`, `pan`, `fit`, `background` — rendered with studio-image |
| `generator: plasma` | `dur` + the generator's parameters (plasma, starfield, static, countdown) |

Options every clip takes: `name` (to point at it from overlays and sounds), `transition`,
`fade_in` / `fade_out` (seconds, from / to the background), `look: { brightness, contrast,
saturation, grayscale, blur }`, `caption: "…"` (a line at the bottom while the clip is shown),
`fit` (cover: fill the frame · contain: show everything, bars · stretch).

### Transitions

`transition: crossfade` or `transition: { type: wipe-left, dur: 0.6 }` on a clip is how it
replaces the clip before it. Default length 0.5 s; the two clips overlap for that time, so the
video gets shorter by it. `cut` · `crossfade` · `fade` (through black; `color`) · `flash` ·
`slide-left/right/up/down` · `push-…` · `wipe-…` (`soft`) · `zoom` · `circle`.

### Overlays

| Kind | Options |
|------|---------|
| `text: "…"` | `at: [x, y]`, `size`, `font`, `color`, `anchor` (left · center · right), `valign` (top · middle · bottom), `width` (wrap), `align`, `stroke`, `shadow`, `box` (a color: plate behind the text), `spacing`, `upper` |
| `image: x.png` / `picture: x.image.yaml` | `at`, `anchor`, `width` / `height`, `rotate` |
| `rect: [x, y, w, h]` | `color`, `radius` — bars and plates (lower thirds) |

When: `t` and `dur` in seconds (`dur: end` = until the end). With `clip: name` (or its number)
the times count from that clip's start and `dur` defaults to the clip's length — the overlay
moves with the clip when the cut changes. `in` / `out`: `fade` (default), `rise`, `none`;
`fade: 0.3` sets the length; `opacity`.

### Sound

| Kind | |
|------|---|
| `file: x.mp3` | any audio (or the sound of a video) |
| `song: x.song.yaml` | a studio-daw song — rendered when needed |
| `sfx: coin` | a studio-daw one-shot (`studio-daw sfx list`); `pitch`, `seed` |

Options: `t` (or `clip:` + `t`), `gain` (dB), `fade_in`, `fade_out`, `from` / `dur` (a part of
the file), `loop: true` (repeat until the end), `duck: 8` (step back by 8 dB while clips have
sound — for music under speech or game sound). The mix is limited softly instead of clipping;
the report shows its peak.

## Output

| Command | Files |
|---------|-------|
| `render` | `exports/<name>.mp4` (H.264 + AAC), `<name>.srt` when there are subtitles; `--gif`, `--webm`; `--preview` adds `.studio/previews/<name>.png` |
| `sheet`, `still`, `frames` | PNGs in `.studio/previews/` |

`--json` prints a report for programs: files, seconds, frames, size, sound, warnings.
Stick scenes, pictures, songs and effects are rendered once into `.studio/cache/video/` and
reused until their source file changes.

## Extending the tool — plugins

A plugin is a Python file in `plugins/video/` of the project, loaded automatically.
`studio-video plugin new <name> --kind transition|generator` writes a working starter.

```python
from studio_video.api import Image, generator, math, np, transition

@transition("blinds", params={"count": 8}, doc="horizontal blinds open to the new clip")
def blinds(a, b, u, p):                   # a: old clip, b: new clip (RGB pictures); u: 0 → 1
    w, h = a.size
    out = a.copy()
    bar = h / int(p["count"])
    for i in range(int(p["count"])):
        y0 = int(i * bar)
        y1 = int(y0 + bar * u)
        if y1 > y0:
            out.paste(b.crop((0, y0, w, y1)), (0, y0))
    return out

@generator("pulse", params={"speed": 1.0}, doc="a color that breathes")
def pulse(t, w, h, p):                    # t: seconds since the clip began → picture or array (h, w, 3)
    v = int(60 + 50 * math.sin(t * p["speed"] * math.tau))
    return Image.new("RGB", (w, h), (v, 30, 90))
```

For moving pictures that need drawing (charts, diagrams, animated text) make a generator — it
is called for every frame, so keep it fast (compute small and scale up when the result is soft).

## Tips for good videos

- **Hook in the first two seconds:** the best picture first, the title after it.
- **Cut on action or on the beat.** With music from studio-daw you know the tempo: at 120 bpm a
  bar lasts 2 s — make clips 2, 4 or 8 s long.
- **One message per clip**, 2–4 s each for trailers; text overlays of at most six words, on
  screen for at least 1.5 s.
- **Few kinds of transitions:** cuts and crossfades for most, one strong one (flash, zoom) for
  the big moment.
- **Sound carries half of it:** music under everything (`duck` under speech), an effect on
  every cut that matters (`sfx: swoosh`), silence before the punchline.
- **Subtitles** for everything spoken; keep text inside a margin of 5 % of the frame.
- **Vertical video** (`size: [1080, 1920]`): keep the important part in the middle third.
