"""Shared picture helpers of the Studio tools (studio-image, studio-video): colors, fonts, text,
gradients, blending, fitting, contact sheets. Pure Pillow + numpy.

    import sys; sys.path.insert(0, "/opt/studio/tools/studio/python")
    from studio_gfx import color, font, draw_text, gradient, blend, fit, contact_sheet
"""
from __future__ import annotations

import math
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
NAMED = {
    "black": (0, 0, 0), "white": (255, 255, 255), "red": (220, 60, 60), "green": (70, 190, 110), "blue": (70, 130, 230),
    "yellow": (250, 210, 60), "orange": (245, 150, 50), "purple": (160, 110, 230), "pink": (240, 120, 180), "cyan": (60, 200, 220),
    "gray": (130, 135, 145), "grey": (130, 135, 145), "brown": (140, 95, 60), "navy": (28, 44, 92), "teal": (40, 150, 140),
    "gold": (240, 200, 60), "silver": (190, 195, 205), "skin": (236, 188, 150), "ink": (16, 18, 24), "paper": (244, 241, 232),
    "lime": (163, 230, 53), "magenta": (217, 70, 239), "violet": (139, 92, 246), "indigo": (99, 102, 241), "sky": (56, 189, 248),
    "mint": (110, 231, 183), "rose": (244, 63, 94), "amber": (245, 158, 11), "maroon": (128, 30, 40), "olive": (128, 128, 50),
    "beige": (232, 220, 196), "cream": (255, 248, 225), "sand": (214, 190, 150), "slate": (71, 85, 105), "charcoal": (40, 44, 52),
}


class GfxError(ValueError):
    pass


def color(c, palette: dict | None = None, default=(0, 0, 0, 255)) -> tuple[int, int, int, int]:
    """"#rgb" "#rrggbb" "#rrggbbaa", a name, a palette name, [r, g, b(, a)], "transparent" -> (r, g, b, a)."""
    if c is None:
        return tuple(default)  # type: ignore[return-value]
    if isinstance(c, (list, tuple)) and 3 <= len(c) <= 4 and all(isinstance(v, (int, float)) for v in c):
        v = [int(max(0, min(255, round(x)))) for x in c]
        return (v[0], v[1], v[2], v[3] if len(v) == 4 else 255)
    s = str(c).strip()
    low = s.lower()
    if palette and s in palette:
        return color(palette[s], None)
    if low in ("transparent", "none", "clear"):
        return (0, 0, 0, 0)
    if low in NAMED:
        return NAMED[low] + (255,)
    if low.startswith("#"):
        h = low[1:]
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h)
        if len(h) in (6, 8) and re.fullmatch(r"[0-9a-f]+", h):
            v = [int(h[i : i + 2], 16) for i in range(0, len(h), 2)]
            return (v[0], v[1], v[2], v[3] if len(v) == 4 else 255)
    names = sorted(palette) if palette else []
    raise GfxError(f'"{c}" is not a color (use #rrggbb, #rrggbbaa, [r, g, b], transparent or a name: {", ".join(names + sorted(NAMED)[:14])} …)')


def with_alpha(c: tuple, alpha: float) -> tuple[int, int, int, int]:
    return (c[0], c[1], c[2], int(max(0, min(255, round((c[3] if len(c) > 3 else 255) * alpha)))))


def mix(a: tuple, b: tuple, u: float) -> tuple[int, int, int, int]:
    return tuple(int(round(a[i] + (b[i] - a[i]) * u)) for i in range(4))  # type: ignore[return-value]


