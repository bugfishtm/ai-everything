"""Procedural textures. Signature: fn(w, h, p, rng) -> array (h, w) with values 0 … 1.

The engine colors the values through the layer's `colors` (two or more, dark → light) and
generates at document resolution. Sizes in `p` are document pixels. Most textures tile
seamlessly (`tile: true`) — good for game and 3D materials.
"""
from __future__ import annotations

import math

import numpy as np

from .api import texture


def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * (3 - 2 * t)


def value_noise(w: int, h: int, cell: float, rng, tile: bool = True) -> np.ndarray:
    """Smooth random values, one lattice point every `cell` pixels."""
    gx, gy = max(1, int(round(w / max(cell, 1e-6)))), max(1, int(round(h / max(cell, 1e-6))))
    grid = rng.random((gy + (0 if tile else 1), gx + (0 if tile else 1)))
    xs = np.arange(w) * gx / w
    ys = np.arange(h) * gy / h
    x0, y0 = np.floor(xs).astype(int), np.floor(ys).astype(int)
    fx, fy = _smooth(xs - x0), _smooth(ys - y0)
    x1 = (x0 + 1) % gx if tile else x0 + 1
    y1 = (y0 + 1) % gy if tile else y0 + 1
    top = grid[y0][:, x0] * (1 - fx) + grid[y0][:, x1] * fx
    bot = grid[y1][:, x0] * (1 - fx) + grid[y1][:, x1] * fx
    return top * (1 - fy)[:, None] + bot * fy[:, None]


def fractal(w: int, h: int, cell: float, octaves: int, rng, tile: bool = True, gain: float = 0.5) -> np.ndarray:
    out = np.zeros((h, w))
    amp, total = 1.0, 0.0
    for _ in range(max(1, int(octaves))):
        out += value_noise(w, h, max(1.0, cell), rng, tile) * amp
        total += amp
        amp *= gain
        cell /= 2
    return out / total


def _contrast(v: np.ndarray, c: float) -> np.ndarray:
    return np.clip((v - 0.5) * c + 0.5, 0, 1)


@texture("noise", params={"scale": 64, "octaves": 4, "contrast": 1.4, "tile": True}, doc="soft fractal noise (scale = size of the biggest blobs in px)")
def noise(w, h, p, rng):
    return _contrast(fractal(w, h, float(p["scale"]), int(p["octaves"]), rng, bool(p["tile"])), float(p["contrast"]))


@texture("clouds", params={"scale": 220, "cover": 0.5, "soft": 0.25, "tile": True}, doc="clouds: cover 0 (few) … 1 (overcast), soft = edge softness")
def clouds(w, h, p, rng):
    v = fractal(w, h, float(p["scale"]), 6, rng, bool(p["tile"]))
    edge = 1 - float(p["cover"])
    s = max(0.01, float(p["soft"]))
    return np.clip((v - (edge - s / 2) * 0.9 - 0.05) / s, 0, 1) ** 1.2


@texture("grain", params={"amount": 1.0}, doc="fine random grain (film grain, sand)")
def grain(w, h, p, rng):
    return np.clip(0.5 + (rng.random((h, w)) - 0.5) * float(p["amount"]), 0, 1)


@texture("marble", params={"scale": 160, "veins": 5.0, "turbulence": 4.0, "tile": True}, doc="marble veins")
def marble(w, h, p, rng):
    n = fractal(w, h, float(p["scale"]), 5, rng, bool(p["tile"]))
    xx = np.arange(w)[None, :] / w
    return 0.5 + 0.5 * np.sin((xx * float(p["veins"]) + n * float(p["turbulence"])) * math.tau)


@texture("wood", params={"rings": 12.0, "scale": 180, "grain": 0.25, "tile": False}, doc="wood: growth rings with a little grain")
def wood(w, h, p, rng):
    n = fractal(w, h, float(p["scale"]), 4, rng, bool(p["tile"]))
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot((xx - w * 0.5) / max(w, h), (yy - h * 1.6) / max(w, h))
    v = 0.5 + 0.5 * np.sin((d * float(p["rings"]) * 4 + n * 2.2) * math.tau)
    fine = value_noise(w, h, 3, rng, False)
    stretch = np.repeat(fine[:, ::8], 8, axis=1)[:, :w] if w >= 8 else fine
    return np.clip(v * (1 - float(p["grain"])) + stretch * float(p["grain"]), 0, 1)


@texture("stripes", params={"width": 24, "angle": 45, "soft": 0.0, "ratio": 0.5}, doc="stripes: width of one pair in px, angle in degrees, ratio = share of the light stripe")
def stripes(w, h, p, rng):
    a = math.radians(float(p["angle"]))
    yy, xx = np.mgrid[0:h, 0:w]
    u = ((xx * math.cos(a) + yy * math.sin(a)) / max(1.0, float(p["width"]))) % 1.0
    r = min(0.99, max(0.01, float(p["ratio"])))
    s = float(p["soft"])
    if s <= 0:
        return (u < r).astype(float)
    # distance to the nearest edge of the light stripe (positive inside it), in stripe-pair units
    d = np.where(u < r, np.minimum(u, r - u), -np.minimum(u - r, 1 - u))
    return np.clip(d / (s * 0.5) + 0.5, 0, 1)


