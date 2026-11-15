"""Drawing: a Canvas with a world->pixel transform, fonts, and the stick figure itself."""
from __future__ import annotations

import math
import os
import unicodedata
from functools import lru_cache

from PIL import Image, ImageChops, ImageDraw, ImageFont

from .skeleton import color as _color
from .skeleton import luminance, mix, shade

FONT_FILES = {
    "bold": ["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "NotoSans-Bold.ttf", "arialbd.ttf"],
    "regular": ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "NotoSans-Regular.ttf", "arial.ttf"],
    "italic": ["LiberationSans-BoldItalic.ttf", "DejaVuSans-BoldOblique.ttf", "arialbi.ttf"],
    "mono": ["DejaVuSansMono-Bold.ttf", "LiberationMono-Bold.ttf", "consolab.ttf"],
}
FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype/liberation", "/usr/share/fonts/truetype/noto",
             "/usr/share/fonts/opentype/noto", "/usr/share/fonts/truetype/wqy", "/usr/share/fonts", "C:/Windows/Fonts",
             "/System/Library/Fonts", "/Library/Fonts"]
# Characters the scene's font does not have (★ ✓ in Arial, 你好, emoji) are drawn with the first of these
# that has them, instead of as empty boxes. Colour emoji fonts come first for emoji.
FALLBACK_FILES = ["DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "LiberationSans-Bold.ttf", "seguisym.ttf", "segoeuib.ttf",
                  "NotoSansCJK-Bold.ttc", "NotoSansCJK-Regular.ttc", "NotoSansCJKsc-Bold.otf", "wqy-zenhei.ttc", "wqy-microhei.ttc",
                  "msyhbd.ttc", "msyh.ttc", "YuGothB.ttc", "malgunbd.ttf", "NotoSansSymbols2-Regular.ttf"]
EMOJI_FILES = ["NotoColorEmoji.ttf", "seguiemj.ttf", "Apple Color Emoji.ttc"]


@lru_cache(maxsize=None)
def _find_font(name: str) -> str | None:
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    # distributions put fonts in different sub folders: look the name up once in a walk of /usr/share/fonts
    return _font_index().get(name.lower())


@lru_cache(maxsize=None)
def _font_index() -> dict:
    out: dict = {}
    if os.path.isdir("/usr/share/fonts"):
        for root, _dirs, files in os.walk("/usr/share/fonts"):
            for f in files:
                out.setdefault(f.lower(), os.path.join(root, f))
    return out


@lru_cache(maxsize=None)
def _font_path(kind: str) -> str | None:
    for name in FONT_FILES.get(kind, FONT_FILES["bold"]):
        p = _find_font(name)
        if p:
            return p
    return None


@lru_cache(maxsize=256)
def font(kind: str, size: int):
    path = kind if os.path.sep in kind or "/" in kind else _font_path(kind)
    size = max(4, int(size))
    if path:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size)
    except TypeError:  # old Pillow
        return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Glyph fallback: which font has a character
# ---------------------------------------------------------------------------
@lru_cache(maxsize=None)
def _bitmap_size(path: str) -> int | None:
    """Colour bitmap fonts (Noto Color Emoji) only open at their own size (109 px); None = scalable."""
    try:
        ImageFont.truetype(path, 32)
        return None
    except OSError:
        pass
    for s in (109, 136, 128, 96, 64):
        try:
            ImageFont.truetype(path, s)
            return s
        except OSError:
            continue
    return -1                                      # cannot be used at all


def _face(path: str, size: int):
    """The font file at a pixel size: (font, factor) — bitmap fonts come at their own size, factor scales them."""
    b = _bitmap_size(path)
    if b is None:
        return font(path, size), 1.0
    return font(path, b), size / b


@lru_cache(maxsize=None)
def _cmap(path: str):
    """The characters a font file has (needs fontTools; None when it is not installed)."""
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        return None
    try:
        tt = TTFont(path, fontNumber=0, lazy=True)
        return frozenset(tt["cmap"].getBestCmap() or {})
    except Exception:  # noqa: BLE001  (a font fontTools cannot read: fall back to drawing the glyph)
        return None


def _glyph_png(f, ch: str) -> Image.Image:
    l, t, r, b = f.getbbox(ch)
    im = Image.new("L", (max(1, int(r - l)) + 2, max(1, int(b - t)) + 2))
    ImageDraw.Draw(im).text((1 - l, 1 - t), ch, font=f, fill=255)
    return im


@lru_cache(maxsize=8192)
def covers(path: str, ch: str) -> bool:
    """True when the font file has a real glyph for the character (not the empty box it draws instead)."""
    cm = _cmap(path)
    if cm is not None:
        return ord(ch) in cm
    if _bitmap_size(path) == -1:
        return False
    try:
        f, _ = _face(path, 32)
        a, n = _glyph_png(f, ch), _glyph_png(f, "\U0010ffff")      # U+10FFFF is never a character: the font's box
    except Exception:  # noqa: BLE001
        return False
    if a.size != n.size:
        return True
    return ImageChops.difference(a, n).getbbox() is not None


@lru_cache(maxsize=None)
def _font_chain(primary: str | None, emoji: bool) -> tuple:
    rest = [p for p in (_find_font(n) for n in FALLBACK_FILES) if p]
    emo = [p for p in (_find_font(n) for n in EMOJI_FILES) if p and _bitmap_size(p) != -1]
    # emoji: colour fonts before the scene font (DejaVu has a few black-and-white emoji)
    order = (emo + ([primary] if primary else []) + rest) if emoji else (([primary] if primary else []) + rest + emo)
    seen: list = []
    for p in order:
        if p not in seen:
            seen.append(p)
    return tuple(seen)


