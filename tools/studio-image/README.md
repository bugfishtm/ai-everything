# studio-image — pictures from text

Pictures are YAML files (`*.image.yaml`): a size, a background and a stack of layers — shapes,
text, pictures, textures, pixel art — with fills, strokes, shadows, blend modes and filters.
`studio-image render` turns them into PNG / JPG / WebP / ICO (several sizes at once).

```bash
studio-image new src/cover.image.yaml              # starter (--template poster|icon|pixel|texture|banner|blank)
studio-image check src/cover.image.yaml            # validate fast: names, options, files, fonts
studio-image render src/cover.image.yaml --preview # → exports/cover.png (+ the export list) and .studio/previews/cover.png
studio-image render src/cover.image.yaml --scale 0.5    # half size while iterating
studio-image info assets/photo.jpg                 # size, transparency, brightness, main colors of ANY image
studio-image palette assets/photo.jpg --colors 6   # its main colors as hex (ready to paste as a palette)
studio-image convert assets/photo.jpg --to webp --width 800      # resize / convert (--pixel: no smoothing)
studio-image sheet exports/walk-*.png --cols 4     # pack pictures into one sprite sheet + atlas JSON
studio-image list shapes                           # catalogue: shapes, textures, filters, fonts, blends
studio-image plugin new petal --kind shape         # extend the tool (plugins/image/petal.py)
```

**Looking without guessing:** after every render read the preview PNG (transparent parts are
shown on a checkerboard, small pixel art is enlarged) and the report: brightness, contrast, main
colors, and warnings — text wider than the picture, a layer that draws nothing, no contrast.
Work in this order: `check` → `render --preview` → look → change.

## Picture file

```yaml
image:
  title: Night Drive
  size: [1280, 720]            # px (up to 8192); one number = a square
  background: "#101420"        # a color, transparent (default), or a paint: { gradient: [...] } / { texture: … } / { image: … }
  palette: { ink: "#0c0d11", accent: "#a78bfa" }     # names usable wherever a color goes
  antialias: 2                 # 1 = hard pixels (pixel art) … 4; default 2
  seed: 1                      # for textures and scatter

export:                        # optional; default: exports/<name>.png
  - { format: png }
  - { format: jpg, quality: 88, width: 1200 }
  - { format: png, sizes: [16, 32, 180, 512], name: "{name}-{size}" }      # icons
  - { format: ico, sizes: [16, 32, 48] }

layers:                        # bottom first
  - { rect: [0, 0, 1280, 720], fill: { gradient: ["#1b2140", "#0b0d18"], angle: 90 } }
  - { texture: stars, colors: ["#00000000", "#ffffff"], count: 300, opacity: 0.8 }
  - { circle: [980, 210, 150], fill: "#ffd166", glow: { radius: 60, color: "#ff9a5c" } }
  - { text: "NIGHT DRIVE", at: [90, 300], anchor: left, size: 110, font: bold, fill: "#ffffff", shadow: { dy: 8, blur: 18 } }
  - { image: assets/car.png, at: [900, 520], width: 380, rotate: -4 }

filters:                       # on the whole picture, in order
  - { vignette: 0.35 }
  - { grain: 0.04 }
```

Coordinates are pixels, `(0, 0)` is the top left corner, x to the right, y down. Angles are
degrees, clockwise.

### Layers

A layer is a mapping with exactly **one kind** plus options. Kinds:

