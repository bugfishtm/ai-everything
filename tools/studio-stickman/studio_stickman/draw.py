"""Drawing: a Canvas with a world->pixel transform, fonts, and the stick figure itself."""
from __future__ import annotations

import math
import os
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

from .skeleton import color as _color
from .skeleton import luminance, mix, shade

FONT_FILES = {
    "bold": ["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "NotoSans-Bold.ttf", "arialbd.ttf"],
    "regular": ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "NotoSans-Regular.ttf", "arial.ttf"],
    "italic": ["LiberationSans-BoldItalic.ttf", "DejaVuSans-BoldOblique.ttf", "arialbi.ttf"],
    "mono": ["DejaVuSansMono-Bold.ttf", "LiberationMono-Bold.ttf", "consolab.ttf"],
}
FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype/liberation", "/usr/share/fonts/truetype/noto",
             "/usr/share/fonts", "C:/Windows/Fonts", "/System/Library/Fonts", "/Library/Fonts"]


@lru_cache(maxsize=None)
def _font_path(kind: str) -> str | None:
    for name in FONT_FILES.get(kind, FONT_FILES["bold"]):
        for d in FONT_DIRS:
            p = os.path.join(d, name)
            if os.path.exists(p):
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
        f = font(font_name, int(round(self.s(size))))
        q = self.p((x, y))
        sw = int(round(self.s(stroke_width))) if stroke is not None else 0
        fill = rgba(col, alpha)
        stroke_c = rgba(stroke, alpha) if stroke is not None else None
        text = str(s)
        if not rot and alpha >= 0.999:
            if "\n" in text:
                self._multiline(q, text, f, fill, anchor, sw, stroke_c)
            else:
                self.d.text(q, text, font=f, fill=fill, anchor=anchor, stroke_width=sw, stroke_fill=stroke_c)
            return
        # rotated / translucent text: draw it on its own layer first
        box = self.d.multiline_textbbox((0, 0), text, font=f, stroke_width=sw, align="center")
        w, h = int(box[2] - box[0]) + 8, int(box[3] - box[1]) + 8
        layer = Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0))
        ImageDraw.Draw(layer).multiline_text((4 - box[0], 4 - box[1]), text, font=f, fill=fill, stroke_width=sw, stroke_fill=stroke_c, align="center")
        if rot:
            layer = layer.rotate(-rot, expand=True, resample=Image.BICUBIC)
        ax = {"l": 0.0, "m": 0.5, "r": 1.0}.get(anchor[0], 0.5)
        ay = {"t": 0.0, "m": 0.5, "b": 1.0}.get(anchor[1], 0.5)
        self.img.paste(layer, (int(q[0] - layer.width * ax), int(q[1] - layer.height * ay)), layer)

    def _multiline(self, q, text, f, fill, anchor, sw, stroke_c) -> None:
        box = self.d.multiline_textbbox((0, 0), text, font=f, stroke_width=sw, align="center")
        w, h = box[2] - box[0], box[3] - box[1]
        ax = {"l": 0.0, "m": 0.5, "r": 1.0}.get(anchor[0], 0.5)
        ay = {"t": 0.0, "m": 0.5, "b": 1.0}.get(anchor[1], 0.5)
        self.d.multiline_text((q[0] - w * ax - box[0], q[1] - h * ay - box[1]), text, font=f, fill=fill, stroke_width=sw, stroke_fill=stroke_c, align="center")

    def text_size(self, s: str, size: float, font_name: str = "bold") -> tuple[float, float]:
        f = font(font_name, int(round(self.s(size))))
        box = self.d.multiline_textbbox((0, 0), str(s), font=f, align="center")
        k = self.k or 1.0
        return ((box[2] - box[0]) / k, (box[3] - box[1]) / k)


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
    px, py = -dy / n * f, dx / n * f          # across the shin, towards the toes
    if py > 0.75:                               # the leg points sideways: keep the toes off the ground line
        px, py = f * 0.9, 0.3
    toe = (foot[0] + px * w * 1.45, foot[1] + py * w * 1.45)
    _chain(c, [foot, toe], w * 0.95, col, dark, outline)