@texture("checker", params={"size": 32}, doc="checkerboard: size of one square in px")
def checker(w, h, p, rng):
    s = max(1, int(p["size"]))
    yy, xx = np.mgrid[0:h, 0:w]
    return ((xx // s + yy // s) % 2).astype(float)


@texture("dots", params={"spacing": 28, "radius": 7, "stagger": True, "soft": 1.0}, doc="a grid of dots (stagger: every second row shifted — halftone look)")
def dots(w, h, p, rng):
    sp = max(2.0, float(p["spacing"]))
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    row = np.floor(yy / sp)
    x = xx + (sp / 2 if p["stagger"] else 0) * (row % 2)
    dx = (x % sp) - sp / 2
    dy = (yy % sp) - sp / 2
    return np.clip((float(p["radius"]) - np.hypot(dx, dy)) / max(0.01, float(p["soft"])) + 0.5, 0, 1)


@texture("grid", params={"spacing": 40, "width": 2}, doc="grid lines: spacing and line width in px")
def grid(w, h, p, rng):
    sp, lw = max(2, int(p["spacing"])), max(1, int(p["width"]))
    yy, xx = np.mgrid[0:h, 0:w]
    return ((xx % sp < lw) | (yy % sp < lw)).astype(float)


@texture("bricks", params={"width": 64, "height": 28, "mortar": 4, "vary": 0.25}, doc="a brick wall: values vary per brick, mortar is 0")
def bricks(w, h, p, rng):
    bw, bh, m = max(4, int(p["width"])), max(4, int(p["height"])), max(0, int(p["mortar"]))
    yy, xx = np.mgrid[0:h, 0:w]
    row = yy // bh
    x = xx + (bw // 2) * (row % 2)
    col = x // bw
    shade = rng.random((h // bh + 2, w // bw + 3))
    v = 1 - float(p["vary"]) * shade[row % shade.shape[0], col % shade.shape[1]]
    mortar = ((x % bw) < m) | ((yy % bh) < m)
    return np.where(mortar, 0.0, v)


@texture("cells", params={"count": 40, "edges": False, "tile": True}, doc="cells (stone, scales, cracked ground): distance to the nearest of `count` random points; edges: draw the borders")
def cells(w, h, p, rng):
    from scipy.spatial import cKDTree

    n = max(2, int(p["count"]))
    pts = rng.random((n, 2)) * [w, h]
    if p["tile"]:
        pts = np.concatenate([pts + [dx * w, dy * h] for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    yy, xx = np.mgrid[0:h, 0:w]
    d, _ = cKDTree(pts).query(np.stack([xx.ravel(), yy.ravel()], axis=1), k=2)
    d1, d2 = d[:, 0].reshape(h, w), d[:, 1].reshape(h, w)
    if p["edges"]:
        return np.clip((d2 - d1) / max(1.0, math.sqrt(w * h / n) * 0.12), 0, 1)
    return np.clip(d1 / max(1.0, math.sqrt(w * h / n) * 0.75), 0, 1)


@texture("stars", params={"count": 300, "size": 1.6, "glow": 0.0}, doc="a starry sky: random points of different brightness")
def stars(w, h, p, rng):
    from scipy.ndimage import gaussian_filter

    out = np.zeros((h, w))
    n = max(1, int(p["count"]))
    xs, ys = rng.integers(0, w, n), rng.integers(0, h, n)
    out[ys, xs] = rng.random(n) ** 2 * 0.9 + 0.1
    s = max(0.3, float(p["size"]) / 2)
    sharp = gaussian_filter(out, s, mode="wrap")
    sharp = sharp / (sharp.max() or 1.0)
    if float(p["glow"]) > 0:
        g = gaussian_filter(out, s * 5, mode="wrap")
        sharp = np.clip(sharp + g / (g.max() or 1.0) * float(p["glow"]), 0, 1)
    return np.clip(sharp * 1.6, 0, 1)


@texture("waves", params={"length": 80, "angle": 0, "wobble": 0.4, "scale": 140, "tile": True}, doc="soft waves (water, fabric): wavelength in px, wobble bends them")
def waves(w, h, p, rng):
    n = fractal(w, h, float(p["scale"]), 3, rng, bool(p["tile"]))
    a = math.radians(float(p["angle"]) + 90)
    yy, xx = np.mgrid[0:h, 0:w]
    u = (xx * math.cos(a) + yy * math.sin(a)) / max(1.0, float(p["length"]))
    return 0.5 + 0.5 * np.sin((u + n * float(p["wobble"]) * 3) * math.tau)


@texture("rays", params={"count": 16, "center": [0.5, 0.5], "soft": 0.1, "twist": 0.0}, doc="rays from a point (sunburst); center as fractions of the area")
def rays(w, h, p, rng):
    cx, cy = float(p["center"][0]) * w, float(p["center"][1]) * h
    yy, xx = np.mgrid[0:h, 0:w]
    ang = np.arctan2(yy - cy, xx - cx) + np.hypot(xx - cx, yy - cy) / max(w, h) * float(p["twist"]) * math.tau
    u = (ang / math.tau * max(1, int(p["count"]))) % 1.0
    s = max(0.001, float(p["soft"]))
    return np.clip((0.5 - np.abs(u - 0.5) - 0.25) / s + 0.5, 0, 1)
