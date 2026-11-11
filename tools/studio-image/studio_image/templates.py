"""Starter files for `studio-image new` and `studio-image plugin new`."""

PICTURES = {
    "poster": """# {{TITLE}} — studio-image picture (reference: studio-image docs)
image:
  title: {{TITLE}}
  size: [1280, 720]
  background: { gradient: ["#1b2140", "#0b0d18"], angle: 90 }       # top → bottom
  palette: { accent: "#a78bfa", warm: "#ffd166" }                   # names you can use as colors

layers:                         # bottom first
  - { texture: stars, colors: ["#00000000", "#ffffff"], count: 260, opacity: 0.8 }
  - { circle: [980, 210, 150], fill: { gradient: [warm, "#ff7b54"], angle: 90 }, glow: { radius: 60, color: "#ff9a5c" } }
  - { wave: [0, 520, 1280, 220], waves: 1.5, amplitude: 36, fill: "#141a33" }
  - { wave: [0, 580, 1280, 160], waves: 2.2, amplitude: 24, phase: 0.3, fill: "#0e1226" }
  - text: "{{TITLE}}"
    at: [90, 300]
    anchor: left
    size: 110
    font: bold
    fill: { gradient: ["#ffffff", "#c7b8ff"], angle: 90 }
    shadow: { dy: 8, blur: 18, color: "#00000088" }
  - { text: "a short line that says what it is", at: [96, 395], anchor: left, size: 34, font: sans, fill: "#b9c0d8" }
  - { rect: [96, 440, 140, 6], radius: 3, fill: accent }

filters:                        # on the whole picture
  - { vignette: 0.35 }
  - { grain: 0.04 }
""",
    "icon": """# {{TITLE}} — app icon in several sizes (reference: studio-image docs)
image:
  title: {{TITLE}}
  size: [512, 512]
  background: transparent

export:
  - { format: png }                                                  # exports/<name>.png (512)
  - { format: png, sizes: [16, 32, 48, 180, 192], name: "{name}-{size}" }
  - { format: ico, sizes: [16, 32, 48] }                             # favicon

layers:
  - { rect: [0, 0, 512, 512], radius: 112, fill: { gradient: ["#7c5cff", "#3b82f6"], angle: 60 } }
  - { circle: [256, 256, 150], fill: "#ffffff22" }
  - { path: "M 196 150 L 366 256 L 196 362 Z", fill: "#ffffff", shadow: { dy: 6, blur: 14, color: "#00000055" } }
""",
    "pixel": """# {{TITLE}} — pixel art (reference: studio-image docs)
image:
  title: {{TITLE}}
  size: [256, 256]
  background: transparent
  antialias: 1                  # crisp pixels

export:
  - { format: png }
  - { format: png, width: 48, smooth: false, name: "{name}-48" }      # small copy without blur

layers:
  - pixels: |                   # one character = one pixel; "." is transparent
      ....kkkk....
      ...kyyyyk...
      ..kyyyyyyk..
      .kyywyywyyk.
      .kyykyykyyk.
      .kyyyyyyyyk.
      .kyrryyrryk.
      .kyyrrrryyk.
      ..kyyyyyyk..
      ...kyyyyk...
      ....kkkk....
    palette: { k: "#1b1b1f", y: "#ffd23f", w: "#ffffff", r: "#e84855" }
    scale: 20                   # size of one pixel
""",
    "texture": """# {{TITLE}} — a seamless texture for games and 3D materials (reference: studio-image docs)
image:
  title: {{TITLE}}
  size: [512, 512]              # powers of two tile best

layers:
  - { texture: bricks, colors: ["#3a2a22", "#a0553b", "#c46a48"], width: 64, height: 32, mortar: 5 }
  - { texture: noise, scale: 40, colors: ["#000000", "#ffffff"], blend: overlay, opacity: 0.35 }
  - { texture: grain, colors: ["#000000", "#ffffff"], blend: soft_light, opacity: 0.25 }
""",
    "banner": """# {{TITLE}} — social / store banner (reference: studio-image docs)
image:
  title: {{TITLE}}
  size: [1200, 630]
  background: "#0f172a"

export:
  - { format: png }
  - { format: jpg, quality: 88 }

layers:
  - { texture: dots, spacing: 28, radius: 2.2, colors: ["#00000000", "#ffffff"], opacity: 0.12 }
  - { ellipse: [1040, 120, 320, 320], fill: "#6366f1", blur: 120, opacity: 0.7 }
  - { ellipse: [140, 560, 280, 280], fill: "#22d3ee", blur: 120, opacity: 0.45 }
  - { text: "{{TITLE}}", at: [80, 250], anchor: left, size: 84, font: bold, fill: "#ffffff", width: 1000 }
  - { text: "One sentence about it — replace me.", at: [84, 380], anchor: left, valign: top, size: 34, font: sans, fill: "#cbd5e1", width: 900 }
  - group:
      at: [84, 500]             # the children are placed relative to this point
      layers:
        - { rect: [0, 0, 250, 62], radius: 31, fill: "#ffffff" }
        - { text: "Learn more", at: [125, 31], size: 26, font: bold, fill: "#0f172a" }
""",
    "blank": """# {{TITLE}} — studio-image picture (reference: studio-image docs)
image:
  title: {{TITLE}}
  size: [1024, 1024]
  background: "#ffffff"

layers:
  - { text: "{{TITLE}}", size: 72, fill: "#111827" }
""",
}

