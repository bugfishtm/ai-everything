"""Public plugin API of studio-image.

A plugin is a .py file in <project>/plugins/image/ (or a pack item of kind "plugin" with
meta.target = "studio-image"). It registers new things pictures can name:

    from studio_image.api import shape, filter, texture, np, Image, math

    @shape("heart", params={"size": 120}, doc="a heart (at = its centre)")
    def heart(c, p):                      # c: the layer's canvas, p: the layer's options
        x, y = p["at"]
        s = p["size"] / 2
        pts = [(x + s * 16 * math.sin(t) ** 3 / 16, y - s * (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)) / 16)
               for t in (i * math.tau / 80 for i in range(80))]
        c.poly(pts)                       # painted with the layer's fill / stroke (gradients work)

    @filter("scanlines", params={"gap": 3, "strength": 0.35}, doc="dark horizontal lines")
    def scanlines(img, p, k):             # img: RGBA picture, k: pixels per document unit
        a = np.asarray(img).copy()
        a[:: max(2, int(p["gap"] * k)), :, :3] = (a[:: max(2, int(p["gap"] * k)), :, :3] * (1 - p["strength"])).astype("uint8")
        return Image.fromarray(a, "RGBA")

    @texture("rings", params={"count": 8}, doc="concentric rings")
    def rings(w, h, p, rng):              # -> array (h, w) with values 0 … 1 (colored through `colors`)
        yy, xx = np.mgrid[0:h, 0:w]
        return 0.5 + 0.5 * np.sin(np.hypot(xx - w / 2, yy - h / 2) / max(w, h) * p["count"] * math.tau)

Canvas (c) — coordinates in document pixels:
    c.poly(points) · c.rect(x, y, w, h, radius=0) · c.ellipse(cx, cy, rx, ry) · c.line(points, width=None, closed=False)
    c.arc(cx, cy, r, start, end, width=None)        → painted with the layer's fill and stroke
    add fill="#rrggbb" / stroke="#rrggbb", width=3 to any of them to paint that part in its own color
    c.text("…", x, y, size=40, font="bold", fill="#fff", anchor="center")
    c.size (width, height of the document) · c.k (pixels per unit)
"""
from __future__ import annotations

import math  # noqa: F401  (re-exported for plugins)
from typing import Callable

import numpy as np  # noqa: F401  (re-exported for plugins)
from PIL import Image, ImageChops, ImageDraw, ImageFilter  # noqa: F401  (re-exported for plugins)

from .registry import register


def _deco(kind: str, name: str, params: dict | None, doc: str) -> Callable:
    def deco(fn: Callable) -> Callable:
        register(kind, name, fn, params, doc)
        return fn

    return deco


def shape(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(c, p): draw with the canvas — c.poly / c.rect / c.ellipse / c.line / c.arc / c.text."""
    return _deco("shape", name, params, doc)


def filter(name: str, params: dict | None = None, doc: str = "") -> Callable:  # noqa: A001  (the natural name for plugins)
    """fn(img, p, k) -> img: change an RGBA picture (k = pixels per document unit, for sizes in px)."""
    return _deco("filter", name, params, doc)


def texture(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(w, h, p, rng) -> array (h, w) of 0 … 1 (mapped to `colors`) or (h, w, 3|4) of 0 … 255."""
    return _deco("texture", name, params, doc)
