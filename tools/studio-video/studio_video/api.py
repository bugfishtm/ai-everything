"""Public plugin API of studio-video.

A plugin is a .py file in <project>/plugins/video/ (or a pack item of kind "plugin" with
meta.target = "studio-video"). It registers new things timelines can name:

    from studio_video.api import transition, generator, np, Image, math

    @transition("blinds", params={"count": 8}, doc="horizontal blinds open to the new clip")
    def blinds(a, b, u, p):               # a, b: RGB pictures of the old and the new clip; u: 0 → 1
        w, h = a.size
        out = a.copy()
        bar = h / p["count"]
        for i in range(int(p["count"])):
            y0 = int(i * bar)
            out.paste(b.crop((0, y0, w, int(y0 + bar * u))), (0, y0))
        return out

    @generator("plasma", params={"speed": 1.0}, doc="moving color clouds (a background that is never still)")
    def plasma(t, w, h, p):               # t: seconds since the clip began → an RGB picture (or an array h × w × 3)
        yy, xx = np.mgrid[0:h, 0:w] / max(w, h)
        v = np.sin(xx * 9 + t * p["speed"]) + np.sin(yy * 7 - t * 1.3 * p["speed"]) + np.sin((xx + yy) * 5 + t * 0.7)
        rgb = np.stack([127 + 127 * np.sin(v + k) for k in (0, 2, 4)], axis=-1)
        return rgb.astype("uint8")

Use them:   clips: [ { generator: plasma, dur: 4 }, { file: a.mp4, transition: { type: blinds, dur: 0.8 } } ]
"""
from __future__ import annotations

import math  # noqa: F401  (re-exported for plugins)
from typing import Callable

import numpy as np  # noqa: F401  (re-exported for plugins)
from PIL import Image, ImageChops, ImageDraw, ImageFilter  # noqa: F401  (re-exported for plugins)

from .registry import register


def transition(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(a, b, u, p) -> picture: from the old clip (a) to the new one (b) while u runs 0 → 1."""

    def deco(fn: Callable) -> Callable:
        register("transition", name, fn, params, doc)
        return fn

    return deco


def generator(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(t, w, h, p) -> picture: a clip that is computed (t = seconds since it began)."""

    def deco(fn: Callable) -> Callable:
        register("generator", name, fn, params, doc)
        return fn

    return deco