def _is_emoji(text: str, i: int) -> bool:
    o = ord(text[i])
    return o >= 0x1F000 or (i + 1 < len(text) and text[i + 1] == "\ufe0f")


@lru_cache(maxsize=2048)
def text_runs(text: str, kind: str = "bold") -> tuple:
    """The text cut into runs of one font each: ((chunk, font path or None = the scene font), …)."""
    primary = kind if (os.path.sep in kind or "/" in kind) else _font_path(kind)
    runs: list = []
    for i, ch in enumerate(text):
        if ch == "\n":
            path = None
        elif ch.isspace() or (unicodedata.category(ch) in ("Mn", "Me", "Cf", "Sk") and runs):
            path = runs[-1][1] if runs else None          # joiners and variation selectors stay with their character
        elif primary and covers(primary, ch) and not _is_emoji(text, i):
            path = None
        else:
            path = next((p for p in _font_chain(primary, _is_emoji(text, i)) if covers(p, ch)), None)
            if path == primary:
                path = None
        if runs and runs[-1][1] == path:
            runs[-1] = (runs[-1][0] + ch, path)
        else:
            runs.append((ch, path))
    return tuple(runs)


def needs_fallback(text: str, kind: str = "bold") -> bool:
    return any(p is not None for _, p in text_runs(str(text), kind))


def missing_glyphs(text: str, kind: str = "bold") -> str:
    """Characters of the text that no installed font has (they show as boxes) — for `check` warnings."""
    primary = _font_path(kind)
    out = []
    for i, ch in enumerate(str(text)):
        if ch.isspace() or unicodedata.category(ch) in ("Mn", "Me", "Cf", "Cc", "Sk") or ch in out:
            continue
        if not any(covers(p, ch) for p in _font_chain(primary, _is_emoji(str(text), i))):
            out.append(ch)
    return "".join(out)


def _run_lay(text: str, kind: str, px: int, sw: int) -> tuple:
    """Where the runs of a text in several fonts go: (lines laid out, width, height, ascent, line height)."""
    base = font(kind, px)
    asc, desc = base.getmetrics()
    spacing = 4
    lines = text.split("\n")
    laid = []
    for line in lines:
        x = 0.0
        parts = []
        for chunk, path in text_runs(line, kind):
            if path is None:
                f, k = base, 1.0
            else:
                f, k = _face(path, px)
            w = f.getlength(chunk) * k
            parts.append((chunk, f, k, x, path))
            x += w
        laid.append((x, parts))
    width = int(max([w for w, _ in laid] + [1]) + 2 * sw + 4)
    line_h = asc + desc + spacing
    height = int(line_h * len(lines) - spacing + 2 * sw + 4)
    return laid, width, height, asc, line_h