PLUGINS = {
    "shape": '''"""{{NAME}} — a studio-image shape (loaded from plugins/image/).

Use it in a picture:   layers: [ { {{NAME}}: [400, 300, 120], fill: "#ffcc00", stroke: "#000", stroke_width: 6 } ]
"""
from studio_image.api import math, shape


@shape("{{NAME}}", params={"petals": 6}, doc="{{NAME}}: [cx, cy, r] — describe the shape in one line (shown by: studio-image list shapes)")
def {{NAME}}(c, p):
    # p["_value"]: what is written after "{{NAME}}:"  ·  p[...]: the parameters  ·  p["at"]: the layer's at (default: the middle)
    # c.poly(points) · c.rect(x, y, w, h, radius) · c.ellipse(cx, cy, rx, ry) · c.line(points, width) · c.arc(cx, cy, r, start, end, width)
    #   → painted with the layer's fill / stroke, so gradients, textures, shadows and blur just work
    # add fill="#rrggbb" (and stroke=, width=) to paint a part in its own color:  c.ellipse(cx, cy, 10, 10, fill="#fff")
    # c.text("…", x, y, size=40, font="bold", fill="#fff") · c.size = (width, height) of the picture
    cx, cy, r = [float(v) for v in p["_value"]]
    n = max(2, int(p["petals"]))
    for i in range(n):
        a = i * math.tau / n
        c.ellipse(cx + math.cos(a) * r * 0.55, cy + math.sin(a) * r * 0.55, r * 0.45, r * 0.45)
    c.ellipse(cx, cy, r * 0.3, r * 0.3, fill="#ffffff")
''',
    "filter": '''"""{{NAME}} — a studio-image filter (loaded from plugins/image/).

Use it:   filters: [ { {{NAME}}: 0.4 } ]        on the whole picture, or inside a layer:  { …, filters: [ {{NAME}} ] }
"""
from studio_image.api import Image, filter, np


@filter("{{NAME}}", params={"strength": 0.35, "gap": 3}, doc="Describe the filter in one line")
def {{NAME}}(img, p, k):
    # img: RGBA picture · p: parameters (the first one is the main one: {{NAME}}: 0.4) · k: pixels per document unit
    a = np.asarray(img).copy()
    step = max(2, int(round(float(p["gap"]) * k)))
    a[::step, :, :3] = (a[::step, :, :3] * (1 - float(p["strength"]))).astype("uint8")
    return Image.fromarray(a, "RGBA")
''',
    "texture": '''"""{{NAME}} — a studio-image texture (loaded from plugins/image/).

Use it:   layers: [ { texture: {{NAME}}, colors: ["#102040", "#80c0ff"], count: 8 } ]
          or as a fill:  { rect: [0, 0, 400, 300], fill: { texture: {{NAME}}, colors: ["#000", "#fff"] } }
"""
from studio_image.api import math, np, texture


@texture("{{NAME}}", params={"count": 8}, doc="Describe the texture in one line")
def {{NAME}}(w, h, p, rng):
    # return an array (h, w) with values 0 … 1 — the layer's `colors` turn them into color (dark → light);
    # or an array (h, w, 3 or 4) with 0 … 255 for your own colors. rng: numpy random generator (seeded).
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - w / 2, yy - h / 2) / max(w, h)
    return 0.5 + 0.5 * np.sin(d * float(p["count"]) * math.tau)
''',
}