def luminance(c: tuple) -> float:
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def hexcolor(c: tuple) -> str:
    return "#%02x%02x%02x" % (int(c[0]), int(c[1]), int(c[2])) + ("%02x" % int(c[3]) if len(c) > 3 and c[3] < 255 else "")


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------
_FONT_ROOT = "/usr/share/fonts/truetype"
FONTS = {
    "sans": ["dejavu/DejaVuSans.ttf", "liberation/LiberationSans-Regular.ttf"],
    "bold": ["dejavu/DejaVuSans-Bold.ttf", "liberation/LiberationSans-Bold.ttf"],
    "serif": ["dejavu/DejaVuSerif.ttf", "liberation/LiberationSerif-Regular.ttf"],
    "serif-bold": ["dejavu/DejaVuSerif-Bold.ttf", "liberation/LiberationSerif-Bold.ttf"],
    "mono": ["dejavu/DejaVuSansMono.ttf", "liberation/LiberationMono-Regular.ttf"],
    "mono-bold": ["dejavu/DejaVuSansMono-Bold.ttf", "liberation/LiberationMono-Bold.ttf"],
    "italic": ["liberation/LiberationSans-Italic.ttf", "freefont/FreeSansOblique.ttf"],
    "bold-italic": ["liberation/LiberationSans-BoldItalic.ttf", "freefont/FreeSansBoldOblique.ttf"],
    "serif-italic": ["liberation/LiberationSerif-Italic.ttf", "freefont/FreeSerifItalic.ttf"],
    "narrow": ["liberation/LiberationSansNarrow-Regular.ttf"],
    "narrow-bold": ["liberation/LiberationSansNarrow-Bold.ttf"],
    "helvetica": ["liberation/LiberationSans-Regular.ttf"],
    "helvetica-bold": ["liberation/LiberationSans-Bold.ttf"],
    "times": ["liberation/LiberationSerif-Regular.ttf"],
    "times-bold": ["liberation/LiberationSerif-Bold.ttf"],
    "courier": ["liberation/LiberationMono-Regular.ttf"],
    "pixel": ["unifont/unifont.ttf", "dejavu/DejaVuSansMono-Bold.ttf"],
}
FONT_ALIASES = {"regular": "sans", "normal": "sans", "sans-bold": "bold", "monospace": "mono", "code": "mono", "condensed": "narrow"}
_font_cache: dict[tuple, ImageFont.FreeTypeFont] = {}


def font_path(name: str | None, base_dir: str | Path | None = None, packs=None) -> str | None:
    """A font name, a .ttf/.otf file of the project, or a pack item (pack/item) -> file path (None: unknown)."""
    n = str(name or "sans").strip()
    key = FONT_ALIASES.get(n.lower(), n.lower())
    if key in FONTS:
        for rel in FONTS[key]:
            p = os.path.join(_FONT_ROOT, rel)
            if os.path.exists(p):
                return p
        return None
    if n.lower().endswith((".ttf", ".otf", ".ttc")):
        p = Path(n) if os.path.isabs(n) else Path(base_dir or ".") / n
        return str(p) if p.is_file() else None
    if "/" in n and packs is not None:
        try:
            p = packs(n)
        except Exception:  # noqa: BLE001
            p = None
        return str(p) if p else None
    return None


def font(name: str | None, size: float, base_dir: str | Path | None = None, packs=None) -> ImageFont.FreeTypeFont:
    size_i = max(1, int(round(size)))
    key = (str(name or "sans"), size_i, str(base_dir or ""))
    f = _font_cache.get(key)
    if f is None:
        path = font_path(name, base_dir, packs)
        if path is None:
            raise GfxError(f'unknown font "{name}" (fonts: {", ".join(FONTS)}; or a .ttf / .otf file of the project)')
        try:
            f = ImageFont.truetype(path, size_i)
        except OSError as e:
            raise GfxError(f'font "{name}" cannot be loaded: {e}') from None
        if len(_font_cache) > 400:
            _font_cache.clear()
        _font_cache[key] = f
    return f


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------
def wrap_text(text: str, fnt: ImageFont.FreeTypeFont, max_width: float | None, spacing: float = 0.0) -> list[str]:
    """Break text into lines: explicit newlines always, words when a width is given."""
    out: list[str] = []
    for para in str(text).split("\n"):
        if not max_width or max_width <= 0:
            out.append(para)
            continue
        words = para.split(" ")
        line = ""
        for w in words:
            trial = w if not line else f"{line} {w}"
            if line and line_width(trial, fnt, spacing) > max_width:
                out.append(line)
                line = w
            else:
                line = trial
        out.append(line)
    return out