def _run_layer(text: str, kind: str, px: int, fill: tuple, sw: int, stroke_c) -> Image.Image:
    """Text in several fonts on a transparent layer (lines centred, like multiline_text)."""
    laid, width, height, asc, line_h = _run_lay(text, kind, px, sw)
    layer = Image.new("RGBA", (max(1, width), max(1, height)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for li, (lw, parts) in enumerate(laid):
        x0 = (width - lw) / 2
        base_y = sw + 2 + li * line_h + asc
        for chunk, f, k, x, path in parts:
            colour_font = path is not None and (_bitmap_size(path) is not None or os.path.basename(path) in EMOJI_FILES)
            if k == 1.0:
                d.text((x0 + x, base_y), chunk, font=f, fill=fill, anchor="ls", embedded_color=colour_font,
                       stroke_width=0 if colour_font else sw, stroke_fill=stroke_c)
            else:                                   # a bitmap font: draw at its own size, then scale it
                l, t, r, b = f.getbbox(chunk, anchor="ls")
                tmp = Image.new("RGBA", (max(1, int(r - l) + 2), max(1, int(b - t) + 2)), (0, 0, 0, 0))
                ImageDraw.Draw(tmp).text((1 - l, 1 - t), chunk, font=f, fill=fill, anchor="ls", embedded_color=True)
                tmp = tmp.resize((max(1, round(tmp.width * k)), max(1, round(tmp.height * k))), Image.LANCZOS)
                layer.alpha_composite(tmp, (int(x0 + x + (l - 1) * k), int(base_y + (t - 1) * k)))
    return layer


def rgba(c, alpha: float | None = None) -> tuple:
    t = _color(c) if not (isinstance(c, tuple) and len(c) in (3, 4)) else c
    if len(t) == 3:
        t = t + (255,)
    if alpha is not None:
        t = t[:3] + (int(max(0, min(255, t[3] * alpha))),)
    return tuple(int(v) for v in t)


class Canvas:
    """Draws in world (or local) coordinates onto an image. `at()` gives a local coordinate system."""

    def __init__(self, img: Image.Image, m: tuple = (1, 0, 0, 1, 0, 0), draw: ImageDraw.ImageDraw | None = None):
        self.img = img
        self.d = draw or ImageDraw.Draw(img, "RGBA")
        self.m = m
        self.k = math.sqrt(abs(m[0] * m[3] - m[1] * m[2]))

    # -- transforms -------------------------------------------------------------
    def p(self, pt) -> tuple[float, float]:
        a, b, c, d, tx, ty = self.m
        return (a * pt[0] + c * pt[1] + tx, b * pt[0] + d * pt[1] + ty)

    def s(self, v: float) -> float:
        return v * self.k

    def at(self, origin, angle: float = 0.0, flip: int = 1, scale: float = 1.0) -> "Canvas":
        """A canvas whose (0, 0) is `origin`, turned by `angle` degrees (clockwise), optionally mirrored
        (flip = -1 mirrors the x axis) and scaled. In local coordinates -y is up."""
        r = math.radians(angle)
        cs, sn = math.cos(r) * scale, math.sin(r) * scale
        la, lb, lc, ld = cs * flip, sn * flip, -sn, cs
        a, b, c, d, tx, ty = self.m
        ox, oy = origin
        return Canvas(
            self.img,
            (a * la + c * lb, b * la + d * lb, a * lc + c * ld, b * lc + d * ld, a * ox + c * oy + tx, b * ox + d * oy + ty),
            self.d,
        )

    # -- primitives ---------------------------------------------------------------
    def line(self, a, b, width: float, col, cap: bool = True) -> None:
        pa, pb = self.p(a), self.p(b)
        w = max(1, int(round(self.s(width))))
        c = rgba(col)
        self.d.line([pa, pb], fill=c, width=w)
        if cap and w > 2:
            r = w / 2
            for q in (pa, pb):
                self.d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=c)

    def polyline(self, pts, width: float, col, closed: bool = False) -> None:
        pp = [self.p(q) for q in pts]
        if closed:
            pp.append(pp[0])
        w = max(1, int(round(self.s(width))))
        c = rgba(col)
        self.d.line(pp, fill=c, width=w, joint="curve")
        if w > 2:
            r = w / 2
            for q in pp:
                self.d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=c)

    def circle(self, c, r: float, fill=None, outline=None, width: float = 0) -> None:
        q = self.p(c)
        rr = self.s(r)
        self.d.ellipse(
            [q[0] - rr, q[1] - rr, q[0] + rr, q[1] + rr],
            fill=rgba(fill) if fill is not None else None,
            outline=rgba(outline) if outline is not None else None,
            width=max(1, int(round(self.s(width)))) if outline is not None else 0,
        )

    def ellipse(self, c, rx: float, ry: float, fill=None, outline=None, width: float = 0, rot: float = 0.0, n: int = 28) -> None:
        r = math.radians(rot)
        cs, sn = math.cos(r), math.sin(r)
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            x, y = rx * math.cos(a), ry * math.sin(a)
            pts.append((c[0] + x * cs - y * sn, c[1] + x * sn + y * cs))
        self.poly(pts, fill, outline, width)

    def poly(self, pts, fill=None, outline=None, width: float = 0) -> None:
        pp = [self.p(q) for q in pts]
        if fill is not None:
            self.d.polygon(pp, fill=rgba(fill))
        if outline is not None and width > 0:
            self.d.line(pp + [pp[0]], fill=rgba(outline), width=max(1, int(round(self.s(width)))), joint="curve")

    def rect(self, x: float, y: float, w: float, h: float, fill=None, outline=None, width: float = 0, radius: float = 0) -> None:
        """Rectangle with the top-left corner at (x, y)."""
        if radius > 0:
            r = min(radius, abs(w) / 2, abs(h) / 2)
            pts = []
            for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
                for i in range(6):
                    a = math.radians(a0 + i * 18)
                    pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
            self.poly(pts, fill, outline, width)
        else:
            self.poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], fill, outline, width)

    def glow(self, c, r: float, col, strength: float = 0.5) -> None:
        """A soft round glow (lamp, sun): smooth from the centre to nothing at radius r — a few stacked
        discs showed rings."""
        rr = int(round(self.s(r)))
        if rr < 2:
            return
        q = self.p(c)
        sprite = _glow_sprite(rr, tuple(rgba(col)[:3]), int(max(0.0, min(1.0, strength)) * 255))
        pos = (int(round(q[0])) - rr, int(round(q[1])) - rr)
        if self.img.mode == "RGBA":
            self.img.alpha_composite(sprite, (max(0, pos[0]), max(0, pos[1])), (max(0, -pos[0]), max(0, -pos[1])))
        else:
            self.img.paste(sprite, pos, sprite)

    def arc(self, c, r: float, a0: float, a1: float, width: float, col, n: int = 16) -> None:
        """Part of a circle from angle a0 to a1 (degrees, 0 = +x, clockwise)."""
        pts = []
        for i in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            pts.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
        pp = [self.p(q) for q in pts]
        self.d.line(pp, fill=rgba(col), width=max(1, int(round(self.s(width)))), joint="curve")

    def text(self, s: str, x: float, y: float, size: float, col="#ffffff", anchor: str = "mm", font_name: str = "bold", rot: float = 0.0,
             stroke=None, stroke_width: float = 0.0, alpha: float = 1.0) -> None:
        """Text with its anchor point at (x, y): anchor is two letters — l/m/r and t/m/b."""
        px = int(round(self.s(size)))
        text = str(s)
        sw = int(round(self.s(stroke_width))) if stroke is not None else 0
        # text far bigger than the picture cannot be read, and Pillow refuses to make its letters (a
        # DecompressionBombError: a size-400 word at 4K): it is drawn at the largest size that is at
        # most 1.25 times the picture. A quick upper bound first, so ordinary text is not measured.
        W, H = self.img.size
        lines = text.split("\n")
        if px * max(len(ln) for ln in lines) * 1.1 > 1.25 * W or px * len(lines) * 1.4 > 1.25 * H:
            tw, th = _text_px(text, font_name, max(4, px))
            fit = min(1.0, 1.25 * W / max(1, tw), 1.25 * H / max(1, th))
            if fit < 1.0:
                px, sw = max(4, int(px * fit)), int(round(sw * fit))
        f = font(font_name, px)
        q = self.p((x, y))
        fill = rgba(col, alpha)
        stroke_c = rgba(stroke, alpha) if stroke is not None else None
        mixed = needs_fallback(text, font_name)
        if not rot and alpha >= 0.999 and fill[3] >= 255 and not mixed:
            if "\n" in text:
                self._multiline(q, text, f, fill, anchor, sw, stroke_c)
            else:
                self.d.text(q, text, font=f, fill=fill, anchor=anchor, stroke_width=sw, stroke_fill=stroke_c)
            return
        # rotated / translucent text, or text that needs other fonts: draw it on its own layer first
        if mixed:
            layer = _run_layer(text, font_name, max(4, px), rgba(col), sw, rgba(stroke) if stroke is not None else None)
            if alpha < 0.999:
                layer.putalpha(layer.getchannel("A").point(lambda v: int(v * max(0.0, alpha))))
        else:
            box = self.d.multiline_textbbox((0, 0), text, font=f, stroke_width=sw, align="center")
            w, h = int(box[2] - box[0]) + 8, int(box[3] - box[1]) + 8
            layer = Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0))
            ImageDraw.Draw(layer).multiline_text((4 - box[0], 4 - box[1]), text, font=f, fill=fill, stroke_width=sw, stroke_fill=stroke_c, align="center")
        if rot:
            layer = layer.rotate(-rot, expand=True, resample=Image.BICUBIC)
        ax = {"l": 0.0, "m": 0.5, "r": 1.0}.get(anchor[0], 0.5)
        ay = {"t": 0.0, "m": 0.5, "b": 1.0}.get(anchor[1], 0.5)
        pos = (int(q[0] - layer.width * ax), int(q[1] - layer.height * ay))
        if self.img.mode == "RGBA":
            self.img.alpha_composite(layer, (max(0, pos[0]), max(0, pos[1])), (max(0, -pos[0]), max(0, -pos[1])))
        else:
            self.img.paste(layer, pos, layer)

    def _multiline(self, q, text, f, fill, anchor, sw, stroke_c) -> None:
        box = self.d.multiline_textbbox((0, 0), text, font=f, stroke_width=sw, align="center")
        w, h = box[2] - box[0], box[3] - box[1]
        ax = {"l": 0.0, "m": 0.5, "r": 1.0}.get(anchor[0], 0.5)
        ay = {"t": 0.0, "m": 0.5, "b": 1.0}.get(anchor[1], 0.5)
        self.d.multiline_text((q[0] - w * ax - box[0], q[1] - h * ay - box[1]), text, font=f, fill=fill, stroke_width=sw, stroke_fill=stroke_c, align="center")

    def text_size(self, s: str, size: float, font_name: str = "bold") -> tuple[float, float]:
        k = self.k or 1.0
        w, h = _text_px(str(s), font_name, int(round(self.s(size))))
        return (w / k, h / k)