def draw_face(c: Canvas, r: float, expr: str, look: str, col) -> None:
    """Face in the head's own coordinates: +x = the way it looks, -y = up; r = head radius."""
    if expr == "none":
        return
    lx, ly = {"fwd": (0.0, 0.0), "back": (-0.3, 0.0), "up": (0.0, -0.2), "down": (0.0, 0.2), "camera": (-0.22, 0.0)}.get(look, (0.0, 0.0))
    spread = 0.26 if look == "camera" else 0.2
    eyes = [(r * (0.34 - spread + lx), r * (-0.14 + ly)), (r * (0.34 + spread + lx), r * (-0.14 + ly))]
    e = r * 0.1
    w = max(1.0, r * 0.085)
    mx, my = r * (0.36 + lx), r * (0.42 + ly * 0.5)
    for i, (ex, ey) in enumerate(eyes):
        size = e * (0.82 if i == 0 else 1.0)    # the far eye is a touch smaller
        if expr in ("happy",):
            c.arc((ex, ey + size * 0.6), size * 1.25, 200, 340, w, col, 8)
        elif expr in ("focus", "sleepy", "smirk") and not (expr == "smirk" and i == 1):
            c.line((ex - size * 1.2, ey + (size * 0.5 if expr == "sleepy" else 0)), (ex + size * 1.2, ey + (size * 0.5 if expr == "sleepy" else 0)), w, col)
        elif expr == "ko":
            c.line((ex - size, ey - size), (ex + size, ey + size), w, col)
            c.line((ex - size, ey + size), (ex + size, ey - size), w, col)
        elif expr == "hurt":
            c.line((ex - size * 1.1, ey - size * 0.9), (ex + size * 0.9, ey), w, col)
            c.line((ex - size * 1.1, ey + size * 0.9), (ex + size * 0.9, ey), w, col)
        elif expr in ("surprised", "scared"):
            c.circle((ex, ey), size * 1.5, fill=None, outline=col, width=w)
            c.circle((ex, ey), size * 0.55, fill=col)
        else:
            c.circle((ex, ey), size, fill=col)
        if expr == "angry":
            c.line((ex - size * 1.7, ey - size * 2.6), (ex + size * 1.5, ey - size * 1.3), w * 1.2, col)
        elif expr in ("sad", "scared"):
            c.line((ex - size * 1.5, ey - size * 1.5), (ex + size * 1.7, ey - size * 2.6), w * 1.1, col)
    if expr in ("happy",):
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
    dark_base = fig.outline if fig.outline else ((10, 10, 14) if luminance(fig.color) > 60 else (150, 155, 170))
    dark = rgba(dark_base, alpha)
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
    _shoe(c, P["Lfoot"], P["Lknee"], f, far, dark, w, outline)
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

    def on_torso(u: float, forward: float = 0.0):
        return (P["hip"][0] + tx * u + f * forward * s, P["hip"][1] + ty * u)

    if fig.extras.get("belt"):
        b = on_torso(0.06)
        c.line((b[0] - w * 0.75, b[1]), (b[0] + w * 0.75, b[1]), w * 0.5, rgba(fig.extras["belt"] if fig.extras["belt"] is not True else "#c8aa3c", alpha))
    if fig.extras.get("tie"):
        tc = rgba(fig.extras["tie"] if fig.extras["tie"] is not True else "#c0392b", alpha)
        a, b = on_torso(0.96, 4), on_torso(0.5, 5)
        c.poly([a, (b[0] - 4 * s, b[1] - 6 * s), b, (b[0] + 4 * s, b[1] - 6 * s)], fill=tc)
    if fig.extras.get("badge"):
        m = on_torso(0.66, 3)
        star = []
        for i in range(10):
            rr = (6.5 if i % 2 == 0 else 2.9) * s
            a = math.radians(-90 + i * 36)
            star.append((m[0] + rr * math.cos(a), m[1] + rr * math.sin(a)))
        c.poly(star, fill=rgba("#f0c83c", alpha), outline=rgba("#785a0a", alpha), width=0.7 * s)
    if fig.extras.get("scarf"):
        sc = rgba(fig.extras["scarf"] if fig.extras["scarf"] is not True else "#d94f4f", alpha)
        n = P["neck"]
        c.line((n[0] - w * 0.8, n[1] + 3 * s), (n[0] + w * 0.8, n[1] + 3 * s), w * 0.7, sc)
        c.line((n[0] - f * w * 0.5, n[1] + 4 * s), (n[0] - f * (w * 0.5 + 16 * s), n[1] + 20 * s + math.sin(st.get("_t", 0.0) * 4) * 4 * s), w * 0.55, sc)

    # head
    r = P["_head_r"]
    head = P["head"]
    skin = fig.extras.get("skin")
    hcol = rgba(skin, alpha) if skin else col
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
        draw_face(hc, r, st.get("expr", "calm"), st.get("look", "fwd"), face_col)
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
    _shoe(c, P["Rfoot"], P["Rknee"], f, col, dark, w, outline)
    _chain(c, [P["sho"], P["Relb"], P["Rhand"]], w * 0.9, col, dark, outline)
    if style.get("highlight", True):
        c.line((P["sho"][0] - 1.4 * s, P["sho"][1] - 1.6 * s), (P["Relb"][0] - 1.4 * s, P["Relb"][1] - 1.6 * s), w * 0.28, hi)
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


def speech_bubble(c: Canvas, text: str, x: float, y: float, size: float, col, bubble, max_w: float, alpha: float = 1.0, side: int = 1) -> None:
    """A speech bubble whose tail points at (x, y) from above."""
    words = str(text).split()
    lines, cur = [], ""
    for wd in words:
        trial = f"{cur} {wd}".strip()
        if cur and c.text_size(trial, size, "bold")[0] > max_w:
            lines.append(cur)
            cur = wd
        else:
            cur = trial
    if cur:
        lines.append(cur)
    body = "\n".join(lines) or " "
    tw, th = c.text_size(body, size, "bold")
    pad = size * 0.55
    bw, bh = tw + pad * 2, th + pad * 2 + size * 0.2
    bx = x - bw / 2 + side * bw * 0.18
    by = y - bh - size * 0.9
    c.rect(bx + 3, by + 4, bw, bh, fill=(0, 0, 0, int(70 * alpha)), radius=size * 0.6)
    c.rect(bx, by, bw, bh, fill=rgba(bubble, alpha), outline=rgba("#101014", alpha), width=2.2, radius=size * 0.6)
    c.poly([(x - size * 0.35 + side * 6, by + bh - 1.5), (x + size * 0.35 + side * 6, by + bh - 1.5), (x, y)], fill=rgba(bubble, alpha))
    c.line((x - size * 0.35 + side * 6, by + bh), (x, y), 2.2, rgba("#101014", alpha))
    c.line((x + size * 0.35 + side * 6, by + bh), (x, y), 2.2, rgba("#101014", alpha))
    c.text(body, bx + bw / 2, by + bh / 2, size, rgba(col, alpha), "mm", "bold")