def line_width(s: str, fnt: ImageFont.FreeTypeFont, spacing: float = 0.0) -> float:
    return float(fnt.getlength(s)) + spacing * max(0, len(s) - 1)


def text_block(text: str, fnt: ImageFont.FreeTypeFont, max_width: float | None = None, line_height: float = 1.2, spacing: float = 0.0) -> dict:
    """Lines and the size of the block they need."""
    lines = wrap_text(text, fnt, max_width, spacing)
    asc, desc = fnt.getmetrics()
    lh = (asc + desc) * line_height
    widths = [line_width(s, fnt, spacing) for s in lines]
    return {"lines": lines, "widths": widths, "width": max(widths) if widths else 0.0, "height": lh * (len(lines) - 1) + asc + desc, "line": lh, "ascent": asc, "descent": desc}


def _line(d: ImageDraw.ImageDraw, x: float, y: float, s: str, fnt, fill, spacing: float, **kw) -> None:
    if not spacing:
        d.text((x, y), s, font=fnt, fill=fill, **kw)
        return
    for ch in s:  # letter spacing: character by character
        d.text((x, y), ch, font=fnt, fill=fill, **kw)
        x += fnt.getlength(ch) + spacing


def draw_text(
    img: Image.Image,
    text: str,
    xy: tuple[float, float],
    fnt: ImageFont.FreeTypeFont,
    fill=(255, 255, 255, 255),
    anchor: str = "left",          # left | center | right  ×  valign: top | middle | bottom | baseline
    valign: str = "top",
    align: str | None = None,       # alignment of the lines inside the block (default: like anchor)
    max_width: float | None = None,
    line_height: float = 1.2,
    spacing: float = 0.0,
    stroke: tuple | None = None,
    stroke_width: float = 0.0,
    shadow: dict | None = None,     # {dx, dy, blur, color}
    box: dict | None = None,        # {color, padding, radius}
) -> tuple[float, float, float, float]:
    """Draws a block of text onto an RGBA image; returns its box (x0, y0, x1, y1)."""
    b = text_block(text, fnt, max_width, line_height, spacing)
    w, h = b["width"], b["height"]
    x = xy[0] - (w / 2 if anchor == "center" else w if anchor == "right" else 0)
    y = xy[1] - (h / 2 if valign == "middle" else h if valign == "bottom" else b["ascent"] if valign == "baseline" else 0)
    align = align or anchor
    sw = int(round(stroke_width)) if stroke else 0

    def paint(target: Image.Image, col, stroke_col, ox: float = 0.0, oy: float = 0.0) -> None:
        d = ImageDraw.Draw(target)
        for i, s in enumerate(b["lines"]):
            lx = x + (w - b["widths"][i]) * (0.5 if align == "center" else 1.0 if align == "right" else 0.0)
            kw = {"stroke_width": sw, "stroke_fill": stroke_col} if sw and stroke_col is not None else {}
            _line(d, lx + ox, y + i * b["line"] + oy, s, fnt, col, spacing, **kw)

    if box:
        pad = float(box.get("padding", fnt.size * 0.35))
        r = float(box.get("radius", fnt.size * 0.2))
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle([x - pad, y - pad * 0.7, x + w + pad, y + h + pad * 0.7], radius=r, fill=tuple(box.get("color", (0, 0, 0, 150))))
        img.alpha_composite(layer)
    if shadow:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        paint(layer, tuple(shadow.get("color", (0, 0, 0, 160))), tuple(shadow.get("color", (0, 0, 0, 160))) if sw else None, float(shadow.get("dx", 0)), float(shadow.get("dy", 4)))
        if float(shadow.get("blur", 6)) > 0:
            layer = layer.filter(ImageFilter.GaussianBlur(float(shadow.get("blur", 6))))
        img.alpha_composite(layer)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    paint(layer, tuple(fill), tuple(stroke) if stroke else None)
    img.alpha_composite(layer)
    return (x - sw, y - sw, x + w + sw, y + h + sw)