@lru_cache(maxsize=4096)
def _text_px(text: str, kind: str, px: int) -> tuple[int, int]:
    """Width and height of a text in pixels (in several fonts when the scene font lacks characters)."""
    if needs_fallback(text, kind):
        _, width, height, _, _ = _run_lay(text, kind, max(4, px), 0)      # measured, not drawn
        return (max(1, width) - 4, max(1, height) - 4)
    box = _MEASURE.multiline_textbbox((0, 0), text, font=font(kind, px), align="center")
    return (box[2] - box[0], box[3] - box[1])


_MEASURE = ImageDraw.Draw(Image.new("L", (1, 1)))


@lru_cache(maxsize=64)
def _glow_sprite(rr: int, col: tuple, alpha: int) -> Image.Image:
    import numpy as np

    y, x = np.mgrid[-rr:rr + 1, -rr:rr + 1]
    d = np.sqrt(x * x + y * y) / rr
    a = np.clip(1 - d, 0, 1) ** 1.4 * alpha
    out = np.zeros((2 * rr + 1, 2 * rr + 1, 4), np.uint8)
    out[..., :3] = col
    out[..., 3] = a.astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def wrap_lines(c: Canvas, text: str, size: float, max_w: float, font_name: str = "bold") -> list[str]:
    """The text broken into lines no wider than max_w (world units of the canvas). Breaks at spaces;
    a word longer than a line (a URL, Chinese without spaces) is broken between characters."""
    return list(_wrap(str(text), font_name, int(round(c.s(size))), max(8, int(c.s(max_w)))))


@lru_cache(maxsize=1024)
def _wrap(text: str, kind: str, px: int, max_px: int) -> tuple:
    def fits(s: str) -> bool:
        return _text_px(s, kind, px)[0] <= max_px

    out: list[str] = []
    for para in text.split("\n"):
        words = para.split()
        if not words:
            out.append("")
            continue
        cur = ""
        for wd in words:
            trial = f"{cur} {wd}" if cur else wd
            if fits(trial):
                cur = trial
                continue
            if cur:
                out.append(cur)
                cur = ""
            while len(wd) > 1 and not fits(wd):
                lo, hi = 1, len(wd) - 1                    # the longest start of the word that fits
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if fits(wd[:mid]):
                        lo = mid
                    else:
                        hi = mid - 1
                out.append(wd[:lo])
                wd = wd[lo:]
            cur = wd
        if cur:
            out.append(cur)
    return tuple(out)


# ---------------------------------------------------------------------------
# The stick figure
# ---------------------------------------------------------------------------
def _chain(c: Canvas, pts, width: float, col, dark, outline: bool) -> None:
    if outline:
        c.polyline(pts, width + 2.8, dark)
    c.polyline(pts, width, col)


