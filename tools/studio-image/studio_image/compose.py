"""Picture files (*.image.yaml): load, validate, render layer by layer.

A picture is a stack of layers (bottom first). Every layer is drawn on its own transparent
sheet, gets its effects (mask, rotation, filters, shadow …) and is laid over the result with
its blend mode and opacity. Shapes are drawn at `antialias` times the size and scaled down.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageChops, ImageDraw

from . import registry
from .registry import suggest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
import studio_gfx as gfx  # noqa: E402
from studio_gfx import GfxError  # noqa: E402


class ImageError(Exception):
    pass


MAX_SIDE = 8192
BUILTIN_KINDS = ["text", "image", "texture", "pixels", "group", "repeat", "scatter"]
COMMON = {"name", "fill", "stroke", "stroke_width", "opacity", "blend", "rotate", "origin", "blur", "shadow", "glow", "outline",
          "filters", "mask", "at", "hide", "flip", "seed"}
KIND_OPTIONS = {
    "text": {"size", "font", "anchor", "valign", "align", "width", "line_height", "spacing", "box", "upper"},
    "image": {"width", "height", "fit", "crop", "anchor", "smooth"},
    "texture": {"area", "colors"},
    "pixels": {"palette", "scale", "anchor", "cols", "gap"},
    "group": {"layers"},
    "repeat": {"layers"},
    "scatter": {"layers"},
}


# ---------------------------------------------------------------------------
# Canvas: what shapes draw on
# ---------------------------------------------------------------------------
class Canvas:
    """Coordinates are document pixels. Calls without fill= / stroke= collect the shape that the
    layer's fill and stroke paint; with them the part is painted directly in that color."""

    def __init__(self, doc: "Doc", k: float, stroke_width: float, offset: tuple[float, float] = (0.0, 0.0), px: tuple[int, int] | None = None):
        self.doc = doc
        self.size = (doc.w, doc.h)
        self.k = k
        self.px = px or (max(1, int(round(doc.w * k))), max(1, int(round(doc.h * k))))
        self.fill = Image.new("L", self.px, 0)
        self.stroke = Image.new("L", self.px, 0)
        self._fd = ImageDraw.Draw(self.fill)
        self._sd = ImageDraw.Draw(self.stroke)
        self.direct: Image.Image | None = None
        self._dd: ImageDraw.ImageDraw | None = None
        self.width = float(stroke_width)
        self.ox, self.oy = offset

    # -- helpers ----------------------------------------------------------------
    def _p(self, pt) -> tuple[float, float]:
        return ((float(pt[0]) + self.ox) * self.k, (float(pt[1]) + self.oy) * self.k)

    def _w(self, width) -> int:
        return max(1, int(round(float(self.width if width is None else width) * self.k)))

    def _direct(self) -> ImageDraw.ImageDraw:
        if self.direct is None:
            self.direct = Image.new("RGBA", self.px, (0, 0, 0, 0))
            self._dd = ImageDraw.Draw(self.direct)
        return self._dd  # type: ignore[return-value]

    def _col(self, c):
        return gfx.color(c, self.doc.palette)

    def _stroke_path(self, d: ImageDraw.ImageDraw, pts: list, fill, w: int, closed: bool) -> None:
        if len(pts) < 2:
            return
        d.line(pts + (pts[:2] if closed else []), fill=fill, width=w, joint="curve")
        if not closed and w > 2:  # round ends
            for x, y in (pts[0], pts[-1]):
                d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=fill)

    # -- shapes -----------------------------------------------------------------
    def poly(self, points, fill=None, stroke=None, width=None) -> None:
        pts = [self._p(p) for p in points]
        if len(pts) < 3:
            return
        if fill is None and stroke is None:
            self._fd.polygon(pts, fill=255)
            return
        d = self._direct()
        if fill is not None:
            d.polygon(pts, fill=self._col(fill))
        if stroke is not None:
            self._stroke_path(d, pts, self._col(stroke), self._w(width if width is not None else (self.width or 3)), True)

    def paths(self, shapes: list) -> None:
        """Several closed outlines as one shape: where they overlap there is a hole (even-odd), like in SVG."""
        m = Image.new("L", self.px, 0)
        for points in shapes:
            pts = [self._p(p) for p in points]
            if len(pts) < 3:
                continue
            t = Image.new("L", self.px, 0)
            ImageDraw.Draw(t).polygon(pts, fill=255)
            m = ImageChops.difference(m, t)
        self.fill = ImageChops.lighter(self.fill, m)
        self._fd = ImageDraw.Draw(self.fill)

    def rect(self, x, y, w, h, radius=0, fill=None, stroke=None, width=None) -> None:
        (x0, y0), (x1, y1) = self._p((x, y)), self._p((x + w, y + h))
        box = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        r = max(0.0, float(radius)) * self.k
        if fill is None and stroke is None:
            self._fd.rounded_rectangle(box, radius=r, fill=255)
            return
        d = self._direct()
        sw = self._w(width if width is not None else (self.width or 3)) if stroke is not None else 0
        d.rounded_rectangle(box, radius=r, fill=self._col(fill) if fill is not None else None, outline=self._col(stroke) if stroke is not None else None, width=sw)

    def ellipse(self, cx, cy, rx, ry=None, fill=None, stroke=None, width=None) -> None:
        ry = rx if ry is None else ry
        (x0, y0), (x1, y1) = self._p((cx - rx, cy - ry)), self._p((cx + rx, cy + ry))
        box = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        if fill is None and stroke is None:
            self._fd.ellipse(box, fill=255)
            return
        d = self._direct()
        sw = self._w(width if width is not None else (self.width or 3)) if stroke is not None else 0
        d.ellipse(box, fill=self._col(fill) if fill is not None else None, outline=self._col(stroke) if stroke is not None else None, width=sw)

    def line(self, points, width=None, closed=False, stroke=None) -> None:
        pts = [self._p(p) for p in points]
        w = self._w(width if width is not None else (self.width or 4))
        if stroke is None:
            self._stroke_path(self._sd, pts, 255, w, closed)
        else:
            self._stroke_path(self._direct(), pts, self._col(stroke), w, closed)

    def arc(self, cx, cy, r, start, end, width=None, stroke=None) -> None:
        n = max(8, int(abs(end - start) / 4))
        pts = [(cx + r * math.cos(math.radians(start + (end - start) * i / n)), cy + r * math.sin(math.radians(start + (end - start) * i / n))) for i in range(n + 1)]
        self.line(pts, width, False, stroke)

    def text(self, s, x, y, size=40, font="bold", fill="#ffffff", anchor="center", valign="middle", **kw) -> None:
        self._direct()
        f = self.doc.font(font, float(size) * self.k)
        gfx.draw_text(self.direct, str(s), self._p((x, y)), f, self._col(fill), anchor=anchor, valign=valign, **kw)  # type: ignore[arg-type]