# ---------------------------------------------------------------------------
# Gradients, patterns
# ---------------------------------------------------------------------------
def gradient(size: tuple[int, int], colors: list, angle: float = 90.0, kind: str = "linear", stops: list | None = None,
             center: tuple[float, float] = (0.5, 0.5), palette: dict | None = None) -> Image.Image:
    """A gradient image. angle: 0 = left → right, 90 = top → bottom. kind: linear | radial | conic."""
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    cols = np.array([color(c, palette) for c in colors], dtype=np.float32)
    if len(cols) < 2:
        cols = np.vstack([cols, cols])
    pos = np.array(stops if stops and len(stops) == len(cols) else np.linspace(0, 1, len(cols)), dtype=np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if kind == "radial":
        cx, cy = center[0] * w, center[1] * h
        far = max(math.hypot(cx, cy), math.hypot(w - cx, cy), math.hypot(cx, h - cy), math.hypot(w - cx, h - cy))
        u = np.hypot(xx - cx, yy - cy) / max(far, 1.0)
    elif kind == "conic":
        cx, cy = center[0] * w, center[1] * h
        u = (np.degrees(np.arctan2(yy - cy, xx - cx)) - angle) % 360 / 360
    else:
        a = math.radians(angle)
        dx, dy = math.cos(a), math.sin(a)
        proj = (xx - w / 2) * dx + (yy - h / 2) * dy
        half = (abs(dx) * w + abs(dy) * h) / 2 or 1.0
        u = proj / (2 * half) + 0.5
    u = np.clip(u, 0, 1)
    out = np.empty((h, w, 4), dtype=np.float32)
    for ch in range(4):
        out[..., ch] = np.interp(u, pos, cols[:, ch])
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


def checkerboard(size: tuple[int, int], cell: int = 16, a=(54, 58, 68), b=(72, 77, 90)) -> Image.Image:
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    m = ((xx // cell + yy // cell) % 2).astype(bool)
    arr = np.where(m[..., None], np.array(b, dtype=np.uint8), np.array(a, dtype=np.uint8))
    return Image.fromarray(arr.astype(np.uint8), "RGB")


# ---------------------------------------------------------------------------
# Compositing
# ---------------------------------------------------------------------------
BLENDS = ["normal", "multiply", "screen", "overlay", "add", "darken", "lighten", "difference", "soft_light", "color_dodge", "subtract"]


def blend(base: Image.Image, top: Image.Image, mode: str = "normal", opacity: float = 1.0) -> Image.Image:
    """`top` over `base` (both RGBA, same size) with a blend mode and an opacity."""
    if opacity <= 0:
        return base
    if mode in ("normal", "", None) :
        if opacity < 1:
            top = top.copy()
            top.putalpha(top.getchannel("A").point(lambda v: int(v * opacity)))
        out = base.copy()
        out.alpha_composite(top)
        return out
    if mode not in BLENDS:
        raise GfxError(f'unknown blend mode "{mode}" (one of: {", ".join(BLENDS)})')
    b = np.asarray(base, dtype=np.float32) / 255.0
    s = np.asarray(top, dtype=np.float32) / 255.0
    cb, cs = b[..., :3], s[..., :3]
    ab, as_ = b[..., 3:4], s[..., 3:4] * opacity
    if mode == "multiply":
        m = cb * cs
    elif mode == "screen":
        m = 1 - (1 - cb) * (1 - cs)
    elif mode == "overlay":
        m = np.where(cb <= 0.5, 2 * cb * cs, 1 - 2 * (1 - cb) * (1 - cs))
    elif mode == "add":
        m = np.minimum(1.0, cb + cs)
    elif mode == "subtract":
        m = np.maximum(0.0, cb - cs)
    elif mode == "darken":
        m = np.minimum(cb, cs)
    elif mode == "lighten":
        m = np.maximum(cb, cs)
    elif mode == "difference":
        m = np.abs(cb - cs)
    elif mode == "color_dodge":
        m = np.minimum(1.0, cb / np.maximum(1e-4, 1 - cs))
    else:  # soft_light
        m = (1 - 2 * cs) * cb * cb + 2 * cs * cb
    # W3C compositing: the blended color only where both are present
    co = cs * as_ * (1 - ab) + m * as_ * ab + cb * ab * (1 - as_)
    ao = as_ + ab * (1 - as_)
    rgb = np.where(ao > 1e-6, co / np.maximum(ao, 1e-6), 0)
    out = np.concatenate([rgb, ao], axis=-1)
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA")


def fit(img: Image.Image, size: tuple[int, int], mode: str = "cover", background=(0, 0, 0, 0), anchor: tuple[float, float] = (0.5, 0.5)) -> Image.Image:
    """Resize to exactly `size`: cover (fill, crop the overflow), contain (all visible, bars), stretch."""
    w, h = int(size[0]), int(size[1])
    if img.size == (w, h):
        return img
    if mode == "stretch":
        return img.resize((w, h), Image.LANCZOS)
    sw, sh = img.size
    k = max(w / sw, h / sh) if mode == "cover" else min(w / sw, h / sh)
    nw, nh = max(1, int(round(sw * k))), max(1, int(round(sh * k)))
    r = img.resize((nw, nh), Image.LANCZOS if k < 1 else Image.BICUBIC)
    if mode == "cover":
        x0 = int(round((nw - w) * anchor[0]))
        y0 = int(round((nh - h) * anchor[1]))
        return r.crop((x0, y0, x0 + w, y0 + h))
    out = Image.new(img.mode if img.mode in ("RGBA", "RGB") else "RGBA", (w, h), tuple(background)[: 4 if img.mode == "RGBA" else 3])
    out.paste(r, ((w - nw) // 2, (h - nh) // 2))
    return out


def shifted(img: Image.Image, dx: float, dy: float) -> Image.Image:
    """The same image moved by (dx, dy); what leaves the frame is cut off."""
    if not dx and not dy:
        return img
    out = Image.new(img.mode, img.size, (0, 0, 0, 0) if img.mode == "RGBA" else 0)
    out.paste(img, (int(round(dx)), int(round(dy))))
    return out


def on_checker(img: Image.Image, cell: int = 12) -> Image.Image:
    """RGBA picture on a checkerboard, so transparency is visible in previews."""
    if img.mode != "RGBA" or img.getextrema()[3][0] == 255:
        return img.convert("RGB")
    bg = checkerboard(img.size, cell).convert("RGBA")
    bg.alpha_composite(img)
    return bg.convert("RGB")


# ---------------------------------------------------------------------------
# Contact sheets (previews the AI looks at)
# ---------------------------------------------------------------------------
def contact_sheet(cells: list[tuple[str, Image.Image]], path: str | Path, title: str = "", cols: int = 4, cell_w: int = 420, note: str = "") -> None:
    """A grid of labelled pictures as one PNG."""
    if not cells:
        raise GfxError("nothing to show")
    cols = max(1, min(cols, len(cells)))
    rows = math.ceil(len(cells) / cols)
    aspect = cells[0][1].height / max(1, cells[0][1].width)
    cw, ch = cell_w, max(1, int(round(cell_w * aspect)))
    pad, label_h, head = 8, 26, 40 if title else 8
    W = pad + cols * (cw + pad)
    H = head + rows * (ch + label_h + pad) + (24 if note else 0)
    sheet = Image.new("RGB", (W, H), (13, 16, 23))
    d = ImageDraw.Draw(sheet)
    try:
        f_title, f_label = font("bold", 18), font("mono", 13)
    except GfxError:
        f_title = f_label = ImageFont.load_default()
    if title:
        d.text((pad + 2, 10), title, font=f_title, fill=(235, 238, 245))
    for i, (label, im) in enumerate(cells):
        x = pad + (i % cols) * (cw + pad)
        y = head + (i // cols) * (ch + label_h + pad)
        thumb = fit(on_checker(im) if im.mode == "RGBA" else im.convert("RGB"), (cw, ch), "contain", (13, 16, 23))
        sheet.paste(thumb.convert("RGB"), (x, y))
        d.text((x + 3, y + ch + 5), label[: max(8, cw // 8)], font=f_label, fill=(170, 178, 195))
    if note:
        d.text((pad + 2, H - 20), note, font=f_label, fill=(120, 128, 145))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(path))