def _shoe(c: Canvas, foot, knee, f: int, col, dark, w: float, outline: bool) -> None:
    # a short foot pointing the way the figure faces, turned with the shin
    dx, dy = foot[0] - knee[0], foot[1] - knee[1]
    n = math.hypot(dx, dy) or 1.0
    # across the shin, towards the toes: the shin direction turned a quarter towards the facing side
    # (a straight shin gives toes pointing forward; a foot ahead of the knee lifts its toes a little)
    px, py = dy / n * f, -dx / n * f
    if py > 0.75:                               # the leg points sideways: keep the toes off the ground line
        px, py = f * 0.9, 0.3
    toe = (foot[0] + px * w * 1.45, foot[1] + py * w * 1.45)
    _chain(c, [foot, toe], w * 0.95, col, dark, outline)


def draw_face(c: Canvas, r: float, expr: str, look: str, col, eye_col=None, mouth: float = 0.0) -> None:
    """Face in the head's own coordinates: +x = the way it looks, -y = up; r = head radius.
    eye_col: colour of the eye dots (figure option `eyes`); mouth: 0 (closed) … 1 (wide open) while speaking."""
    if expr == "none":
        return
    lx, ly = {"fwd": (0.0, 0.0), "back": (-0.3, 0.0), "up": (0.0, -0.2), "down": (0.0, 0.2), "camera": (-0.22, 0.0)}.get(look, (0.0, 0.0))
    spread = 0.26 if look == "camera" else 0.2
    eyes = [(r * (0.34 - spread + lx), r * (-0.14 + ly)), (r * (0.34 + spread + lx), r * (-0.14 + ly))]
    e = r * 0.11
    w = max(1.0, r * 0.1)                       # strokes that still read at 720p
    dot = eye_col if eye_col is not None else col
    mx, my = r * (0.36 + lx), r * (0.42 + ly * 0.5)
    for i, (ex, ey) in enumerate(eyes):
        size = e * (0.82 if i == 0 else 1.0)    # the far eye is a touch smaller
        inner = 1 if i == 0 else -1             # the side towards the other eye (the far eye's is forward)
        if expr in ("happy",):
            c.arc((ex, ey + size * 0.6), size * 1.25, 200, 340, w, col, 8)
        elif expr == "sleepy":
            # half-closed: the lid straight across, the lower half of the eye under it
            c.line((ex - size * 1.25, ey), (ex + size * 1.25, ey), w, col)
            c.poly([(ex + size * math.cos(math.radians(a)), ey + size * 0.9 * math.sin(math.radians(a))) for a in range(0, 181, 30)], fill=dot)
        elif expr in ("focus", "smirk") and not (expr == "smirk" and i == 1):
            c.line((ex - size * 1.2, ey), (ex + size * 1.2, ey), w, col)
        elif expr == "ko":
            c.line((ex - size, ey - size), (ex + size, ey + size), w, col)
            c.line((ex - size, ey + size), (ex + size, ey - size), w, col)
        elif expr == "hurt":
            c.line((ex - size * 1.1, ey - size * 0.9), (ex + size * 0.9, ey), w, col)
            c.line((ex - size * 1.1, ey + size * 0.9), (ex + size * 0.9, ey), w, col)
        elif expr in ("surprised", "scared"):
            c.circle((ex, ey), size * 1.5, fill=None, outline=col, width=w)
            c.circle((ex, ey), size * 0.6, fill=dot)
        else:
            c.circle((ex, ey), size, fill=dot)
        # brows mirror each other: angry = a V (inner ends down), sad / scared = the other way round
        if expr == "angry":
            c.line((ex - inner * size * 1.6, ey - size * 2.7), (ex + inner * size * 1.5, ey - size * 1.4), w * 1.2, col)
        elif expr in ("sad", "scared"):
            c.line((ex - inner * size * 1.6, ey - size * 1.5), (ex + inner * size * 1.5, ey - size * 2.7), w * 1.1, col)
        elif expr == "focus":
            c.line((ex - size * 1.4, ey - size * 2.0), (ex + size * 1.4, ey - size * 1.7 - (0.3 * size if inner > 0 else 0)), w * 1.1, col)
    if mouth > 0.08:
        # speaking: the mouth opens and closes with the syllables
        c.ellipse((mx, my + r * 0.02), r * (0.12 + 0.05 * mouth), r * (0.05 + 0.15 * mouth), fill=col, n=14)
    elif expr in ("happy",):
        c.arc((mx, my - r * 0.18), r * 0.3, 25, 155, w, col, 10)
    elif expr in ("angry", "sad"):
        c.arc((mx, my + r * 0.22), r * 0.26, 205, 335, w, col, 10)
    elif expr in ("surprised", "scared", "hurt", "ko"):
        c.ellipse((mx, my), r * (0.13 if expr != "hurt" else 0.2), r * (0.17 if expr != "ko" else 0.1), fill=col, n=12)
    elif expr == "smirk":
        c.line((mx - r * 0.2, my + r * 0.04), (mx + r * 0.22, my - r * 0.1), w, col)
    else:
        c.line((mx - r * 0.18, my), (mx + r * 0.18, my), w, col)