| Kind | Written as | Its options |
|------|-----------|-------------|
| `rect` | `rect: [x, y, width, height]` | `radius` |
| `ellipse` / `circle` | `ellipse: [cx, cy, rx, ry]` · `circle: [cx, cy, r]` | |
| `polygon` | `polygon: [[x, y], [x, y], …]` | `smooth` |
| `ngon` / `star` / `burst` | `ngon: [cx, cy, r]` | `sides` · `points`, `inner` · `rays`; `rotation` |
| `line` | `line: [[x, y], [x, y], …]` | `smooth`, `closed`, `width` — painted with `stroke` |
| `arc` / `ring` / `pie` | `arc: [cx, cy, r, start, end]` · `ring: [cx, cy, r]` · `pie: [cx, cy, r, start, end]` | `width` |
| `arrow` / `cross` / `heart` / `cloud` | `arrow: [[x1, y1], [x2, y2]]` · `cross: [cx, cy, size]` · `heart: [cx, cy, size]` · `cloud: [cx, cy, width]` | `width`, `head` · `thickness`, `rotation` |
| `bubble` / `wave` | `bubble: [x, y, w, h]` · `wave: [x, y, w, h]` | `tail: [x, y]`, `radius` · `waves`, `amplitude`, `phase` |
| `path` | `path: "M 10 10 L 90 10 C … Z"` | SVG path data (M L H V C S Q T A Z); `at`, `scale`; overlapping outlines make holes |
| `text` | `text: "…"` | `at`, `size`, `font`, `anchor` (left·center·right), `valign` (top·middle·bottom·baseline), `width` (wrap), `align`, `line_height`, `spacing`, `box`, `upper` |
| `image` | `image: assets/x.png` | `at`, `anchor`, `width` / `height`, `fit` (cover·contain·stretch), `crop: [x, y, w, h]`, `smooth: false` (pixel art) — also a pack item `pack/item` or another `x.image.yaml` |
| `texture` | `texture: noise` | `colors: [dark, …, light]`, `area: [x, y, w, h]`, `seed` + the texture's parameters |
| `pixels` | `pixels: \|` + rows of characters | `palette: { char: color }`, `scale` (size of one pixel), `at`, `anchor`; a list of grids = frames side by side (`cols`, `gap`) |
| `fill` alone | `{ fill: "#123" }` | covers the whole picture |
| `group` | `group: { at: [x, y], layers: [ … ] }` | children are placed relative to `at`; effects apply to the group as one |
| `repeat` | `repeat: { count: [nx, ny], step: [dx, dy] }` + `layers` | a row (`count: 6, step: [40, 0]`) or a grid |
| `scatter` | `scatter: { count, area: [x, y, w, h], scale: [min, max], rotate: [min, max], opacity: [min, max], seed }` + `layers` | children drawn around `(0, 0)`, strewn at random |

Options every layer takes:

| Option | |
|--------|---|
| `fill` | a color (`"#rrggbb"`, `"#rrggbbaa"`, a name, a palette name), `none`, or a paint: `{ gradient: [c1, c2, …], angle: 90, kind: linear\|radial\|conic, stops: [0, 0.3, 1] }`, `{ texture: marble, colors: [...] }`, `{ image: assets/x.jpg, fit: cover }` — paints follow the shape (also text) |
| `stroke`, `stroke_width` | outline: `stroke: "#000", stroke_width: 6` or `stroke: { color: "#000", width: 6 }`; one line around the whole shape, also where its parts overlap |
| `opacity`, `blend` | 0 … 1 · normal, multiply, screen, overlay, add, darken, lighten, difference, soft_light, color_dodge, subtract |
| `rotate`, `origin`, `flip` | degrees clockwise around the middle of the layer (or `origin: [x, y]`) · `flip: x` / `y` |
| `shadow`, `glow`, `outline`, `blur` | `shadow: { dy: 8, dx: 0, blur: 12, color: "#00000099" }` · `glow: { radius: 16, color: … }` · `outline: { width: 4, color: … }` · `blur: 6` |
| `filters` | a list of filters for this layer only |
| `mask` | another layer: this one is only visible where the mask draws (`mask: { circle: [200, 200, 150] }`) |
| `name`, `hide`, `seed` | a label for messages · skip the layer · its own random seed |

A shape without `fill` and `stroke` is white. `at` moves a text / image / pixels / path layer;
shapes are placed by their own numbers.

### Textures

`noise` `clouds` `grain` `marble` `wood` `stripes` `checker` `dots` `grid` `bricks` `cells` `stars`
`waves` `rays` — `studio-image list textures` shows the parameters. A texture gives values from
0 to 1 that `colors` turn into color (two or more, dark → light; colors may be transparent).
Most tile seamlessly (`tile: true`) when the picture's size fits their pattern — use them for
game and 3D materials (`studio-image new x.image.yaml --template texture`).

### Filters

