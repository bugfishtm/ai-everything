"""Built-in transitions and generators.

Transition: fn(a, b, u, p) -> picture   (a = old clip, b = new clip, RGB, same size; u: 0 → 1)
Generator:  fn(t, w, h, p) -> picture   (t = seconds since the clip began)
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .api import generator, transition

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
import studio_gfx as gfx  # noqa: E402


def _ease(u: float) -> float:
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


@transition("cut", doc="no transition: the new clip simply starts")
def cut(a, b, u, p):
    return b if u >= 0.5 else a


@transition("crossfade", doc="the old clip dissolves into the new one")
def crossfade(a, b, u, p):
    return Image.blend(a, b, min(1.0, max(0.0, u)))


@transition("fade", params={"color": "#000000"}, doc="through a color: the old clip fades out, the new one fades in")
def fade(a, b, u, p):
    c = Image.new("RGB", a.size, gfx.color(p["color"])[:3])
    return Image.blend(a, c, min(1.0, u * 2)) if u < 0.5 else Image.blend(c, b, min(1.0, (u - 0.5) * 2))


@transition("flash", doc="a white flash between the clips (hits, beats)")
def flash(a, b, u, p):
    return fade(a, b, u, {"color": "#ffffff"})


def _slide(a, b, u, dx: int, dy: int, push: bool):
    w, h = a.size
    e = _ease(u)
    out = a.copy() if not push else Image.new("RGB", a.size)
    if push:
        out.paste(a, (int(-dx * w * e), int(-dy * h * e)))
    out.paste(b, (int(dx * w * (1 - e)), int(dy * h * (1 - e))))
    return out


for _name, _dx, _dy in (("left", 1, 0), ("right", -1, 0), ("up", 0, 1), ("down", 0, -1)):
    def _make(dx=_dx, dy=_dy):
        def slide(a, b, u, p):
            return _slide(a, b, u, dx, dy, False)

        def push(a, b, u, p):
            return _slide(a, b, u, dx, dy, True)

        def wipe(a, b, u, p):
            w, h = a.size
            soft = max(1, int(float(p["soft"]) * (w if dx else h)))
            e = _ease(u) * (1 + soft / (w if dx else h))
            if dx:
                xs = np.arange(w, dtype=np.float32)
                edge = (w - e * w) if dx > 0 else (e * w)
                m = np.clip(((xs - edge) if dx > 0 else (edge - xs)) / soft + 0.5, 0, 1)
                mask = np.tile(m, (h, 1))
            else:
                ys = np.arange(h, dtype=np.float32)
                edge = (h - e * h) if dy > 0 else (e * h)
                m = np.clip(((ys - edge) if dy > 0 else (edge - ys)) / soft + 0.5, 0, 1)
                mask = np.tile(m[:, None], (1, w))
            return Image.composite(b, a, Image.fromarray((mask * 255).astype(np.uint8), "L"))

        return slide, push, wipe

    _s, _p, _w = _make()
    transition(f"slide-{_name}", doc=f"the new clip slides in over the old one, moving {_name}")(_s)
    transition(f"push-{_name}", doc=f"the new clip pushes the old one out, moving {_name}")(_p)
    transition(f"wipe-{_name}", params={"soft": 0.04}, doc=f"an edge moving {_name} reveals the new clip (soft = width of the edge, 0 … 1)")(_w)


@transition("zoom", params={"amount": 0.35}, doc="the old clip zooms in and dissolves into the new one")
def zoom(a, b, u, p):
    w, h = a.size
    e = _ease(u)
    f = 1 + float(p["amount"]) * e
    cw, ch = w / f, h / f
    za = a.crop((int((w - cw) / 2), int((h - ch) / 2), int((w + cw) / 2), int((h + ch) / 2))).resize((w, h), Image.BILINEAR)
    return Image.blend(za, b, e)


@transition("circle", params={"soft": 0.03}, doc="a growing circle opens onto the new clip (iris)")
def circle(a, b, u, p):
    w, h = a.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.hypot(xx - w / 2, yy - h / 2)
    far = math.hypot(w / 2, h / 2)
    soft = max(1.0, float(p["soft"]) * far)
    m = np.clip((_ease(u) * (far + soft) - d) / soft, 0, 1)
    return Image.composite(b, a, Image.fromarray((m * 255).astype(np.uint8), "L"))


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------
@generator("plasma", params={"speed": 1.0, "colors": ["#1b1f3b", "#7c3aed", "#f472b6", "#fde68a"]}, doc="slowly moving color clouds — a background that is never still")
def plasma(t, w, h, p):
    sw, sh = max(8, w // 4), max(8, h // 4)                      # computed small, scaled up: it is soft anyway
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32) / max(sw, sh)
    s = float(p["speed"])
    v = np.sin(xx * 9 + t * s) + np.sin(yy * 7 - t * 1.3 * s) + np.sin((xx + yy) * 5 + t * 0.7 * s) + np.sin(np.hypot(xx - 0.5, yy - 0.3) * 11 - t * s)
    v = (v + 4) / 8
    cols = np.array([gfx.color(c)[:3] for c in p["colors"]], dtype=np.float32)
    pos = np.linspace(0, 1, len(cols))
    rgb = np.stack([np.interp(v, pos, cols[:, ch]) for ch in range(3)], axis=-1)
    return Image.fromarray(rgb.astype(np.uint8), "RGB").resize((w, h), Image.BICUBIC)


@generator("starfield", params={"count": 260, "speed": 0.25, "color": "#ffffff", "background": "#05060d"}, doc="stars flying towards the viewer")
def starfield(t, w, h, p):
    rng = np.random.default_rng(7)
    n = int(p["count"])
    ang, base = rng.random(n) * math.tau, rng.random(n)
    z = (base + t * float(p["speed"])) % 1.0                      # 0 = far (centre) … 1 = close (edge)
    r = z ** 2 * math.hypot(w, h) * 0.6
    x, y = w / 2 + np.cos(ang) * r, h / 2 + np.sin(ang) * r
    img = Image.new("RGB", (w, h), gfx.color(p["background"])[:3])
    d = ImageDraw.Draw(img)
    c = gfx.color(p["color"])[:3]
    for i in range(n):
        s = 0.6 + z[i] * 2.6
        b = min(1.0, 0.25 + z[i])
        d.ellipse([x[i] - s, y[i] - s, x[i] + s, y[i] + s], fill=tuple(int(v * b) for v in c))
    return img


@generator("static", params={"amount": 1.0}, doc="TV static (noise) — glitches, channel changes")
def static(t, w, h, p):
    rng = np.random.default_rng(int(t * 1000) + 1)
    small = rng.integers(0, 256, (max(2, h // 3), max(2, w // 3)), dtype=np.uint8)
    g = Image.fromarray(small, "L").resize((w, h), Image.NEAREST)
    return Image.merge("RGB", (g, g, g))


@generator("countdown", params={"from": 3, "color": "#ffffff", "background": "#0b0d14", "size": 0.5}, doc="3 … 2 … 1: one number per second with a shrinking ring")
def countdown(t, w, h, p):
    n = max(0, int(p["from"]) - int(t))
    frac = t - int(t)
    img = Image.new("RGB", (w, h), gfx.color(p["background"])[:3])
    d = ImageDraw.Draw(img)
    c = gfx.color(p["color"])[:3]
    r = min(w, h) * float(p["size"]) / 2
    d.arc([w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r], -90, -90 + 360 * (1 - frac), fill=c, width=max(3, int(r * 0.06)))
    f = gfx.font("bold", r * 1.1)
    canvas = img.convert("RGBA")
    gfx.draw_text(canvas, str(n) if n > 0 else "GO", (w / 2, h / 2), f, c + (255,), anchor="center", valign="middle")
    return canvas.convert("RGB")