def draw_figure(c: Canvas, fig, st: dict, P: dict, style: dict, floor: float, held: dict | None = None, alpha: float = 1.0) -> None:
    """Draws one figure. `held`: {"R": [fn(canvas)], "L": [...]} — props in the hands."""
    f = P["_face"]
    s = P["_scale"]
    col = rgba(fig.color, alpha)
    # the outline separates the figure from what is behind it: a dark figure gets a light edge only on dark
    # scenery (the renderer measures it: st["_bg_lum"]); on a light wall a grey edge just made grey seams
    bg_lum = st.get("_bg_lum")
    light_edge = luminance(fig.color) <= 60 and (bg_lum is None or bg_lum < 110)
    dark_base = fig.outline if fig.outline else ((150, 155, 170) if light_edge else (10, 10, 14))
    dark = rgba(dark_base, alpha)
    shoes = fig.extras.get("shoes")
    shoe_col = rgba(shoes, alpha) if shoes not in (None, False, True) else None
    far = rgba(shade(fig.color, -14 if luminance(fig.color) > 40 else 22), alpha)
    hi = rgba(mix(fig.color, (255, 255, 255), 0.45), alpha * 0.55)
    outline = bool(style.get("outline", True))
    w = fig.line * s
    held = held or {}

    if style.get("shadow", True) and alpha > 0.5:
        lowest = max(P["Rfoot"][1], P["Lfoot"][1], P["hip"][1])
        height = max(0.0, floor - 5 * s - lowest)
        k = max(0.3, 1 - height / (300 * s))
        for i in range(3):
            c.ellipse((P["hip"][0], floor - 1), (46 + i * 9) * s * k, (6 + i * 2) * s * k, fill=(0, 0, 0, 30), n=20)

    # far leg, far arm
    _chain(c, [P["hip"], P["Lknee"], P["Lfoot"]], w, far, dark, outline)
    _shoe(c, P["Lfoot"], P["Lknee"], f, shade(shoe_col, -18) if shoe_col else far, dark, w * (1.15 if shoe_col else 1.0), outline)
    _chain(c, [P["sho"], P["Lelb"], P["Lhand"]], w * 0.9, far, dark, outline)
    for fn in held.get("L", []):
        fn(c)
    c.circle(P["Lhand"], w * 0.62, fill=far, outline=dark if outline else None, width=1.3 * s)

    cape = fig.extras.get("cape")
    if cape:
        cc = rgba(cape if isinstance(cape, (str, list, tuple)) and cape is not True else "#b0303a", alpha)
        sway = math.sin(st.get("_t", 0.0) * 3.1) * 8 * s
        back = (-f * 34 * s + sway, 0)
        c.poly([P["neck"], (P["sho"][0] + back[0] * 0.5, P["sho"][1] + 10 * s), (P["hip"][0] + back[0] * 1.5, P["hip"][1] + 26 * s),
                (P["hip"][0] + back[0] * 0.4, P["hip"][1] + 8 * s)], fill=cc, outline=dark if outline else None, width=1.4 * s)

    # torso
    _chain(c, [P["hip"], P["neck"]], w * 1.4, col, dark, outline)
    if style.get("highlight", True):
        c.line((P["hip"][0] - 1.6 * s, P["hip"][1] - 2 * s), (P["neck"][0] - 1.6 * s, P["neck"][1] - 2 * s), w * 0.35, hi)
    tx, ty = P["neck"][0] - P["hip"][0], P["neck"][1] - P["hip"][1]
    tl = math.hypot(tx, ty) or 1.0
    nx, ny = -ty / tl * f, tx / tl * f            # across the torso, towards the chest

    def on_torso(u: float, forward: float = 0.0):
        return (P["hip"][0] + tx * u + nx * forward * s, P["hip"][1] + ty * u + ny * forward * s)

    if fig.extras.get("belt"):
        b = on_torso(0.06)
        c.line((b[0] - w * 0.75, b[1]), (b[0] + w * 0.75, b[1]), w * 0.5, rgba(fig.extras["belt"] if fig.extras["belt"] is not True else "#c8aa3c", alpha))
    if fig.extras.get("scarf"):
        sc = rgba(fig.extras["scarf"] if fig.extras["scarf"] is not True else "#d94f4f", alpha)
        n = P["neck"]
        c.line((n[0] - w * 0.8, n[1] + 3 * s), (n[0] + w * 0.8, n[1] + 3 * s), w * 0.7, sc)
        c.line((n[0] - f * w * 0.5, n[1] + 4 * s), (n[0] - f * (w * 0.5 + 16 * s), n[1] + 20 * s + math.sin(st.get("_t", 0.0) * 4) * 4 * s), w * 0.55, sc)

    # head
    r = P["_head_r"]
    head = P["head"]
    skin = fig.extras.get("skin")
    # `skin: true` is the default skin tone (the palette colour "skin"), like `hair: true` is a default brown
    hcol = rgba("skin" if skin is True else skin, alpha) if skin else col
    if outline:
        c.circle(head, r + 1.4 * s, fill=dark)
    c.circle(head, r, fill=hcol)
    if style.get("highlight", True):
        c.arc(head, r * 0.72, 205, 290, max(1.5, r * 0.14), hi, 8)
    ang = (st["T"] + st["H"] + st.get("rot", 0)) * f
    hc = c.at(head, angle=ang, flip=f)
    face_col = rgba((245, 245, 245) if luminance(hcol) < 120 else (20, 20, 26), alpha)
    hair = fig.extras.get("hair")
    if hair:
        hcl = rgba(hair if hair is not True else "#3a2a1a", alpha)
        pts = [(r * math.cos(math.radians(a)), r * math.sin(math.radians(a))) for a in range(170, 335, 15)]
        pts += [(r * 0.75, -r * 0.55), (r * 0.2, -r * 0.5), (-r * 0.5, -r * 0.2)]
        hc.poly(pts, fill=hcl)
    if style.get("faces", True):
        eyes = fig.extras.get("eyes")
        draw_face(hc, r, st.get("expr", "calm"), st.get("look", "fwd"), face_col,
                  rgba(eyes, alpha) if eyes not in (None, False, True) else None, float(st.get("_mouth", 0.0) or 0.0))
    if fig.extras.get("glasses"):
        gc = rgba(fig.extras["glasses"] if fig.extras["glasses"] is not True else ((240, 240, 240) if luminance(hcol) < 120 else (20, 20, 26)), alpha)
        for ex in (0.14, 0.54):
            hc.circle((r * ex, -r * 0.14), r * 0.2, fill=None, outline=gc, width=max(1.0, r * 0.07))
        hc.line((r * 0.34, -r * 0.14), (r * 0.36, -r * 0.14), max(1.0, r * 0.07), gc)
        hc.line((r * -0.06, -r * 0.14), (-r * 0.9, -r * 0.2), max(1.0, r * 0.07), gc)
    hat = fig.extras.get("hat")
    if hat:
        kind, hcol2 = (hat, None) if isinstance(hat, str) else (hat.get("kind", "cap"), hat.get("color")) if isinstance(hat, dict) else ("cap", None)
        _hat(hc, r, str(kind), rgba(hcol2, alpha) if hcol2 else None, dark, alpha)

    # near leg, near arm
    _chain(c, [P["hip"], P["Rknee"], P["Rfoot"]], w, col, dark, outline)
    if style.get("highlight", True):
        c.line((P["hip"][0] - 1.4 * s, P["hip"][1] - 1.6 * s), (P["Rknee"][0] - 1.4 * s, P["Rknee"][1] - 1.6 * s), w * 0.3, hi)
    _shoe(c, P["Rfoot"], P["Rknee"], f, shoe_col or col, dark, w * (1.15 if shoe_col else 1.0), outline)
    _chain(c, [P["sho"], P["Relb"], P["Rhand"]], w * 0.9, col, dark, outline)
    if style.get("highlight", True):
        c.line((P["sho"][0] - 1.4 * s, P["sho"][1] - 1.6 * s), (P["Relb"][0] - 1.4 * s, P["Relb"][1] - 1.6 * s), w * 0.28, hi)
    # tie and badge sit on the front of the chest, drawn over the near arm (under it they were hidden:
    # a tie changed 1 pixel of the standing figure)
    edge = rgba(shade(dark_base, 0), alpha * 0.9)
    if fig.extras.get("tie"):
        tc = rgba(fig.extras["tie"] if fig.extras["tie"] is not True else "#c0392b", alpha)
        def across(p, d):                         # a point d px across the torso from p
            return (p[0] + nx * d, p[1] + ny * d)

        k0, k1 = on_torso(0.97, 5.5), on_torso(0.87, 5.5)
        tip, mid = on_torso(0.4, 6.5), on_torso(0.62, 6.5)
        kn, bl = 3.4 * s, 4.4 * s
        c.poly([across(k0, -kn), across(k0, kn), across(k1, kn * 0.7), across(k1, -kn * 0.7)], fill=tc, outline=edge, width=1.0 * s)
        c.poly([across(k1, -kn * 0.6), across(k1, kn * 0.6), across(mid, bl), across(tip, 0), across(mid, -bl)], fill=tc, outline=edge, width=1.0 * s)
    if fig.extras.get("badge"):
        m = on_torso(0.7, 6)
        star = []
        for i in range(10):
            rr = (7.5 if i % 2 == 0 else 3.3) * s
            a = math.radians(-90 + i * 36)
            star.append((m[0] + rr * math.cos(a), m[1] + rr * math.sin(a)))
        c.poly(star, fill=rgba("#f0c83c", alpha), outline=rgba("#785a0a", alpha), width=1.0 * s)
    for fn in held.get("R", []):
        fn(c)
    c.circle(P["Rhand"], w * 0.66, fill=col, outline=dark if outline else None, width=1.3 * s)

    if fig.label:
        c.text(str(fig.label), head[0], head[1] - r - 16 * s, 17 * s, "#ffffff", "mb", "bold", stroke="#000000", stroke_width=2.2 * s, alpha=alpha)