class _Probe:
    """A canvas that draws nothing: `check` runs every shape on it to find wrong values without rendering."""

    def __init__(self, doc: "Doc"):
        self.doc, self.size, self.k, self.width = doc, (doc.w, doc.h), 1.0, 0.0

    def __getattr__(self, name):
        return lambda *a, **kw: None


# ---------------------------------------------------------------------------
# Document
# ---------------------------------------------------------------------------
def _num(v, where: str, lo: float | None = None, hi: float | None = None) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ImageError(f'{where}: expected a number, got "{v}"') from None
    if (lo is not None and f < lo) or (hi is not None and f > hi):
        raise ImageError(f"{where}: must be between {lo} and {hi}, got {v}")
    return f


def _pair(v, where: str) -> tuple[float, float]:
    if not (isinstance(v, (list, tuple)) and len(v) == 2):
        raise ImageError(f"{where}: expected [x, y], got {v!r}")
    return _num(v[0], where), _num(v[1], where)


def _list(v, n: int, where: str) -> list[float]:
    if not (isinstance(v, (list, tuple)) and len(v) == n):
        raise ImageError(f"{where}: expected {n} numbers, got {v!r}")
    return [_num(x, where) for x in v]


class Doc:
    def __init__(self, data: dict, path: Path, depth: int = 0):
        self.path = Path(path)
        self.base = registry.project_dir()
        self.depth = depth
        self.warnings: list[str] = []
        unknown = set(data) - {"image", "layers", "filters", "export", "use"}
        if unknown:
            self.warnings.append(f"ignored top-level keys: {', '.join(sorted(map(str, unknown)))} (known: image layers filters export use)")
        registry.load_builtins()
        for pack_id in data.get("use") or []:
            try:
                registry.load_pack(str(pack_id))
            except ImportError as e:
                raise ImageError(f"use: {e}") from None
        registry.load_project_plugins()
        for err in registry.PLUGIN_ERRORS:
            self.warnings.append(f'plugin {err["file"]} failed to load: {err["error"]}')

        im = data.get("image") or {}
        if not isinstance(im, dict):
            raise ImageError("image: must be a mapping (title, size, background …)")
        bad = set(im) - {"title", "size", "background", "antialias", "palette", "seed"}
        if bad:
            raise ImageError(f'image: unknown option "{sorted(bad)[0]}"{suggest(sorted(bad)[0], ["title", "size", "background", "antialias", "palette", "seed"])}')
        self.title = str(im.get("title") or self.path.name.split(".")[0])
        size = im.get("size", [1024, 1024])
        if isinstance(size, (int, float)):
            size = [size, size]
        w, h = _pair(size, "image.size")
        if not (1 <= w <= MAX_SIDE and 1 <= h <= MAX_SIDE):
            raise ImageError(f"image.size: width and height must be between 1 and {MAX_SIDE}")
        self.w, self.h = int(w), int(h)
        self.palette = {str(k): v for k, v in (im.get("palette") or {}).items()}
        for k, v in self.palette.items():
            self._color(v, f"image.palette.{k}", use_palette=False)
        self.seed = int(im.get("seed", 1))
        aa = im.get("antialias")
        self.aa = int(_num(aa, "image.antialias", 1, 4)) if aa is not None else (2 if self.w * self.h <= 4_500_000 else 1)
        self.background = im.get("background", "transparent")
        self._check_paint(self.background, "image.background")
        layers = data.get("layers") or []
        if not isinstance(layers, list):
            raise ImageError("layers: must be a list (bottom layer first)")
        self.layers = [self._check_layer(l, f"layers[{i}]") for i, l in enumerate(layers)]
        self.filters = self._check_filters(data.get("filters"), "filters")
        self.exports = self._check_exports(data.get("export"))
        self.count = self._count(self.layers)

    # -- validation ---------------------------------------------------------------
    def _color(self, c, where: str, use_palette: bool = True):
        try:
            return gfx.color(c, self.palette if use_palette else None)
        except GfxError as e:
            raise ImageError(f"{where}: {e}") from None

    def font(self, name, size: float):
        try:
            return gfx.font(name, size, self.base, registry.pack_file)
        except GfxError as e:
            raise ImageError(str(e)) from None

    def file(self, ref, where: str) -> Path:
        """A file of the project, or a pack item (pack/item)."""
        s = str(ref)
        p = (self.base / s) if not Path(s).is_absolute() else Path(s)
        if p.is_file():
            return p
        rel = self.path.parent / s
        if rel.is_file():
            return rel
        if "/" in s and not s.startswith((".", "/")):
            packed = registry.pack_file(s)
            if packed and Path(packed).is_file():
                return Path(packed)
        raise ImageError(f"{where}: file not found: {s} (paths are relative to the project folder; pack items as pack-id/item-id)")

    def _check_paint(self, spec, where: str) -> None:
        if spec is None or spec is False or isinstance(spec, str) or isinstance(spec, (list, tuple)):
            if spec not in (None, False, "none"):
                self._color(spec, where)
            return
        if not isinstance(spec, dict):
            raise ImageError(f"{where}: expected a color or a mapping (gradient / texture / image)")
        kinds = [k for k in ("gradient", "texture", "image") if k in spec]
        if len(kinds) != 1:
            raise ImageError(f"{where}: use a color, or one of: gradient: [colors], texture: name, image: file")
        if "gradient" in spec:
            cols = spec["gradient"]
            if not isinstance(cols, list) or len(cols) < 2:
                raise ImageError(f"{where}.gradient: give at least two colors, e.g. [\"#1b2140\", \"#0b0d18\"]")
            for i, c in enumerate(cols):
                self._color(c, f"{where}.gradient[{i}]")
            bad = set(spec) - {"gradient", "angle", "kind", "stops", "center"}
            if bad:
                raise ImageError(f'{where}: a gradient has no option "{sorted(bad)[0]}" (options: angle, kind, stops, center)')
            if str(spec.get("kind", "linear")) not in ("linear", "radial", "conic"):
                raise ImageError(f"{where}.kind: linear, radial or conic")
        elif "texture" in spec:
            self._texture_params(spec, where)
        else:
            self.file(spec["image"], f"{where}.image")

    def _texture_params(self, spec: dict, where: str) -> tuple[registry.Entry, dict, list]:
        name = str(spec["texture"])
        e = registry.TEXTURES.get(name)
        if not e:
            raise ImageError(f'{where}: unknown texture "{name}"{suggest(name, registry.TEXTURES)} (studio-image list textures)')
        skip = {"texture", "colors", "seed", "area", "fit"} | COMMON
        params = dict(e.params)
        for k, v in spec.items():
            if k in skip or str(k).startswith("_"):
                continue
            if k not in e.params:
                raise ImageError(f'{where}: texture "{name}" has no parameter "{k}" (has: {", ".join(e.params) or "none"})')
            params[k] = v
        cols = spec.get("colors", ["#000000", "#ffffff"])
        if not isinstance(cols, list) or len(cols) < 2:
            raise ImageError(f"{where}.colors: give at least two colors (dark → light)")
        return e, params, [self._color(c, f"{where}.colors") for c in cols]

    def _check_filters(self, spec, where: str) -> list[tuple[registry.Entry, dict]]:
        out = []
        if spec is None:
            return out
        items = spec if isinstance(spec, list) else [spec]
        for i, it in enumerate(items):
            w = f"{where}[{i}]"
            if isinstance(it, str):
                name, val = it, None
            elif isinstance(it, dict) and len(it) == 1:
                name, val = next(iter(it.items()))
            elif isinstance(it, dict) and "use" in it:
                name, val = it["use"], {k: v for k, v in it.items() if k != "use"}
            else:
                raise ImageError(f"{w}: write a filter as  blur: 6  or  {{ vignette: {{ amount: 0.5 }} }}")
            e = registry.FILTERS.get(str(name))
            if not e:
                raise ImageError(f'{w}: unknown filter "{name}"{suggest(name, registry.FILTERS)} (studio-image list filters)')
            params = dict(e.params)
            if isinstance(val, dict):
                for k, v in val.items():
                    if k not in e.params:
                        raise ImageError(f'{w}: filter "{name}" has no parameter "{k}" (has: {", ".join(e.params) or "none"})')
                    params[k] = v
            elif val is not None and val is not True and e.params:
                params[next(iter(e.params))] = val
            out.append((e, params))
        return out

    def _kind(self, layer: dict, where: str) -> str:
        kinds = [k for k in layer if k in BUILTIN_KINDS or k in registry.SHAPES]
        if "shape" in layer:
            name = str(layer["shape"])
            if name not in registry.SHAPES:
                raise ImageError(f'{where}: unknown shape "{name}"{suggest(name, registry.SHAPES)} (studio-image list shapes)')
            return name
        if not kinds:
            if "fill" in layer:
                return "fill"
            first = next((k for k in layer if k not in COMMON), None)
            raise ImageError(f'{where}: no layer kind — ' + (f'unknown "{first}"{suggest(first, [*BUILTIN_KINDS, *registry.SHAPES])} ' if first else "") +
                             f'(kinds: {", ".join([*registry.SHAPES, *BUILTIN_KINDS])})')
        if len(kinds) > 1:
            raise ImageError(f"{where}: one layer, one kind — found {', '.join(kinds)} (use a group to combine)")
        return kinds[0]

    def _check_layer(self, layer, where: str) -> dict:
        if not isinstance(layer, dict):
            raise ImageError(f"{where}: a layer must be a mapping like {{ rect: [0, 0, 100, 50], fill: \"#f00\" }}")
        layer = dict(layer)
        if isinstance(layer.get("group"), dict):      # "- group: { at: …, layers: [ … ] }" reads better in block style
            inner = layer.pop("group")
            layer = {"group": True, **inner, **layer}
        kind = self._kind(layer, where)
        label = f'{where} ({layer.get("name") or kind})'
        allowed = set(COMMON) | {kind, "shape"} | KIND_OPTIONS.get(kind, set())
        entry = registry.SHAPES.get(kind)
        if entry:
            allowed |= set(entry.params)
        if kind == "texture":
            allowed |= set(registry.TEXTURES[str(layer["texture"])].params) if str(layer.get("texture")) in registry.TEXTURES else set()
        for k in layer:
            if k not in allowed:
                raise ImageError(f'{label}: unknown option "{k}"{suggest(k, allowed)}')
        for key in ("fill", "stroke"):
            if key in layer:
                v = layer[key]
                if key == "stroke" and isinstance(v, dict) and "color" in v:      # stroke: { color, width }
                    bad = set(v) - {"color", "width"}
                    if bad:
                        raise ImageError(f'{label}.stroke: unknown option "{sorted(bad)[0]}" (write stroke: {{ color: "#000", width: 4 }})')
                    self._check_paint(v["color"], f"{label}.stroke.color")
                    if "width" in v:
                        _num(v["width"], f"{label}.stroke.width", 0, 2000)
                else:
                    self._check_paint(v, f"{label}.{key}")
        if "opacity" in layer:
            _num(layer["opacity"], f"{label}.opacity", 0, 1)
        if "blend" in layer and str(layer["blend"]) not in gfx.BLENDS:
            raise ImageError(f'{label}.blend: unknown mode "{layer["blend"]}"{suggest(layer["blend"], gfx.BLENDS)} (one of: {", ".join(gfx.BLENDS)})')
        for key in ("rotate", "blur", "stroke_width"):
            if key in layer:
                _num(layer[key], f"{label}.{key}")
        for key in ("at", "origin"):
            if key in layer:
                _pair(layer[key], f"{label}.{key}")
        layer["_filters"] = self._check_filters(layer.get("filters"), f"{label}.filters")
        for key in ("shadow", "glow", "outline"):
            if key in layer and layer[key] not in (None, False):
                v = layer[key]
                layer[f"_{key}"] = self._check_filters([{key: v if isinstance(v, dict) else ({} if v is True else v)}], f"{label}.{key}")[0]
        if "mask" in layer:
            layer["_mask"] = self._check_layer(layer["mask"], f"{label}.mask")
        if kind in ("group", "repeat", "scatter"):
            subs = layer.get("layers") if kind != "group" or not isinstance(layer.get("group"), list) else layer["group"]
            if not isinstance(subs, list) or not subs:
                raise ImageError(f"{label}: needs layers: [ … ]")
            layer["_layers"] = [self._check_layer(l, f"{label}.layers[{i}]") for i, l in enumerate(subs)]
            if kind == "repeat":
                r = layer["repeat"] if isinstance(layer["repeat"], dict) else {"count": layer["repeat"]}
                bad = set(r) - {"count", "step"}
                if bad:
                    raise ImageError(f'{label}.repeat: unknown option "{sorted(bad)[0]}" (options: count, step)')
                c = r.get("count", 2)
                layer["_count"] = [int(_num(x, f"{label}.repeat.count", 1, 500)) for x in (c if isinstance(c, list) else [c, 1])]
                layer["_step"] = _pair(r.get("step", [100, 100] if isinstance(c, list) else [100, 0]), f"{label}.repeat.step")
                if layer["_count"][0] * layer["_count"][1] > 4000:
                    raise ImageError(f"{label}.repeat: more than 4000 copies")
            if kind == "scatter":
                s = layer["scatter"] if isinstance(layer["scatter"], dict) else {"count": layer["scatter"]}
                bad = set(s) - {"count", "area", "seed", "scale", "rotate", "opacity"}
                if bad:
                    raise ImageError(f'{label}.scatter: unknown option "{sorted(bad)[0]}" (options: count, area, seed, scale, rotate, opacity)')
                layer["_scatter"] = {
                    "count": int(_num(s.get("count", 20), f"{label}.scatter.count", 1, 5000)),
                    "area": _list(s.get("area", [0, 0, self.w, self.h]), 4, f"{label}.scatter.area"),
                    "seed": int(s.get("seed", self.seed)),
                    "scale": _range(s.get("scale", 1), f"{label}.scatter.scale"),
                    "rotate": _range(s.get("rotate", 0), f"{label}.scatter.rotate"),
                    "opacity": _range(s.get("opacity", 1), f"{label}.scatter.opacity"),
                }
        elif kind == "text":
            self.font(layer.get("font", "bold"), 20)
            if layer.get("box") not in (None, False, True) and not isinstance(layer["box"], dict):
                self._color(layer["box"], f"{label}.box")
        elif kind == "image":
            src = str(layer["image"])
            p = self.file(src, f"{label}.image")
            if p.suffix.lower() == ".svg":
                raise ImageError(f"{label}.image: SVG files cannot be placed directly — draw the shape with path: \"M …\" or use a PNG")
            if p.name.endswith((".image.yaml", ".image.yml")):
                if self.depth >= 4 or p.resolve() == self.path.resolve():
                    raise ImageError(f"{label}.image: pictures include each other in a circle")
            if str(layer.get("fit", "contain")) not in ("cover", "contain", "stretch"):
                raise ImageError(f"{label}.fit: cover, contain or stretch")
        elif kind == "texture":
            self._texture_params(layer, label)
        elif kind == "pixels":
            layer["_grids"] = self._grids(layer, label)
        elif entry is not None:
            # run the shape once on a canvas that draws nothing: wrong values show up at check time
            params = {**entry.params, **{key: v for key, v in layer.items() if not key.startswith("_")}}
            params.update({"_value": layer.get(kind), "_at_given": "at" in layer, "_rng": np.random.default_rng(self.seed)})
            params.setdefault("at", [self.w / 2, self.h / 2])
            try:
                entry.fn(_Probe(self), params)
            except ValueError as ex:
                raise ImageError(f"{label}: {ex}") from None
            except Exception as ex:  # noqa: BLE001
                raise ImageError(f'{label}: shape "{kind}" failed: {type(ex).__name__}: {ex}') from None
        layer["_kind"] = kind
        layer["_label"] = label
        return layer

    def _grids(self, layer: dict, label: str) -> list[list[str]]:
        raw = layer["pixels"]
        blocks = raw if isinstance(raw, list) else [raw]
        pal = {str(k): v for k, v in (layer.get("palette") or {}).items()}
        for k, v in pal.items():
            self._color(v, f"{label}.palette.{k}")
        grids = []
        for bi, b in enumerate(blocks):
            rows = [r for r in str(b).split("\n") if r.strip() != ""]
            if not rows:
                raise ImageError(f"{label}.pixels[{bi}]: empty grid")
            width = max(len(r) for r in rows)
            rows = [r.ljust(width, ".") for r in rows]
            for r in rows:
                for ch in r:
                    if ch in ". " or ch in pal or ch in self.palette:
                        continue
                    raise ImageError(f'{label}.pixels: character "{ch}" has no color — add it to palette: {{ "{ch}": "#rrggbb" }} ("." and space are transparent)')
            grids.append(rows)
        return grids

    def _check_exports(self, spec) -> list[dict]:
        if spec is None:
            return [{"format": "png"}]
        items = spec if isinstance(spec, list) else [spec]
        out = []
        for i, e in enumerate(items):
            where = f"export[{i}]"
            if isinstance(e, str):
                e = {"format": e}
            if not isinstance(e, dict):
                raise ImageError(f"{where}: write an export as  {{ format: png }}  or  {{ format: jpg, quality: 90, width: 1200 }}")
            bad = set(e) - {"format", "name", "quality", "size", "width", "height", "scale", "sizes", "background", "smooth"}
            if bad:
                raise ImageError(f'{where}: unknown option "{sorted(bad)[0]}" (options: format, name, quality, size, width, height, scale, sizes, background, smooth)')
            fmt = str(e.get("format", "png")).lower().lstrip(".")
            fmt = "jpg" if fmt == "jpeg" else fmt
            if fmt not in ("png", "jpg", "webp", "ico", "gif", "bmp"):
                raise ImageError(f'{where}.format: "{fmt}" — one of png, jpg, webp, ico, gif, bmp')
            if "background" in e:
                self._color(e["background"], f"{where}.background")
            if "sizes" in e and not (isinstance(e["sizes"], list) and e["sizes"]):
                raise ImageError(f"{where}.sizes: a list like [16, 32, 180, 512]")
            out.append({**e, "format": fmt})
        return out

    def _count(self, layers: list) -> int:
        return sum(1 + self._count(l.get("_layers", [])) for l in layers)

    # -- painting -----------------------------------------------------------------
    def _paint(self, spec, size: tuple[int, int], k: float, seed: int) -> Image.Image | None:
        """A fill (color, gradient, texture, picture) as an RGBA image of `size` pixels."""
        if spec in (None, False, "none"):
            return None
        if not isinstance(spec, dict):
            c = self._color(spec, "fill")
            return Image.new("RGBA", size, c) if c[3] > 0 else None
        if "gradient" in spec:
            c = spec.get("center", [0.5, 0.5])
            return gfx.gradient(size, spec["gradient"], float(spec.get("angle", 90)), str(spec.get("kind", "linear")), spec.get("stops"), (float(c[0]), float(c[1])), self.palette)
        if "texture" in spec:
            return self._texture(spec, size, k, seed, "fill")
        src = self._open(self.file(spec["image"], "fill.image"))
        return gfx.fit(src, size, str(spec.get("fit", "cover")))

    def _texture(self, spec: dict, size: tuple[int, int], k: float, seed: int, where: str) -> Image.Image:
        e, params, cols = self._texture_params(spec, where)
        w, h = max(1, int(round(size[0] / k))), max(1, int(round(size[1] / k)))
        rng = np.random.default_rng(int(spec.get("seed", seed)))
        try:
            v = np.asarray(e.fn(w, h, params, rng))
        except Exception as ex:  # noqa: BLE001
            raise ImageError(f'{where}: texture "{e.name}" failed: {type(ex).__name__}: {ex}') from None
        if v.ndim == 2:
            v = np.clip(v.astype(np.float32), 0, 1)
            pos = np.linspace(0, 1, len(cols))
            arr = np.stack([np.interp(v, pos, [c[ch] for c in cols]) for ch in range(4)], axis=-1)
        elif v.ndim == 3 and v.shape[2] in (3, 4):
            arr = v.astype(np.float32) * (255.0 if v.max() <= 1.0 else 1.0)
            if arr.shape[2] == 3:
                arr = np.concatenate([arr, np.full(arr.shape[:2] + (1,), 255.0, dtype=np.float32)], axis=-1)
        else:
            raise ImageError(f'{where}: texture "{e.name}" returned an array of shape {v.shape} — expected (h, w) or (h, w, 3|4)')
        img = Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8), "RGBA")
        return img if img.size == size else img.resize(size, Image.BICUBIC if k >= 1 else Image.LANCZOS)

    def _open(self, p: Path) -> Image.Image:
        if p.name.endswith((".image.yaml", ".image.yml")):
            return load_doc(p, self.depth + 1).render()
        try:
            im = Image.open(p)
            im.load()
        except Exception as e:  # noqa: BLE001
            raise ImageError(f"cannot read the picture {p.name}: {e}") from None
        return im.convert("RGBA")

    # -- rendering ----------------------------------------------------------------
    def render(self, scale: float = 1.0) -> Image.Image:
        k = self.aa * scale
        px = (max(1, int(round(self.w * k))), max(1, int(round(self.h * k))))
        base = self._paint(self.background, px, k, self.seed) or Image.new("RGBA", px, (0, 0, 0, 0))
        self._empty: list[str] = []
        out = self._stack(self.layers, base, k, (0.0, 0.0), self.seed)
        for e, params in self.filters:
            out = self._filter(e, params, out, k, "filters")
        final = (max(1, int(round(self.w * scale))), max(1, int(round(self.h * scale))))
        if out.size != final:
            out = out.reduce(self.aa) if (self.aa > 1 and out.size == (final[0] * self.aa, final[1] * self.aa)) else out.resize(final, Image.LANCZOS)
        for label in self._empty[:8]:
            self.warnings.append(f"{label}: draws nothing — it is empty or outside the picture ({self.w}×{self.h})")
        return out

    def _filter(self, e: registry.Entry, params: dict, img: Image.Image, k: float, where: str) -> Image.Image:
        try:
            out = e.fn(img, params, k)
        except ImageError:
            raise
        except GfxError as ex:
            raise ImageError(f'{where}: filter "{e.name}": {ex}') from None
        except Exception as ex:  # noqa: BLE001
            raise ImageError(f'{where}: filter "{e.name}" failed: {type(ex).__name__}: {ex}') from None
        if not isinstance(out, Image.Image) or out.size != img.size:
            raise ImageError(f'{where}: filter "{e.name}" must return a picture of the same size')
        return out.convert("RGBA")

    def _stack(self, layers: list[dict], base: Image.Image, k: float, off: tuple[float, float], seed: int) -> Image.Image:
        out = base
        for i, layer in enumerate(layers):
            if layer.get("hide"):
                continue
            img = self._layer(layer, base.size, k, off, seed + i * 101)
            if img is None:
                continue
            out = gfx.blend(out, img, str(layer.get("blend", "normal")), float(layer.get("opacity", 1.0)))
        return out

    def _layer(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float], seed: int) -> Image.Image | None:
        kind, label = layer["_kind"], layer["_label"]
        seed = int(layer.get("seed", seed))
        # blur, glow and shadow need room: draw on a larger sheet so the picture's edge does not cut them
        full = px
        P = int(math.ceil(min(600.0, self._room(layer)) * k))
        if P:
            px = (px[0] + 2 * P, px[1] + 2 * P)
            off = (off[0] + P / k, off[1] + P / k)
        if kind == "group":
            o = _pair(layer["at"], label) if "at" in layer else (0.0, 0.0)
            img = self._stack(layer["_layers"], Image.new("RGBA", px, (0, 0, 0, 0)), k, (off[0] + o[0], off[1] + o[1]), seed)
        elif kind == "repeat":
            img = self._repeat(layer, px, k, off, seed)
        elif kind == "scatter":
            img = self._scatter(layer, px, k, off, seed)
        elif kind == "text":
            img = self._text(layer, px, k, off)
        elif kind == "image":
            img = self._image(layer, px, k, off)
        elif kind == "texture":
            img = self._texture_layer(layer, px, k, off, seed)
        elif kind == "pixels":
            img = self._pixels(layer, px, k, off)
        else:
            img = self._shape(layer, px, k, off, seed)
        if img is None:
            return None
        bbox = img.getchannel("A").getbbox()
        if bbox is None:
            self._empty.append(label)
            return None
        if "_mask" in layer:
            m = self._layer(layer["_mask"], px, k, off, seed + 7)
            alpha = m.getchannel("A") if m is not None else Image.new("L", px, 0)
            img.putalpha(ImageChops.multiply(img.getchannel("A"), alpha))
        if layer.get("flip"):
            ax = str(layer["flip"]).lower()
            cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
            if ax in ("x", "true", "h", "horizontal"):
                img = gfx.shifted(img.transpose(Image.FLIP_LEFT_RIGHT), 2 * cx - px[0], 0)
            else:
                img = gfx.shifted(img.transpose(Image.FLIP_TOP_BOTTOM), 0, 2 * cy - px[1])
        if layer.get("rotate"):
            if "origin" in layer:
                o = _pair(layer["origin"], label)
                center = ((o[0] + off[0]) * k, (o[1] + off[1]) * k)
            else:
                center = ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
            img = img.rotate(-float(layer["rotate"]), resample=Image.BICUBIC, center=center)
        for e, params in layer["_filters"]:
            img = self._filter(e, params, img, k, f"{label}.filters")
        for key in ("_outline", "_glow", "_shadow"):
            if key in layer:
                e, params = layer[key]
                img = self._filter(e, params, img, k, f"{label}.{key[1:]}")
        if layer.get("blur"):
            img = self._filter(registry.FILTERS["blur"], {"radius": float(layer["blur"])}, img, k, f"{label}.blur")
        if P:
            img = img.crop((P, P, P + full[0], P + full[1]))
            if img.getchannel("A").getbbox() is None:
                self._empty.append(label)
                return None
        return img

    @staticmethod
    def _room(layer: dict) -> float:
        """How far (document px) the effects of a layer reach beyond what is drawn."""
        r = 3.0 * float(layer.get("blur") or 0)
        for key in ("_shadow", "_glow", "_outline"):
            if key in layer:
                p = layer[key][1]
                r = max(r, 3.0 * float(p.get("blur", p.get("radius", 0)) or 0) + abs(float(p.get("dx", 0))) + abs(float(p.get("dy", 0))) + float(p.get("width", 0) or 0))
        for e, p in layer.get("_filters", []):
            if e.name in ("blur", "glow", "shadow", "outline"):
                r = max(r, 3.0 * float(p.get("blur", p.get("radius", 0)) or 0) + float(p.get("width", 0) or 0) + abs(float(p.get("dy", 0) or 0)))
        return r

    def _shape(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float], seed: int) -> Image.Image | None:
        kind, label = layer["_kind"], layer["_label"]
        stroke_spec = layer.get("stroke")
        sw = float(layer.get("stroke_width", 0))
        if isinstance(stroke_spec, dict) and "color" in stroke_spec:   # stroke: { color, width }
            sw = float(stroke_spec.get("width", sw or 3))
            stroke_spec = stroke_spec["color"]
        elif stroke_spec not in (None, False, "none") and not sw:
            sw = 3.0
        if stroke_spec in (None, False, "none"):
            sw = 0.0
        if kind == "fill":
            c = Canvas(self, k, 0.0, off, px)
            c.rect(0, 0, self.w, self.h)
        else:
            e = registry.SHAPES[kind]
            params = {**e.params, **{key: v for key, v in layer.items() if not key.startswith("_")}}
            params["_value"] = layer.get(kind) if kind in layer else None
            params["_at_given"] = "at" in layer
            params.setdefault("at", [self.w / 2, self.h / 2])
            params["_rng"] = np.random.default_rng(seed)
            c = Canvas(self, k, sw, off, px)
            try:
                e.fn(c, params)
            except ImageError as ex:
                raise ImageError(f"{label}: {ex}") from None
            except ValueError as ex:          # a shape saying how it wants to be written
                raise ImageError(f"{label}: {ex}") from None
            except Exception as ex:  # noqa: BLE001
                raise ImageError(f'{label}: shape "{kind}" failed: {type(ex).__name__}: {ex}') from None
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        has_stroke = stroke_spec not in (None, False, "none")
        fill_spec = layer.get("fill")
        if fill_spec is None and not has_stroke:
            fill_spec = "#ffffff"                 # a shape without any paint is white
        self._through(out, c.fill, fill_spec, k, seed)
        # the outline follows the finished shape, so parts that overlap (a bubble and its tail) get one line around all
        lines = c.stroke
        if sw > 0 and c.fill.getbbox() is not None:
            lines = ImageChops.lighter(lines, edge_band(c.fill, sw * k))
        # outlines, lines and arcs: painted with the stroke — or, without one, with the fill
        self._through(out, lines, stroke_spec if has_stroke else (fill_spec if fill_spec not in (None, False, "none") else "#ffffff"), k, seed + 1)
        if c.direct is not None:
            out.alpha_composite(c.direct)
        return out

    def _through(self, out: Image.Image, mask: Image.Image, spec, k: float, seed: int) -> None:
        """Lays a paint over `out` where the mask is."""
        bbox = mask.getbbox()
        if bbox is None or spec in (None, False, "none"):
            return
        size = (bbox[2] - bbox[0], bbox[3] - bbox[1])
        paint = self._paint(spec, size, k, seed)
        if paint is None:
            return
        paint.putalpha(ImageChops.multiply(paint.getchannel("A"), mask.crop(bbox)))
        out.alpha_composite(paint, dest=(bbox[0], bbox[1]))

    def _text(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float]) -> Image.Image:
        label = layer["_label"]
        s = str(layer["text"])
        if layer.get("upper"):
            s = s.upper()
        size = _num(layer.get("size", 48), f"{label}.size", 1, 4000)
        f = self.font(layer.get("font", "bold"), size * k)
        at = _pair(layer["at"], label) if "at" in layer else (self.w / 2, self.h / 2)
        xy = ((at[0] + off[0]) * k, (at[1] + off[1]) * k)
        anchor = str(layer.get("anchor", "center"))
        valign = str(layer.get("valign", "middle"))
        if anchor not in ("left", "center", "right") or valign not in ("top", "middle", "bottom", "baseline"):
            raise ImageError(f"{label}: anchor is left | center | right, valign is top | middle | bottom | baseline")
        kw = dict(anchor=anchor, valign=valign, align=layer.get("align"), max_width=float(layer["width"]) * k if layer.get("width") else None,
                  line_height=float(layer.get("line_height", 1.2)), spacing=float(layer.get("spacing", 0)) * k)
        mask_img = Image.new("RGBA", px, (0, 0, 0, 0))
        box = gfx.draw_text(mask_img, s, xy, f, (255, 255, 255, 255), **kw)
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        if layer.get("box") not in (None, False):
            b = layer["box"]
            spec = b if isinstance(b, dict) else {"color": "#000000aa" if b is True else b}
            pad = float(spec.get("padding", size * 0.35)) * k
            ImageDraw.Draw(out).rounded_rectangle([box[0] - pad, box[1] - pad * 0.6, box[2] + pad, box[3] + pad * 0.6], radius=float(spec.get("radius", size * 0.2)) * k,
                                                  fill=self._color(spec.get("color", "#000000aa"), f"{label}.box"))
        stroke_spec = layer.get("stroke")
        sw = float(layer.get("stroke_width", 0))
        if isinstance(stroke_spec, dict) and "color" in stroke_spec:
            sw = float(stroke_spec.get("width", sw or size * 0.06))
            stroke_spec = stroke_spec["color"]
        if stroke_spec not in (None, False, "none"):
            sw = sw or size * 0.06
            sc = self._color(stroke_spec, f"{label}.stroke")
            gfx.draw_text(out, s, xy, f, sc, stroke=sc, stroke_width=sw * k, **kw)
        self._through(out, mask_img.getchannel("A"), layer.get("fill", "#ffffff"), k, self.seed)
        # text that does not fit is the most common mistake: say it
        bw = (box[2] - box[0]) / k
        if bw > self.w * 1.02 and not layer.get("width"):
            self.warnings.append(f'{label}: the text is {bw:.0f} px wide, the picture {self.w} px — use a smaller size or width: {int(self.w * 0.9)} to wrap it')
        elif box[0] < -2 or box[1] < -2 or box[2] > px[0] + 2 or box[3] > px[1] + 2:
            self.warnings.append(f"{label}: part of the text is outside the picture (it spans x {box[0] / k:.0f}…{box[2] / k:.0f}, y {box[1] / k:.0f}…{box[3] / k:.0f})")
        return out

    def _image(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float]) -> Image.Image:
        label = layer["_label"]
        src = self._open(self.file(layer["image"], f"{label}.image"))
        if layer.get("crop"):
            x, y, w, h = _list(layer["crop"], 4, f"{label}.crop")
            src = src.crop((int(x), int(y), int(x + w), int(y + h)))
        w, h = layer.get("width"), layer.get("height")
        if w and h:
            src = gfx.fit(src, (max(1, int(round(float(w) * k))), max(1, int(round(float(h) * k)))), str(layer.get("fit", "contain")))
        else:
            f = (float(w) / src.width) if w else (float(h) / src.height) if h else 1.0
            size = (max(1, int(round(src.width * f * k))), max(1, int(round(src.height * f * k))))
            if size != src.size:
                smooth = layer.get("smooth", True)
                src = src.resize(size, (Image.LANCZOS if f * k < 1 else Image.BICUBIC) if smooth else Image.NEAREST)
        at = _pair(layer["at"], label) if "at" in layer else (self.w / 2, self.h / 2)
        ax, ay = _anchor(layer.get("anchor", "center"), label)
        x = (at[0] + off[0]) * k - src.width * ax
        y = (at[1] + off[1]) * k - src.height * ay
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        out.paste(src, (int(round(x)), int(round(y))))
        return out

    def _texture_layer(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float], seed: int) -> Image.Image:
        label = layer["_label"]
        x, y, w, h = _list(layer["area"], 4, f"{label}.area") if layer.get("area") else (0.0, 0.0, float(self.w), float(self.h))
        size = (max(1, int(round(w * k))), max(1, int(round(h * k))))
        tex = self._texture(layer, size, k, seed, label)
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        out.paste(tex, (int(round((x + off[0]) * k)), int(round((y + off[1]) * k))))
        return out

    def _pixels(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float]) -> Image.Image:
        label = layer["_label"]
        grids = layer["_grids"]
        pal = {**self.palette, **{str(a): b for a, b in (layer.get("palette") or {}).items()}}
        cw, ch = max(len(g[0]) for g in grids), max(len(g) for g in grids)
        cols = max(1, int(layer.get("cols", len(grids))))
        gap = int(layer.get("gap", 0))
        rows = math.ceil(len(grids) / cols)
        sheet = Image.new("RGBA", (cols * cw + (cols - 1) * gap, rows * ch + (rows - 1) * gap), (0, 0, 0, 0))
        for gi, g in enumerate(grids):
            ox, oy = (gi % cols) * (cw + gap), (gi // cols) * (ch + gap)
            for yy, row in enumerate(g):
                for xx, c in enumerate(row):
                    if c in ". ":
                        continue
                    sheet.putpixel((ox + xx, oy + yy), self._color(pal[c], f"{label}.palette"))
        scale = layer.get("scale")
        s = _num(scale, f"{label}.scale", 0.01, 512) if scale is not None else max(1, min(self.w // sheet.width, self.h // sheet.height))
        size = (max(1, int(round(sheet.width * s * k))), max(1, int(round(sheet.height * s * k))))
        big = sheet.resize(size, Image.NEAREST)
        at = _pair(layer["at"], label) if "at" in layer else (self.w / 2, self.h / 2)
        ax, ay = _anchor(layer.get("anchor", "center"), label)
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        out.paste(big, (int(round((at[0] + off[0]) * k - big.width * ax)), int(round((at[1] + off[1]) * k - big.height * ay))))
        return out

    def _repeat(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float], seed: int) -> Image.Image:
        o = _pair(layer["at"], layer["_label"]) if "at" in layer else (0.0, 0.0)
        tile = self._stack(layer["_layers"], Image.new("RGBA", px, (0, 0, 0, 0)), k, (off[0] + o[0], off[1] + o[1]), seed)
        (nx, ny), (dx, dy) = layer["_count"], layer["_step"]
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        single = ny == 1 and not isinstance((layer["repeat"] if isinstance(layer["repeat"], dict) else {}).get("count", 1), list)
        for j in range(ny):
            for i in range(nx):
                sx, sy = (i * dx, i * dy) if single else (i * dx, j * dy)
                out.alpha_composite(gfx.shifted(tile, sx * k, sy * k))
        return out

    def _scatter(self, layer: dict, px: tuple[int, int], k: float, off: tuple[float, float], seed: int) -> Image.Image | None:
        s = layer["_scatter"]
        # the children are drawn around (0, 0): render them in the middle of a sheet, cut the sprite out
        mid = (self.w / 2, self.h / 2)
        sheet = self._stack(layer["_layers"], Image.new("RGBA", px, (0, 0, 0, 0)), k, mid, seed)
        bbox = sheet.getchannel("A").getbbox()
        if bbox is None:
            return None
        cx, cy = mid[0] * k, mid[1] * k
        r = int(math.ceil(max(math.hypot(bbox[0] - cx, bbox[1] - cy), math.hypot(bbox[2] - cx, bbox[1] - cy), math.hypot(bbox[0] - cx, bbox[3] - cy), math.hypot(bbox[2] - cx, bbox[3] - cy)))) + 2
        sprite = Image.new("RGBA", (2 * r, 2 * r), (0, 0, 0, 0))
        sprite.paste(sheet.crop((int(cx - r), int(cy - r), int(cx + r), int(cy + r))), (0, 0))
        rng = np.random.default_rng(s["seed"])
        ax, ay, aw, ah = s["area"]
        out = Image.new("RGBA", px, (0, 0, 0, 0))
        for _ in range(s["count"]):
            x, y = (ax + rng.random() * aw + off[0]) * k, (ay + rng.random() * ah + off[1]) * k
            sc = s["scale"][0] + rng.random() * (s["scale"][1] - s["scale"][0])
            rot = s["rotate"][0] + rng.random() * (s["rotate"][1] - s["rotate"][0])
            op = s["opacity"][0] + rng.random() * (s["opacity"][1] - s["opacity"][0])
            spr = sprite
            if abs(sc - 1) > 1e-3:
                n = max(2, int(round(2 * r * sc)))
                spr = spr.resize((n, n), Image.LANCZOS if sc < 1 else Image.BICUBIC)
            if abs(rot) > 1e-3:
                spr = spr.rotate(-rot, resample=Image.BICUBIC)
            if op < 0.999:
                spr = spr.copy()
                spr.putalpha(spr.getchannel("A").point(lambda v, o=op: int(v * max(0.0, o))))
            dest = (int(round(x - spr.width / 2)), int(round(y - spr.height / 2)))
            if dest[0] >= 0 and dest[1] >= 0:
                out.alpha_composite(spr, dest=dest)
            else:
                tmp = Image.new("RGBA", px, (0, 0, 0, 0))
                tmp.paste(spr, dest)
                out.alpha_composite(tmp)
        return out


def edge_band(mask: Image.Image, width: float) -> Image.Image:
    """A line of `width` pixels along the edge of a shape (half inside, half outside)."""
    bbox = mask.getbbox()
    if bbox is None or width <= 0:
        return Image.new("L", mask.size, 0)
    from scipy.ndimage import distance_transform_edt

    pad = int(math.ceil(width / 2)) + 2
    box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(mask.width, bbox[2] + pad), min(mask.height, bbox[3] + pad))
    inside = np.asarray(mask.crop(box)) >= 128
    d = np.where(inside, distance_transform_edt(inside), distance_transform_edt(~inside)) - 0.5
    band = np.clip(width / 2 - d + 0.5, 0, 1)
    out = Image.new("L", mask.size, 0)
    out.paste(Image.fromarray((band * 255).astype(np.uint8), "L"), box[:2])
    return out


def _range(v, where: str) -> tuple[float, float]:
    if isinstance(v, (list, tuple)):
        a, b = _pair(v, where)
        return (a, b)
    f = _num(v, where)
    return (f, f)


_ANCHORS = {"center": (0.5, 0.5), "top-left": (0, 0), "top": (0.5, 0), "top-right": (1, 0), "left": (0, 0.5), "right": (1, 0.5),
            "bottom-left": (0, 1), "bottom": (0.5, 1), "bottom-right": (1, 1)}


def _anchor(v, where: str) -> tuple[float, float]:
    if isinstance(v, (list, tuple)):
        return _pair(v, f"{where}.anchor")
    a = _ANCHORS.get(str(v))
    if a is None:
        raise ImageError(f'{where}.anchor: "{v}" — one of {", ".join(_ANCHORS)} or [fx, fy]')
    return a


def load_doc_text(text: str, path: str | Path = "picture.image.yaml", depth: int = 0) -> Doc:
    path = Path(path)
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise ImageError(f"{path.name}: YAML syntax error: {e}") from None
    if not isinstance(data, dict):
        raise ImageError("a picture file must be a mapping with image / layers")
    return Doc(data, path, depth)


def load_doc(path: str | Path, depth: int = 0) -> Doc:
    path = Path(path)
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        raise ImageError(f"file not found: {path}") from None
    return load_doc_text(text, path, depth)