`blur` `sharpen` `brightness` `contrast` `saturation` `hue` `grayscale` `sepia` `duotone` `invert`
`tint` `opacity` `vignette` `grain` `pixelate` `posterize` `threshold` `outline` `shadow` `glow`
`round` `chroma` `flip` — written as `{ blur: 6 }` (the value is the filter's first parameter) or
`{ vignette: { amount: 0.5, size: 0.8 } }`. Sizes are document pixels.

### Fonts

`sans` `bold` `serif` `serif-bold` `mono` `mono-bold` `italic` `bold-italic` `serif-italic` `narrow`
`narrow-bold` `pixel` — or a `.ttf` / `.otf` file of the project (`font: assets/fonts/Bangers.ttf`)
or a pack item. Fonts are not downloaded: put the file into the project.

### Pixel art

```yaml
image: { size: [128, 128], background: transparent, antialias: 1 }
export:
  - { format: png }
  - { format: png, width: 32, smooth: false, name: "{name}-32" }
layers:
  - pixels: |
      ..kk..
      .kyyk.
      kywwyk
      .kyyk.
      ..kk..
    palette: { k: "#1b1b1f", y: "#ffd23f", w: "#ffffff" }     # "." and space are transparent
    scale: 16
```

Several grids in a list are frames of an animation, laid out side by side — a sprite sheet.
`studio-image sheet a.png b.png …` packs finished pictures into a sheet with an atlas JSON.

## Output

| Command | Files |
|---------|-------|
| `render` | every entry of `export` in `exports/` (default `<name>.png`); `--preview` adds `.studio/previews/<name>.png` |
| `convert`, `sheet` | `exports/…` (or `--out`) |
| `palette --preview` | swatches in `.studio/previews/` |

`--json` prints a report for programs: files with sizes, analysis (brightness, contrast,
transparency, colors), warnings.

## Extending the tool — plugins

A plugin is a Python file in `plugins/image/` of the project — loaded automatically by every
command. `studio-image plugin new <name> --kind shape|filter|texture` writes a working starter.

```python
from studio_image.api import Image, filter, math, np, shape, texture

@shape("petals", params={"count": 6}, doc="petals: [cx, cy, r]")
def petals(c, p):                         # c: canvas (document px), p: the layer's options
    cx, cy, r = [float(v) for v in p["_value"]]      # what is written after "petals:"
    for i in range(int(p["count"])):
        a = i * math.tau / int(p["count"])
        c.ellipse(cx + math.cos(a) * r * 0.55, cy + math.sin(a) * r * 0.55, r * 0.45, r * 0.45)
    c.ellipse(cx, cy, r * 0.3, r * 0.3, fill="#ffffff")   # fill= paints this part in its own color

@filter("scanlines", params={"strength": 0.35, "gap": 3})
def scanlines(img, p, k):                 # RGBA picture in and out; k = pixels per document unit
    a = np.asarray(img).copy()
    a[:: max(2, int(p["gap"] * k)), :, :3] = (a[:: max(2, int(p["gap"] * k)), :, :3] * (1 - p["strength"])).astype("uint8")
    return Image.fromarray(a, "RGBA")

@texture("rings", params={"count": 8})
def rings(w, h, p, rng):                  # → values 0 … 1 (h, w), colored by the layer's `colors`
    yy, xx = np.mgrid[0:h, 0:w]
    return 0.5 + 0.5 * np.sin(np.hypot(xx - w / 2, yy - h / 2) / max(w, h) * p["count"] * math.tau)
```

Canvas: `c.poly(points)` `c.rect(x, y, w, h, radius)` `c.ellipse(cx, cy, rx, ry)` `c.line(points, width)`
`c.arc(cx, cy, r, start, end, width)` `c.paths([points, …])` — painted with the layer's fill and
stroke, so gradients, textures, shadows, masks and blend modes work for plugin shapes too.
`c.text("…", x, y, size=40, font="bold", fill="#fff")` draws text; `c.size` is the picture's size.

A plugin with a mistake does not break other pictures: `check` and `list` report the error with
the file name. To share plugins, put them in a pack (item kind `plugin`, `meta.target:
studio-image`) and list the pack under `use:`.

## Tips for good pictures

- **One idea, one focus.** Decide what is looked at first; make it the biggest and brightest thing.
- **Three or four colors** from one palette (`palette:`), plus black/white. Check the report:
  contrast below 0.1 means the picture is flat.
- **Depth in three layers:** background (gradient + texture at low opacity), middle (shapes, picture),
  front (text). Soft glows (`blur` on a colored ellipse) and a `vignette` hold it together.
- **Text:** at most two fonts; big titles in `bold`, small text in `sans`; keep it inside a margin
  of 5 % of the picture; set `width:` so long lines wrap; use `shadow` or `box` on busy backgrounds.
- **Icons** are read at 32 px: one simple shape, strong contrast, no thin lines.
- **Game art:** `antialias: 1` and `smooth: false` for pixel art; powers of two for textures.