def _hat(hc: Canvas, r: float, kind: str, col, dark, alpha: float) -> None:
    if kind == "cap":
        cc = col or rgba("#c0392b", alpha)
        pts = [(r * 1.02 * math.cos(math.radians(a)), r * 1.02 * math.sin(math.radians(a))) for a in range(185, 361, 12)]
        hc.poly(pts, fill=cc, outline=dark, width=1.2)
        hc.poly([(r * 0.9, -r * 0.08), (r * 1.75, r * 0.02), (r * 1.7, r * 0.2), (r * 0.9, r * 0.1)], fill=cc, outline=dark, width=1.2)
    elif kind == "tophat":
        cc = col or rgba("#1a1a1f", alpha)
        hc.rect(-r * 1.25, -r * 0.92, r * 2.5, r * 0.2, fill=cc, outline=dark, width=1.2)
        hc.rect(-r * 0.78, -r * 2.2, r * 1.56, r * 1.32, fill=cc, outline=dark, width=1.2)
        hc.rect(-r * 0.78, -r * 1.22, r * 1.56, r * 0.2, fill=rgba("#a03040", alpha))
    elif kind == "crown":
        cc = col or rgba("#f0c83c", alpha)
        hc.poly([(-r * 0.85, -r * 0.7), (-r * 0.85, -r * 1.55), (-r * 0.4, -r * 1.1), (0, -r * 1.7), (r * 0.4, -r * 1.1), (r * 0.85, -r * 1.55), (r * 0.85, -r * 0.7)],
                fill=cc, outline=dark, width=1.2)
    elif kind == "headband":
        cc = col or rgba("#d83a3a", alpha)
        hc.rect(-r * 1.02, -r * 0.62, r * 2.04, r * 0.3, fill=cc)
        hc.line((-r * 1.0, -r * 0.46), (-r * 1.7, -r * 0.2), r * 0.16, cc)
        hc.line((-r * 1.0, -r * 0.46), (-r * 1.6, -r * 0.7), r * 0.16, cc)
    elif kind == "helmet":
        cc = col or rgba("#6f7786", alpha)
        pts = [(r * 1.12 * math.cos(math.radians(a)), r * 1.12 * math.sin(math.radians(a))) for a in range(165, 376, 12)]
        hc.poly(pts, fill=cc, outline=dark, width=1.4)
        hc.rect(r * 0.2, -r * 0.3, r * 0.95, r * 0.2, fill=rgba("#20242c", alpha))
    elif kind == "beanie":
        cc = col or rgba("#3d6fb8", alpha)
        pts = [(r * 1.04 * math.cos(math.radians(a)), r * 1.04 * math.sin(math.radians(a))) for a in range(190, 351, 12)]
        hc.poly(pts, fill=cc, outline=dark, width=1.2)
        hc.circle((0, -r * 1.15), r * 0.24, fill=cc, outline=dark, width=1.2)
    elif kind == "horns":
        cc = col or rgba("#d8d0c0", alpha)
        for sx in (-1, 1):
            hc.poly([(sx * r * 0.45, -r * 0.82), (sx * r * 1.0, -r * 1.7), (sx * r * 0.85, -r * 0.6)], fill=cc, outline=dark, width=1.0)


