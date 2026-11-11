"""Starter files for `studio-video new` and `studio-video plugin new`."""

VIDEOS = {
    "trailer": """# {{TITLE}} — studio-video timeline (reference: studio-video docs)
video:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30

clips:                          # the main track: one after another
  - name: opening
    title: "{{TITLE}}"          # a title card
    sub: "a short line that says what it is"
    dur: 3
    background: { gradient: ["#1b2140", "#0b0d18"], angle: 90 }
    fade_in: 0.5
  - name: middle
    generator: plasma           # a moving background — replace with your footage:
    dur: 5                      #   { file: assets/gameplay.mp4, from: 3, to: 8 }      a video file
    transition: crossfade       #   { image: assets/shot.png, dur: 4, zoom: [1.0, 1.15] }   a still with a slow zoom
  - name: ending                #   { scene: src/fight.stick.yaml }                    a studio-stickman scene
    title: "Out now"            #   { picture: src/cover.image.yaml, dur: 3 }          a studio-image picture
    sub: "example.com"
    dur: 3
    background: "#0b0d18"
    transition: { type: fade, dur: 0.8 }
    fade_out: 0.6

overlays:                       # on top; times in seconds — or relative to a clip
  - { text: "Feature one", clip: middle, t: 0.6, dur: 1.8, at: [640, 360], size: 64 }
  - { text: "Feature two", clip: middle, t: 2.8, dur: 1.8, at: [640, 360], size: 64, in: rise }

audio:                          # under the clips' own sound
  - { sfx: powerup, t: 0.3, gain: -8 }                  # studio-daw sound effects (studio-daw sfx list)
  - { sfx: swoosh, clip: middle, t: 0, gain: -8 }
  # - { file: exports/song.mp3, gain: -6, fade_in: 1, fade_out: 2 }     # music: a file …
  # - { song: src/theme.song.yaml, gain: -8, duck: 8 }                  # … or a studio-daw song (rendered for you)
""",
    "slideshow": """# {{TITLE}} — a slideshow of pictures (reference: studio-video docs)
video:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30
  background: "#101014"

clips:
  - { title: "{{TITLE}}", dur: 2.5, background: "#101014", fade_in: 0.5 }
  # one line per picture — put yours into assets/ and replace these cards:
  #   - { image: assets/photo1.jpg, dur: 4, zoom: [1.0, 1.12], pan: [left, right], transition: crossfade }
  #   - { image: assets/photo2.jpg, dur: 4, zoom: [1.12, 1.0], transition: crossfade, caption: "Summer 2026" }
  #   fit: contain shows the whole picture with bars (default: cover fills the frame)
  - { color: "#3b82f6", dur: 3, transition: crossfade, caption: "picture 1" }
  - { color: "#22c55e", dur: 3, transition: { type: slide-left, dur: 0.6 }, caption: "picture 2" }
  - { color: "#f59e0b", dur: 3, transition: { type: wipe-right, dur: 0.6 }, caption: "picture 3" }
  - { title: "The end", dur: 2.5, background: "#101014", transition: { type: fade, dur: 0.8 }, fade_out: 0.8 }

# audio:
#   - { file: assets/music.mp3, gain: -6, fade_in: 1, fade_out: 3 }
""",
    "social": """# {{TITLE}} — a vertical short for phones (reference: studio-video docs)
video:
  title: {{TITLE}}
  size: [1080, 1920]            # 9:16
  fps: 30

clips:
  - { generator: plasma, dur: 6, colors: ["#0f172a", "#7c3aed", "#ec4899", "#fde68a"] }
  - { title: "Follow for more", dur: 2, background: "#0f172a", transition: { type: zoom, dur: 0.5 } }

overlays:
  - { text: "{{TITLE}}", t: 0.3, dur: 2.2, at: [540, 700], size: 120, width: 900, in: rise }
  - { text: "Say it in one line.", t: 2.7, dur: 3.0, at: [540, 960], size: 84, width: 900, box: "#000000aa" }

subtitles:                      # lines at the bottom (also written as .srt)
  - { t: 0.4, dur: 2.0, text: "Subtitles help when the sound is off." }

audio:
  - { sfx: select, t: 0.3, gain: -6 }
""",
    "blank": """# {{TITLE}} — studio-video timeline (reference: studio-video docs)
video:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30

clips:
  - { title: "{{TITLE}}", dur: 3 }
""",
}

PLUGINS = {
    "transition": '''"""{{NAME}} — a studio-video transition (loaded from plugins/video/).

Use it:   clips: [ { … }, { file: b.mp4, transition: { type: {{NAME}}, dur: 0.8 } } ]
"""
from studio_video.api import transition


@transition("{{NAME}}", params={"count": 8}, doc="Describe the transition in one line (shown by: studio-video list transitions)")
def {{NAME}}(a, b, u, p):
    # a: the old clip's picture, b: the new clip's picture (RGB, same size) · u: 0 → 1 · p: parameters
    # return one picture of the same size
    w, h = a.size
    out = a.copy()
    n = max(1, int(p["count"]))
    bar = h / n
    for i in range(n):
        y0 = int(i * bar)
        y1 = int(y0 + bar * u)
        if y1 > y0:
            out.paste(b.crop((0, y0, w, y1)), (0, y0))
    return out
''',
    "generator": '''"""{{NAME}} — a studio-video generator: a clip that is computed (loaded from plugins/video/).

Use it:   clips: [ { generator: {{NAME}}, dur: 4, speed: 1.5 } ]
"""
from studio_video.api import Image, generator, math, np


@generator("{{NAME}}", params={"speed": 1.0, "color": [80, 160, 255]}, doc="Describe the clip in one line")
def {{NAME}}(t, w, h, p):
    # t: seconds since the clip began · w, h: frame size · p: parameters
    # return an RGB picture (PIL) or an array (h, w, 3) with 0 … 255 — keep it fast: it runs for every frame
    sw, sh = max(8, w // 4), max(8, h // 4)            # compute small and scale up when the picture is soft
    yy, xx = np.mgrid[0:sh, 0:sw] / max(sw, sh)
    v = 0.5 + 0.5 * np.sin((xx * 8 + yy * 5) + t * float(p["speed"]) * math.tau / 2)
    rgb = np.stack([v * c for c in p["color"]], axis=-1).astype("uint8")
    return Image.fromarray(rgb, "RGB").resize((w, h), Image.BICUBIC)
''',
}