HATS = ["cap", "tophat", "crown", "headband", "helmet", "beanie", "horns"]


def bubble_layout(c: Canvas, text: str, size: float, max_w: float) -> dict:
    """Size of a speech bubble (world units of the canvas): the wrapped text and the box around it."""
    lines = wrap_lines(c, str(text), size, max_w, "bold")
    body = "\n".join(lines) or " "
    tw, th = c.text_size(body, size, "bold")
    pad = size * 0.55
    return {"body": body, "size": size, "w": tw + pad * 2, "h": th + pad * 2 + size * 0.2, "tail": size * 0.9}


def draw_bubble(c: Canvas, lay: dict, bx: float, by: float, x: float, y: float, col, bubble, alpha: float = 1.0) -> None:
    """The bubble with its top-left corner at (bx, by) and its tail pointing at (x, y): from the bottom or
    top edge, or from the side when the point is beside the bubble (none when it is inside). A far-away
    point (a speaker off screen) gets a short tail towards it."""
    size, bw, bh = lay["size"], lay["w"], lay["h"]
    ink = rgba("#101014", alpha)
    fill = rgba(bubble, alpha)
    c.rect(bx + 3, by + 4, bw, bh, fill=(0, 0, 0, int(70 * alpha)), radius=size * 0.6)
    c.rect(bx, by, bw, bh, fill=fill, outline=ink, width=2.2, radius=size * 0.6)
    half = size * 0.35
    if y > by + bh or y < by:
        below = y > by + bh
        edge = by + bh - 1.5 if below else by + 1.5
        lo, hi = bx + size * 0.6 + half, bx + bw - size * 0.6 - half
        base = min(max(x, lo), hi) if hi > lo else bx + bw / 2
        reach = math.hypot(x - base, y - edge)
        longest = size * 3.2
        if reach > longest:
            k = longest / reach
            x, y = base + (x - base) * k, edge + (y - edge) * k
        c.poly([(base - half, edge), (base + half, edge), (x, y)], fill=fill)
        c.line((base - half, edge + (1.5 if below else -1.5)), (x, y), 2.2, ink)
        c.line((base + half, edge + (1.5 if below else -1.5)), (x, y), 2.2, ink)
    elif x < bx or x > bx + bw:
        # a bubble beside its speaker's head: the tail comes out of the side
        right = x > bx + bw
        edge = bx + bw - 1.5 if right else bx + 1.5
        lo, hi = by + size * 0.6 + half, by + bh - size * 0.6 - half
        base = min(max(y, lo), hi) if hi > lo else by + bh / 2
        reach = math.hypot(x - edge, y - base)
        longest = size * 2.2
        if reach > longest:
            k = longest / reach
            x, y = edge + (x - edge) * k, base + (y - base) * k
        c.poly([(edge, base - half), (edge, base + half), (x, y)], fill=fill)
        c.line((edge + (1.5 if right else -1.5), base - half), (x, y), 2.2, ink)
        c.line((edge + (1.5 if right else -1.5), base + half), (x, y), 2.2, ink)
    if alpha > 0.004:            # the text fades with its bubble (it showed alone on the bubble's first frame)
        c.text(lay["body"], bx + bw / 2, by + bh / 2, size, col, "mm", "bold", alpha=alpha)


def speech_bubble(c: Canvas, text: str, x: float, y: float, size: float, col, bubble, max_w: float, alpha: float = 1.0, side: int = 1) -> None:
    """A speech bubble whose tail points at (x, y) from above."""
    lay = bubble_layout(c, text, size, max_w)
    bx = x - lay["w"] / 2 + side * lay["w"] * 0.18
    by = y - lay["h"] - lay["tail"]
    draw_bubble(c, lay, bx, by, x, y, col, bubble, alpha)
