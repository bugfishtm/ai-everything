"""Rendering: scene + time -> picture; pictures -> video (ffmpeg), contact sheet, sprite sheet."""
from __future__ import annotations

import json
import math
import multiprocessing as mp
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw

from . import registry
from .draw import Canvas, bubble_layout, draw_bubble, draw_figure, missing_glyphs, rgba, speech_bubble, wrap_lines  # noqa: F401
from .scene import Scene
from .skeleton import color, ease, hash01, lerp, luminance, mix

INK = (12, 13, 17)


class RenderError(Exception):
    pass


def _even(v: float) -> int:
    """Video encoders need even pixel sizes: the nearest even number (at least 2)."""
    return max(2, int(round(v / 2)) * 2)


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _noise(t: float, seed: float, axis: int, rate: float = 20.0) -> float:
    """A smooth wobble in [-1, 1]: random values 20 times a second, eased into each other. A camera
    shake made of it looks the same at 15 fps (draft) and 30 fps (final)."""
    u = max(0.0, t) * rate
    i = math.floor(u)
    f = u - i
    a = hash01(i, seed, axis) * 2 - 1
    b = hash01(i + 1, seed, axis) * 2 - 1
    return a + (b - a) * (1 - math.cos(math.pi * f)) / 2


def _syllables(text: str, dur: float, seed: int) -> list[tuple[float, float, float]]:
    """When the speaker's mouth is open while a bubble is shown: (start, end, how wide) per syllable
    (a group of vowels; one per character in scripts without vowel letters, like Chinese), with
    pauses at punctuation — squeezed into the time the bubble is up."""
    out, t = [], 0.0
    vowels = set("aeiouyäöüáéíóúàèìòùâêîôûãõåæøœаеёиоуыэюяіїє")
    prev_vowel = False
    for i, ch in enumerate(text):
        low = ch.lower()
        if low in vowels:
            if not prev_vowel:
                out.append([t, t + 0.1, 0.6 + 0.4 * hash01(seed, i)])
                t += 0.14
            prev_vowel = True
            continue
        prev_vowel = False
        if ch in ".,!?;:…—":
            t += 0.2
        elif ch.isspace():
            t += 0.03
        elif ch.isalpha() and not ch.isascii() and _syllable_char(ch):
            out.append([t, t + 0.12, 0.6 + 0.4 * hash01(seed, i)])
            t += 0.16
    room = max(0.2, dur - 0.25)
    if t > room and t > 0:
        k = room / t
        out = [[a * k, b * k, w] for a, b, w in out]
    return [tuple(s) for s in out]


def _syllable_char(ch: str) -> bool:
    """Letters of scripts where every character is a syllable (CJK, kana, hangul)."""
    o = ord(ch)
    return 0x3040 <= o <= 0x30FF or 0x3400 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF or 0xF900 <= o <= 0xFAFF


def _mouth(syl: list, age: float) -> float:
    for a, b, w in syl:
        if a <= age < b:
            return w * math.sin(math.pi * (age - a) / (b - a))
        if a > age:
            break
    return 0.0


def _gauss(x: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smoothing over `sigma` samples that does not shift the signal in time (the ends are held)."""
    if sigma < 0.5 or len(x) < 3:
        return x
    r = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.concatenate([np.full(r, x[0]), x, np.full(r, x[-1])]), k, mode="valid")


def _crosses(a, b, c, d) -> bool:
    """True when the segments a-b and c-d cross each other."""
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)
    return d1 * d2 < 0 and d3 * d4 < 0


def _overlap(x0: float, y0: float, w0: float, h0: float, x1: float, y1: float, w1: float, h1: float) -> float:
    """The area two rectangles (x, y, w, h) have in common."""
    return max(0.0, min(x0 + w0, x1 + w1) - max(x0, x1)) * max(0.0, min(y0 + h0, y1 + h1) - max(y0, y1))


def _simple(poly: list) -> bool:
    """True when no two edges of the polygon that do not touch each other cross (a ribbon that turns
    over itself drew a bow tie)."""
    n = len(poly)
    edges = [(poly[i], poly[(i + 1) % n]) for i in range(n)]
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if _crosses(*edges[i], *edges[j]):
                return False
    return True


def _one_way(path: list, mid: str, end: str) -> list | None:
    """The end of a smear path in which the hand / foot keeps going one way (each step turns less than
    45 degrees from the one before) and the swept ribbon does not cross itself; None when not even the
    last step is left. A limb that reverses within a frame drew crossed polygons and scribbled lines."""
    ends = [p[end] for p in path]
    steps = [(ends[i + 1][0] - ends[i][0], ends[i + 1][1] - ends[i][1]) for i in range(len(ends) - 1)]
    start = len(steps) - 1
    while start > 0:
        a, b = steps[start - 1], steps[start]
        na, nb = math.hypot(*a), math.hypot(*b)
        if na < 1e-6 or nb < 1e-6 or (a[0] * b[0] + a[1] * b[1]) / (na * nb) < math.cos(math.radians(45)):
            break
        start -= 1
    for first in (start, len(path) - 2):
        sub = path[first:]
        if len(sub) >= 2 and _simple([p[mid] for p in sub] + [p[end] for p in reversed(sub)]):
            return sub
    return None


class Renderer:
    def __init__(self, scene: Scene, ss: int = 2, scale: float = 1.0):
        self.sc = scene
        self.ss = max(1, int(ss))
        self.scale = float(scale)
        # even pixel sizes at any scale (x264 needs them); the aspect stays that of the scene
        self.W = _even(scene.w * self.scale)
        self.H = _even(scene.h * self.scale)
        self.k = self.ss * self.W / scene.w            # work pixels per world unit at zoom 1
        self.size = (self.W * self.ss, self.H * self.ss)
        self.fps = scene.fps                           # the frame rate the frames are for (smear length); render_video sets it
        self.held: dict[str, list] = {}
        for p in scene.props:
            if p.held_by:
                self.held.setdefault(p.held_by, []).append(p)
        self._sample_backdrop()
        self._auto_colors()
        self._expand_events()
        self._setup_camera()
        self._choose_bg_mode()
        self.vignette = self._vignette(float(scene.style.get("vignette") or 0))
        # film grain: a few noise pictures made once and shown in turn (not fresh noise per pixel and frame,
        # which made videos 24 times larger); capped because more only adds noise the encoder cannot keep
        self.grain = min(0.05, max(0.0, float(scene.style.get("grain") or 0)))
        self._grain = self._grain_tiles() if self.grain > 0 else None
        self.smear = bool(scene.style.get("smear", True))
        self._strikes = self._strike_windows()
        self._caption_at: dict = {}
        self._lum_cache: dict = {}
        self._bubbles: dict = {}                       # say index -> its place (see _plan_bubble)
        self._heads: dict = {}                         # (figure, time in 1/600 s) -> the top of its head (bubble tails)

    # -- the scenery ----------------------------------------------------------------
    def _sample_backdrop(self) -> None:
        """A small picture of the whole scenery. Colours are measured on it: figures without a colour,
        outlines and hit sparks are made to stand out from what is behind them."""
        sc = self.sc
        name, params = sc.background
        e = registry.BACKDROPS.get(name)
        if e is None:
            raise RenderError(f'unknown backdrop "{name}"')
        self._bd = (e.fn, name, params)
        self.bgs = min(0.5, 1600 / max(sc.world_w, sc.world_h))
        self.bg = Image.new("RGB", (max(1, round(sc.world_w * self.bgs)), max(1, round(sc.world_h * self.bgs))), (0, 0, 0))
        self._draw_backdrop(self.bg, (self.bgs, 0.0, 0.0, self.bgs, 0.0, 0.0))
        self._bg_np = np.asarray(self.bg, dtype=np.float32)

    def _draw_backdrop(self, img: Image.Image, m: tuple) -> None:
        fn, name, params = self._bd
        sc = self.sc
        try:
            fn(Canvas(img, m), sc.world_w, sc.world_h, sc.floor, params)
        except Exception as e:  # noqa: BLE001
            raise RenderError(f'backdrop "{name}" failed: {type(e).__name__}: {e}') from None

    def bg_luminance(self, x0: float, y0: float, x1: float, y1: float) -> float | None:
        """Mean luminance (0-255) of the scenery in a world rectangle; None when it is outside the scenery."""
        s = self.bgs
        a = self._bg_np
        i0, i1 = int(max(0, y0 * s)), int(min(a.shape[0], y1 * s + 1))
        j0, j1 = int(max(0, x0 * s)), int(min(a.shape[1], x1 * s + 1))
        if i1 <= i0 or j1 <= j0:
            return None
        return luminance(tuple(a[i0:i1, j0:j1].reshape(-1, 3).mean(axis=0)))

    def _auto_colors(self) -> None:
        # figures without a color of their own: dark on light scenery, light on dark scenery
        sc = self.sc
        for f in sc.figures.values():
            if getattr(f, "auto_color", False):
                x = min(max(f.keys[0].x, 0), sc.world_w - 1)
                lum = self.bg_luminance(x - 40, max(0.0, sc.floor - 200 * f.scale), x + 40, sc.floor - 20)
                if lum is not None:
                    f.color = (236, 236, 240) if lum < 95 else (24, 24, 28)

    def _choose_bg_mode(self) -> None:
        """The backdrop is drawn again for every camera position, straight into the frame (sharp at any
        zoom, and much faster than resampling one big picture). Only a backdrop plugin that is too slow
        for that is drawn once and resampled. A camera that does not move reuses the last background."""
        sc = self.sc
        m = self.view(0.0)
        t = time.perf_counter()
        img = self._vector_bg(m)
        dt = time.perf_counter() - t
        budget = max(0.02, 0.045 * self.size[0] * self.size[1] / (2560 * 1440))
        if dt > budget:                       # the first drawing also loads fonts and caches: measure again
            t = time.perf_counter()
            img = self._vector_bg(m)
            dt = time.perf_counter() - t
        self.bg_mode = "vector"
        self._bg_key, self._bg_img = self._key(m), img
        if dt > budget:
            self.bg_mode = "raster"
            max_zoom = max([k.zoom for k in sc.camera] + [1.0]) * (1 + max([z for _, z in self.zooms] + [0.0]))
            self._bgk = self.k * min(2.0, max(1.0, max_zoom))
            self._bg_big = Image.new("RGB", (max(1, int(sc.world_w * self._bgk)), max(1, int(sc.world_h * self._bgk))), (0, 0, 0))
            self._draw_backdrop(self._bg_big, (self._bgk, 0.0, 0.0, self._bgk, 0.0, 0.0))

    @staticmethod
    def _key(m: tuple) -> tuple:
        return tuple(round(v, 4) for v in m)

    def _vector_bg(self, m: tuple) -> Image.Image:
        img = Image.new("RGB", self.size, (0, 0, 0))
        self._draw_backdrop(img, m)
        return img

    def _raster_bg(self, m: tuple) -> Image.Image:
        sc = self.sc
        out = Image.new("RGB", self.size, (0, 0, 0))
        kk = m[0]
        wx0, wy0 = -m[4] / kk, -m[5] / kk
        wx1, wy1 = wx0 + self.size[0] / kk, wy0 + self.size[1] / kk
        ix0, iy0, ix1, iy1 = max(0.0, wx0), max(0.0, wy0), min(float(sc.world_w), wx1), min(float(sc.world_h), wy1)
        if ix1 <= ix0 or iy1 <= iy0:
            return out
        px0, py0 = int(round((ix0 - wx0) * kk)), int(round((iy0 - wy0) * kk))
        px1, py1 = int(round((ix1 - wx0) * kk)), int(round((iy1 - wy0) * kk))
        if px1 <= px0 or py1 <= py0:
            return out
        b = self._bgk
        box = (ix0 * b, iy0 * b, min(ix1 * b, self._bg_big.width), min(iy1 * b, self._bg_big.height))
        out.paste(self._bg_big.resize((px1 - px0, py1 - py0), Image.BILINEAR, box=box), (px0, py0))
        return out

    def _background(self, m: tuple, t: float) -> Image.Image:
        key = self._key(m)
        if key == self._bg_key:
            return self._bg_img.copy()
        img = self._vector_bg(m) if self.bg_mode == "vector" else self._raster_bg(m)
        # keep it for the next frame only when the camera stands still there (a copy costs time)
        if self._key(self.view(t + 1.0 / max(1, self.fps))) == key:
            self._bg_key, self._bg_img = key, img.copy()
        return img

    # -- preparation --------------------------------------------------------------
    def _expand_events(self) -> None:
        sc = self.sc
        self.texts, self.shakes, self.flashes, self.bursts, self.zooms = [], [], [], [], []
        self.says, self.captions, self.titles, self.fades, self.stars = [], [], [], [], []
        for i, ev in enumerate(sc.events):
            k, t = ev["kind"], ev["t"]
            v = ev.get("value")
            if k in ("text", "say", "caption", "title") and (v is None or str(v).strip() == ""):
                continue                                   # nothing to show (never the word "None")
            if k == "text":
                self.texts.append({**ev, "text": str(v), "seed": i})
            elif k == "say":
                dur = ev["dur"] if ev.get("dur") else 0.9 + 0.055 * len(str(v))
                self.says.append({**ev, "dur": dur, "_syl": _syllables(str(v), dur, i)})
            elif k == "caption":
                dur = ev["dur"] if ev.get("dur") else 1.0 + 0.06 * len(str(v))
                self.captions.append({**ev, "dur": dur})
            elif k == "title":
                self.titles.append(ev)
            elif k == "shake":
                self.shakes.append((t, float(ev["value"]), float(ev["dur"])))
            elif k == "flash":
                col = "#ffffff" if ev["value"] is True else ev["value"]
                self.flashes.append((t, color(col)[:3], float(ev["dur"]), float(ev["alpha"])))
            elif k == "fade":
                self.fades.append((t, str(ev["value"]), float(ev["dur"]), color(ev["color"])[:3]))
            elif k == "burst":
                self.bursts.append(self._burst(ev, i))
            elif k == "hit":
                x, y = sc.hit_point(ev)
                if ev.get("word"):
                    self.texts.append({"t": t, "text": str(ev["word"]), "x": x, "y": y - 74, "size": ev["size"], "color": ev["color"], "dur": 0.62, "ui": False,
                                       "font": "italic", "pop": True, "rot": (hash01(t, i) - 0.5) * 30, "outline": True, "seed": i})
                if ev.get("shake"):
                    self.shakes.append((t, float(ev["shake"]), 0.35))
                if ev.get("flash"):
                    self.flashes.append((t, (255, 255, 255), 0.08, 0.85))
                if ev.get("zoom"):
                    self.zooms.append((t, float(ev["zoom"])))
                if ev.get("sparks"):
                    # sparks with a dark edge in a colour that stands out from the scenery behind the hit
                    lum = self.bg_luminance(x - 30, y - 30, x + 30, y + 30)
                    spark = "#ff9a1f" if lum is not None and lum > 150 else "#ffe9a0"
                    self.bursts.append(self._burst({"t": t, "value": "spark", "x": x, "y": y, "n": 10, "speed": 460, "dir": [0, 0], "spread": 2.0, "life": 0.24,
                                                    "gravity": 0, "color": spark, "size": 4.5}, i + 7000))
                    # a comic impact star for three frames: the moment of the hit reads at a glance
                    shake = float(ev.get("shake") or 9)
                    self.stars.append({"t": t, "x": x, "y": y, "r": min(72.0, 24 + 2.0 * shake), "rot": hash01(t, i, 5) * 360, "seed": i})
        # comic words at the same spot (BAM! BAM! in a combo) take turns instead of piling up
        world = sorted((tx for tx in self.texts if not tx.get("ui")), key=lambda d: d["t"])
        for a, b in zip(world, world[1:]):
            near = abs(float(a.get("x") or 0) - float(b.get("x") or 0)) < 260 and abs(float(a.get("y") or 0) - float(b.get("y") or 0)) < 160
            if near and b["t"] < a["t"] + float(a["dur"]):
                a["dur"] = max(0.1, b["t"] - a["t"])

    def _burst(self, ev: dict, seed: int) -> dict:
        e = registry.PARTICLES[str(ev["value"])]
        params = dict(e.params)
        for key in e.params:
            if key in ev and ev[key] is not None and key != "gravity":
                params[key] = ev[key]
        if ev.get("color") is not None and "color" in e.params:
            params["color"] = ev["color"]
        if ev.get("size") is not None and "size" in e.params:
            params["size"] = ev["size"]
        g = ev.get("gravity")
        if g is None:
            g = e.params.get("gravity", 900)
        d = ev.get("dir") or [0, -0.4]
        x = ev.get("x")
        y = ev.get("y")
        return {"t": ev["t"], "fn": e.fn, "name": e.name, "p": params, "x": float(self.sc.w / 2 if x is None else x), "y": float(self.sc.floor - 100 if y is None else y),
                "n": int(ev.get("n", 18)), "speed": float(ev.get("speed", 300)), "dir": math.atan2(float(d[1]), float(d[0])) if (d[0] or d[1]) else None,
                "spread": float(ev.get("spread", 1.0)), "life": float(ev.get("life", 0.8)), "g": float(g), "seed": seed}

    def _vignette(self, amount: float):
        if amount <= 0:
            return None
        w, h = self.W, self.H
        ys, xs = np.mgrid[0:h, 0:w]
        d = np.sqrt(((xs - w / 2) / (w / 2)) ** 2 + ((ys - h / 2) / (h / 2)) ** 2) / math.sqrt(2)
        v = 1 - amount * np.clip((d - 0.45) / 0.55, 0, 1) ** 1.6
        a = (np.clip(v, 0, 1) * 255).astype(np.uint8)
        return Image.merge("RGB", [Image.fromarray(a)] * 3)

    def _grain_tiles(self) -> list:
        # half-size noise scaled up: grain the size of a film grain, not of a pixel (it compresses better)
        rng = np.random.default_rng(self.sc.seed * 7919 + 17)
        hw, hh = max(1, self.W // 2), max(1, self.H // 2)
        sigma = 255 * self.grain
        return [Image.fromarray(np.clip(128 + rng.normal(0, sigma, (hh, hw)), 0, 255).astype(np.uint8), "L").resize((self.W, self.H), Image.BILINEAR)
                for _ in range(4)]

    # -- the camera -----------------------------------------------------------------
    def _setup_camera(self) -> None:
        """A follow camera does not copy every jolt of the figure (a lunge, a recoil, the bob of a run):
        its target is smoothed over about a tenth of a second both ways (rendering is offline, so the
        camera may look ahead), and it only rises for real jumps, not while walking or running."""
        sc = self.sc
        self._track: dict = {}
        names = sorted({str(k.follow) for k in sc.camera if getattr(k, "follow", None)})
        if not names:
            return
        rate = 60.0 if sc.duration <= 120 else 20.0
        n = int(math.ceil((sc.duration + 2.0) * rate)) + 1
        ts = -1.0 + np.arange(n) / rate
        for name in names:
            f = sc.figures.get(name)
            if f is None:
                continue
            xs, ys = np.empty(n), np.empty(n)
            for i, t in enumerate(ts):
                st = f.state(float(_clamp(t, 0.0, sc.duration)))
                xs[i], ys[i] = st["x"], st.get("y", 0.0)
            lift = np.maximum(0.0, ys - 40.0)
            self._track[name] = (-1.0, rate, _gauss(xs, 0.15 * rate), _gauss(lift, 0.12 * rate))

    def _follow_at(self, name: str, t: float) -> tuple[float, float]:
        t0, rate, xs, ys = self._track[name]
        u = _clamp((t - t0) * rate, 0.0, len(xs) - 1.0)
        i = min(int(u), len(xs) - 2)
        f = u - i
        return float(xs[i] + (xs[i + 1] - xs[i]) * f), float(ys[i] + (ys[i + 1] - ys[i]) * f)

    def _cam_at(self, t: float) -> tuple[float, float, float]:
        """scene.cam_at with the smoothed follow target."""
        sc = self.sc
        if not self._track:
            return sc.cam_at(t)

        def target(k) -> tuple[float, float]:
            x = k.x if k.x is not None else sc.w / 2
            y = k.y if k.y is not None else sc.h / 2
            name = str(k.follow) if getattr(k, "follow", None) else None
            if name in self._track:
                fx, lift = self._follow_at(name, t)
                x = fx + float(getattr(k, "dx", 0) or 0)
                if k.y is None:
                    y = sc.floor - 110 * sc.figures[name].scale - lift * 0.6 + float(getattr(k, "dy", 0) or 0)
            return float(x), float(y)

        ks = sc.camera
        if t <= ks[0].t:
            x, y = target(ks[0])
            return x, y, ks[0].zoom
        for a, b in zip(ks, ks[1:]):
            if a.t <= t < b.t:
                u = ease(b.ease, (t - a.t) / (b.t - a.t)) if b.t > a.t else 1.0
                ax, ay = target(a)
                bx, by = target(b)
                z = math.exp(lerp(math.log(a.zoom), math.log(b.zoom), u))
                return lerp(ax, bx, u), lerp(ay, by, u), z
        x, y = target(ks[-1])
        return x, y, ks[-1].zoom

    def view(self, t: float) -> tuple:
        """World -> work-pixel matrix of the camera at time t (with shake and zoom punches)."""
        sc = self.sc
        cx, cy, z = self._cam_at(t)
        for t0, amt in self.zooms:
            if t0 <= t < t0 + 0.22:
                z *= 1 + amt * (1 - (t - t0) / 0.22) ** 2
        vw, vh = sc.w / z, sc.h / z
        ox = oy = amp = 0.0
        for i, (t0, a0, dur) in enumerate(self.shakes):
            if t0 <= t < t0 + dur:
                a = a0 * (1 - (t - t0) / dur)
                ox += _noise(t - t0, t0 + i * 0.37, 1) * a
                oy += _noise(t - t0, t0 + i * 0.37, 2) * a
                amp += abs(a)
        # keep the picture inside the scenery when it fits
        if vw <= sc.world_w:
            cx = _clamp(cx, vw / 2, sc.world_w - vw / 2)
        if vh <= sc.world_h:
            cy = _clamp(cy, vh / 2, sc.world_h - vh / 2)
        if amp > 0:
            # a shaking camera needs scenery beyond the edges of the picture: zoom in just as much as
            # that takes (instead of showing black edges), then shake
            zz = z
            if vw <= sc.world_w:
                half = min(cx, sc.world_w - cx) - amp
                if half > 1:
                    zz = max(zz, sc.w / (2 * half))
            if vh <= sc.world_h:
                half = min(cy, sc.world_h - cy) - amp
                if half > 1:
                    zz = max(zz, sc.h / (2 * half))
            z = zz
            vw, vh = sc.w / z, sc.h / z
            cx, cy = cx + ox, cy + oy
            if vw <= sc.world_w:
                cx = _clamp(cx, vw / 2, sc.world_w - vw / 2)
            if vh <= sc.world_h:
                cy = _clamp(cy, vh / 2, sc.world_h - vh / 2)
        kk = self.k * z
        return (kk, 0.0, 0.0, kk, self.k * sc.w / 2 - cx * kk, self.k * sc.h / 2 - cy * kk)

    def visible(self, m: tuple) -> tuple[float, float, float, float]:
        """The world rectangle a view matrix shows: x0, y0, x1, y1."""
        kk = m[0]
        return (-m[4] / kk, -m[5] / kk, (self.size[0] - m[4]) / kk, (self.size[1] - m[5]) / kk)

    def view_of(self, x0: float, y0: float, x1: float, y1: float) -> tuple:
        """A view matrix that shows the world rectangle (widened to the frame's shape)."""
        w, h = max(1e-3, x1 - x0), max(1e-3, y1 - y0)
        kk = min(self.size[0] / w, self.size[1] / h)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        return (kk, 0.0, 0.0, kk, self.size[0] / 2 - cx * kk, self.size[1] / 2 - cy * kk)

    # -- one frame ------------------------------------------------------------------
    def frame(self, t: float, view: tuple | None = None, overlay: bool = True, ghosts: list | None = None, markers: bool = False) -> Image.Image:
        """The picture at time t. `view`: a world -> work-pixel matrix to use instead of the camera
        (contact-sheet close-ups, see view_of). For judging motion: `ghosts` — earlier times at which the
        figures are drawn faintly behind (onion skin); `markers` — the floor line, the feet (green: on the
        floor, red: in the air) and the hands."""
        sc = self.sc
        m = tuple(view) if view is not None else self.view(t)
        img = self._background(m, t) if view is None else (self._vector_bg(m) if self.bg_mode == "vector" else self._raster_bg(m))
        c = Canvas(img, m)

        self._props(c, t, "back")
        figs = sorted(sc.figures.values(), key=lambda f: f.z)
        for k, gt in enumerate(sorted(ghosts or [])):
            for f in figs:
                gst, gP = f.joints(gt)
                if gst["visible"]:
                    gst["_t"] = gt
                    draw_figure(c, f, gst, gP, {**sc.style, "shadow": False, "highlight": False}, sc.floor, None, alpha=0.18 + 0.12 * k / max(1, len(ghosts) - 1))
        states = {}
        for f in figs:
            st, P = f.joints(t)
            st["_t"] = t
            states[f.name] = (st, P)
        for s in self.says:
            if s.get("who") in states and s["t"] <= t < s["t"] + s["dur"]:
                states[s["who"]][0]["_mouth"] = _mouth(s["_syl"], t - s["t"])
        for f in figs:
            st, P = states[f.name]
            if not st["visible"]:
                continue
            st["_bg_lum"] = self._lum_at(f.name, P)
            held = {"R": [], "L": []}
            for p in self.held.get(f.name, []):
                if p.t_from <= t < p.t_to:
                    held[p.hand].append(self._held_fn(p, P, t))
            try:
                if self.smear:
                    self._smear(c, f, P, t, st["_bg_lum"])
                draw_figure(c, f, st, P, sc.style, sc.floor, held)
            except RenderError:
                raise
            except Exception as e:  # noqa: BLE001
                raise RenderError(f'drawing figure "{f.name}" at {t:.2f}s failed: {type(e).__name__}: {e}') from None
        self._props(c, t, "front")
        if markers:
            self._markers(c, m, states)
        self._stars(c, t)
        self._particles(c, t)
        lay = self._screen_layout(t, m, view is not None) if overlay else {"bands": []}
        self._says(c, t, states, m, lay["bands"], view is not None)
        # comic words come after the bubbles: a bubble never hides a BAM!
        for tx in self.texts:
            if not tx.get("ui"):
                self._text(c, tx, t, sc.w / 2, sc.floor - 260, m)
        for t0, col, dur, alpha in self.flashes:
            if t0 <= t < t0 + dur:
                ImageDraw.Draw(img, "RGBA").rectangle([0, 0, *img.size], fill=col + (int(255 * alpha * (1 - (t - t0) / dur)),))

        if self.ss > 1:
            img = img.reduce(self.ss)
        if self.vignette is not None:
            img = ImageChops.multiply(img, self.vignette)
        if self._grain:
            n = int(round(t * self.fps)) // 2                  # new grain every second frame, like film "on twos"
            tile = ImageChops.offset(self._grain[n % len(self._grain)], int(hash01(n, 1) * self.W), int(hash01(n, 2) * self.H))
            img = ImageChops.add(img, Image.merge("RGB", (tile, tile, tile)), 1.0, -128)
        if overlay:
            self._overlay(img, t, m, view is not None, lay)
        return img

    def _markers(self, c: Canvas, m: tuple, states: dict) -> None:
        """Floor line with ticks every 50 px of world x, and dots on feet and hands: a foot that should
        stand but is red floats, a green foot that moves between pictures slides."""
        sc = self.sc
        x0, y0, x1, y1 = self.visible(m)
        px = 1.0 / (m[0] / self.ss)                    # one output pixel in world units
        c.line((x0, sc.floor), (x1, sc.floor), 1.5 * px, (0, 200, 255, 200), cap=False)
        for x in range(int(x0 // 50) * 50, int(x1) + 50, 50):
            c.line((x, sc.floor), (x, sc.floor + (8 if x % 250 == 0 else 4) * px), 1.2 * px, (0, 200, 255, 200), cap=False)
            if x % 250 == 0:
                c.text(str(x), x + 2 * px, sc.floor + 9 * px, 10 * px, (0, 200, 255, 230), "lt", "mono")
        for name, (st, P) in states.items():
            if not st.get("visible", True):
                continue
            f = sc.figures[name]
            ground = sc.floor - 5 * f.scale
            for side in "RL":
                q = P[side + "foot"]
                on = abs(ground - q[1]) < 2.0 * f.scale
                c.circle(q, 4 * px, fill=(40, 220, 90) if on else (240, 60, 60), outline=(0, 0, 0), width=1 * px)
                c.circle(P[side + "hand"], 3 * px, fill=(255, 200, 40), outline=(0, 0, 0), width=1 * px)

    def _lum_at(self, name: str, P: dict) -> float | None:
        """Luminance of the scenery behind a figure (it picks a dark or light outline). Measured on a grid of
        24 px, the same for every position in a cell — so a frame looks the same whichever frames were drawn
        before it (worker processes draw different ones)."""
        s = P["_scale"]
        cx = int(P["hip"][0] // 24)
        top = int((P["head"][1] - P["_head_r"]) // 24)
        bottom = int(max(P["Rfoot"][1], P["Lfoot"][1]) // 24)
        key = (name, cx, top, bottom, round(s, 3))
        if key not in self._lum_cache:
            x = cx * 24 + 12
            self._lum_cache[key] = self.bg_luminance(x - 45 * s, top * 24, x + 45 * s, bottom * 24 + 24)
        return self._lum_cache[key]

    def _strike_windows(self) -> dict:
        """When each figure strikes: the moments just before its hits, blocked blows and swings (the
        events its timeline items make — a hit, or a whoosh for a blow into the air or a throw)."""
        out: dict = {}
        for ev in self.sc.events:
            if ev["kind"] == "hit":
                imp = float(ev["t"])
            elif ev["kind"] == "sfx" and str(ev.get("value")) == "whoosh":
                imp = float(ev["t"]) + 0.05
            else:
                continue
            m = re.match(r"timeline\.([^\[]+)\[", str(ev.get("_where") or ""))
            if m and m.group(1) in self.sc.figures:
                out.setdefault(m.group(1), []).append((imp - 0.16, imp + 0.03))
        return out

    def _smear(self, c: Canvas, f, P: dict, t: float, bg_lum: float | None = None) -> None:
        """A striking forearm or shin leaves a smear behind (the area it swept since a moment ago, half
        transparent, with speed lines) — in cartoons that is what makes a strike look fast. Only strikes:
        the last moment before a figure's hit, blocked blow or swing, and only a limb that moves fast then
        (on any fast limb — a wave, a dance step, a laugh — it drew muddy wedges and scribbles). The sweep
        is the whole time since the previous frame: with snappy easing most of a strike happens early in it."""
        dt = 1.0 / max(1, self.fps)
        if t - dt < 0 or not any(a <= t <= b for a, b in self._strikes.get(f.name, ())):
            return
        _, Q = f.joints(t - dt)
        if Q["_face"] != P["_face"]:
            return                                    # turned round: the limbs are mirrored, not fast
        s = P["_scale"]
        w = f.line * s
        hip = (P["hip"][0] - Q["hip"][0], P["hip"][1] - Q["hip"][1])
        if math.hypot(*hip) > 120 * s:
            return                                    # a jump cut, not a movement
        fast = 4.0 * w * 30 / max(1, self.fps)        # about 1100 px/s at scale 1, at any frame rate
        # the colour of the figure lifted off the scenery: on dark scenery lighter and more opaque, with light
        # speed lines (yellow at alpha 92 on a dark stage came out olive, ink lines were invisible); on light
        # scenery a touch darker and see-through, with ink lines
        base = f.color[:3]
        dark_bg = bg_lum is not None and bg_lum < 115
        tint = mix(base, (255, 255, 255), 0.35) if dark_bg else mix(base, (0, 0, 0), 0.08)
        fill_a = 170 if dark_bg else 110
        line_c = (236, 236, 242, 150) if dark_bg else INK + (140,)
        mids = None
        for mid, end in (("Relb", "Rhand"), ("Lelb", "Lhand"), ("Rknee", "Rfoot"), ("Lknee", "Lfoot")):
            b0, b1 = Q[end], P[end]
            if math.hypot(b1[0] - b0[0] - hip[0], b1[1] - b0[1] - hip[1]) < fast:
                continue
            if mids is None:                          # two more moments in between: the path is an arc
                mids = [f.joints(t - dt * k)[1] for k in (2 / 3, 1 / 3)]
            path = _one_way([Q] + mids + [P], mid, end)
            if path is None:
                continue
            far = end.startswith("L")
            col = tint if not far else tuple(max(0, v - 14) for v in tint)
            c.poly([p[mid] for p in path] + [p[end] for p in reversed(path)], fill=tuple(int(v) for v in col) + (fill_a,))
            # speed lines behind the hand / foot, along its path, beside it (the path turns less than 45
            # degrees per step, so they never cross)
            for k, off in enumerate((-1.0, 0.0, 1.0)):
                pts = []
                for j, p in enumerate(path[:-1]):
                    q, nq = p[end], path[j + 1][end]
                    dx, dy = nq[0] - q[0], nq[1] - q[1]
                    n = math.hypot(dx, dy) or 1.0
                    o = off * w * 1.1
                    pts.append((q[0] - dy / n * o, q[1] + dx / n * o))
                if len(pts) >= 2:
                    pts = pts[k % 2:]                 # staggered lengths
                    for q0, q1 in zip(pts, pts[1:]):
                        c.line(q0, q1, max(1.2, w * 0.24), line_c, cap=False)

    def _props(self, c: Canvas, t: float, layer: str) -> None:
        for p in self.sc.props:
            if p.layer != layer or p.held_by or not (p.t_from <= t < p.t_to):
                continue
            x, y, rot = p.at(t)
            try:
                registry.PROPS[p.kind].fn(c.at((x, y), angle=rot, flip=p.flip, scale=p.scale), p.params, t)
            except Exception as e:  # noqa: BLE001
                raise RenderError(f'prop "{p.name}" ({p.kind}) failed: {type(e).__name__}: {e}') from None

    def _held_fn(self, p, P: dict, t: float):
        def fn(c: Canvas) -> None:
            f = P["_face"]
            hand = P[p.hand + "hand"]
            ang = P[p.hand + "arm_ang"]
            base = c.at(hand, angle=ang + (180 if f < 0 else 0), flip=f, scale=p.scale * P["_scale"])
            hold = float(p.params.get("hold_angle", 0)) + p.angle
            try:
                registry.PROPS[p.kind].fn(base.at((0, 0), angle=-hold), p.params, t)
            except Exception as e:  # noqa: BLE001
                raise RenderError(f'prop "{p.name}" ({p.kind}) failed: {type(e).__name__}: {e}') from None

        return fn

    def _particles(self, c: Canvas, t: float) -> None:
        for b in self.bursts:
            age0 = t - b["t"]
            if age0 < 0 or age0 > b["life"] * 1.05:
                continue
            for i in range(b["n"]):
                h1, h2, h3 = hash01(b["seed"], i, 1), hash01(b["seed"], i, 2), hash01(b["seed"], i, 3)
                life = b["life"] * (0.6 + 0.4 * h3)
                if age0 >= life:
                    continue
                ang = (b["dir"] if b["dir"] is not None else 0.0) + (h1 - 0.5) * b["spread"] * math.pi
                sp = b["speed"] * (0.35 + 0.65 * h2)
                vx, vy = math.cos(ang) * sp, math.sin(ang) * sp
                x = b["x"] + vx * age0
                y = b["y"] + vy * age0 + 0.5 * b["g"] * age0 * age0
                try:
                    b["fn"](c, x, y, age0, age0 / life, b["seed"] * 131 + i, {**b["p"], "_v": (vx, vy + b["g"] * age0)})
                except Exception as e:  # noqa: BLE001
                    raise RenderError(f'particle "{b["name"]}" failed: {type(e).__name__}: {e}') from None

    def _stars(self, c: Canvas, t: float) -> None:
        """The jagged white impact star of a hit: big on the first frame, a bit smaller on the next ones."""
        for s in self.stars:
            age = t - s["t"]
            if not 0 <= age < 0.1:
                continue
            k = 1.0 if age < 0.034 else 0.82 if age < 0.067 else 0.62
            n = 9
            outer, inner = [], []
            for i in range(2 * n):
                a = math.radians(s["rot"]) + i * math.pi / n
                rr = s["r"] * k * (1.0 if i % 2 == 0 else 0.42 + 0.16 * hash01(s["seed"], i))
                rr *= 0.8 + 0.2 * hash01(s["seed"], i, 3)
                outer.append((s["x"] + rr * math.cos(a), s["y"] + rr * math.sin(a)))
                inner.append((s["x"] + rr * 0.48 * math.cos(a + 0.2), s["y"] + rr * 0.48 * math.sin(a + 0.2)))
            c.poly(outer, fill=(255, 251, 232), outline=INK, width=3.0)
            c.poly(inner, fill=(255, 214, 64))

    def _zoom_factor(self, m: tuple, hi: float = 1.5) -> float:
        """Speech bubbles and comic words grow a little when the camera zooms in, but never fill the picture
        (zoom 3.5 made a bubble wider than the frame); this is their world size per design size."""
        z = m[0] / self.k
        return _clamp(z, 0.8, hi) / z

    def _text(self, c: Canvas, tx: dict, t: float, dx: float, dy: float, m: tuple | None = None) -> None:
        age = t - tx["t"]
        dur = float(tx["dur"])
        if age < 0 or age >= dur:
            return
        fade = min(0.25, dur * 0.3)
        alpha = 1.0 if age < dur - fade else max(0.0, (dur - age) / fade)
        size = float(tx["size"])
        if tx.get("pop") and age < 0.12:
            size *= 1 + 0.7 * (1 - age / 0.12) ** 2
        x = dx if tx.get("x") is None else float(tx["x"])
        y = dy if tx.get("y") is None else float(tx["y"])
        text = tx["text"]
        anchor = tx.get("anchor", "mm")
        font_name = tx.get("font", "bold")
        rot = float(tx.get("rot") or 0)
        if m is not None:
            # a word in the world: sized for the screen, and kept inside the picture
            zf = self._zoom_factor(m, 1.6)
            size *= zf
            base = float(tx["size"]) * zf
            x0, y0, x1, y1 = self.visible(m)
            w, h = c.text_size(text, base, font_name)
            if rot:                                      # the box of the turned word
                cs, sn = abs(math.cos(math.radians(rot))), abs(math.sin(math.radians(rot)))
                w, h = w * cs + h * sn, w * sn + h * cs
            mg = 10 * (x1 - x0) / self.sc.w
            # never bigger than the picture (size 400 on a small scene, or at the peak of its pop): such a
            # word could not be read, and its letters made Pillow refuse the picture at 4K
            room = min((x1 - x0 - 2 * mg) / max(w, 1e-6), (y1 - y0 - 2 * mg) / max(h, 1e-6))
            if room < 1.0:
                w, h = w * room, h * room
            size = min(size, base * room)
            if anchor == "mm" and x1 - x0 > w + 2 * mg - 1e-6:
                x = _clamp(x, x0 + mg + w / 2, x1 - mg - w / 2)
            if anchor == "mm" and y1 - y0 > h + 2 * mg - 1e-6:
                y = _clamp(y, y0 + mg + h / 2, y1 - mg - h / 2)
        outline = "#101014" if tx.get("outline", True) else None
        c.text(text, x, y, size, tx["color"], anchor, font_name, rot=rot, stroke=outline,
               stroke_width=max(2.0, size * 0.09) if outline else 0, alpha=alpha)

    # -- speech bubbles -------------------------------------------------------------
    # Bubbles are laid out in design units of the picture (sc.w x sc.h) with their text measured at this
    # many pixels per unit: the same decisions at every output scale (draft, contact sheet, still, final).
    _BUB_REF = 2.0

    def _says(self, c: Canvas, t: float, states: dict, m: tuple, bands: list | None = None, fixed: bool = False) -> None:
        """Speech bubbles. Where a bubble sits next to its speaker is decided once for its whole time on
        screen (see _plan_bubble), so it never jumps: not when the camera moves or zooms, not when another
        bubble opens or closes. Each frame it only follows its speaker and stays inside the picture.
        `fixed`: a view other than the camera's (a contact-sheet close-up) — the captions of this frame."""
        active = [i for i, s in enumerate(self.says) if s["t"] <= t < s["t"] + s["dur"]]
        if not active:
            return
        here = self._band_limits(bands) if fixed else None
        z = m[0] / self.k
        g = _clamp(z, 0.8, 1.5)                        # bubbles grow a little when the camera zooms in
        zf = g / z
        heads = self._heads_in(states, m) if fixed else []
        placed: list = []
        for i in sorted(active, key=lambda j: (self.says[j]["t"], j)):
            s = self.says[i]
            plan = self._bubble_plan(i)
            ax, ay = self._bubble_anchor(s, t, m)
            if fixed:
                # a close-up shows the scene differently from the camera: the planned place is kept when it
                # still fits there, otherwise this picture gets its own (one picture, nothing can jump)
                plan = self._choose(s, [((ax, ay), g, heads, placed)], here, plan["side"], keep=plan)
            bx, by, bw, bh = self._bubble_rect(plan, ax, ay, g, here or plan["lim"])
            placed.append((bx, by, bw, bh))
            size = float(s["size"]) * zf
            # the text as it is drawn at this pixel size must fit its box (fonts are a little wider at
            # small sizes): the box widens around its centre when needed
            tw, th = c.text_size(plan["body"], size, "bold")
            pad = size * 0.55
            ww, wh = max(bw / z, tw + 2 * pad), max(bh / z, th + 2 * pad + size * 0.2)
            wx = (bx * self.k - m[4]) / m[0] - (ww - bw / z) / 2
            wy = (by * self.k - m[5]) / m[3] - (wh - bh / z) / 2
            lay = {"body": plan["body"], "size": size, "w": ww, "h": wh, "tail": plan["tail"] * zf}
            age = t - s["t"]
            alpha = max(0.0, min(1.0, age / 0.1, (s["dur"] - age) / 0.15))
            draw_bubble(c, lay, wx, wy, (ax * self.k - m[4]) / m[0], (ay * self.k - m[5]) / m[3], s["color"], s["bubble"], alpha)

    def _band_limits(self, bands: list | None) -> tuple[float, float]:
        """The room caption bands leave for bubbles: (top, bottom) in design units."""
        top, bottom = 0.0, float(self.sc.h)
        for b0, b1 in bands or []:
            if b0 < self.sc.h / 2:
                top = max(top, b1)
            else:
                bottom = min(bottom, b0)
        return top, bottom

    def _bubble_anchor(self, s: dict, t: float, m: tuple) -> tuple[float, float]:
        """The point a bubble's tail points at, in design units of the picture: just above the speaker's
        head, smoothed over a fifth of a second (a bubble does not jerk along with a knock-back or a lunge;
        a bubble without a speaker: above the middle of the stage)."""
        who = s.get("who")
        if who and who in self.sc.figures:
            wx = wy = 0.0
            g = int(round(t * 600))                    # on a grid of 1/600 s: the same at every frame rate
            for d, wt in ((-3, 1), (-2, 2), (-1, 3), (0, 4), (1, 3), (2, 2), (3, 1)):
                hx, hy = self._head_top(who, g + 20 * d)
                wx, wy = wx + hx * wt / 16, wy + hy * wt / 16
        else:
            wx, wy = self.sc.w / 2, self.sc.floor - 280
        return (wx * m[0] + m[4]) / self.k, (wy * m[3] + m[5]) / self.k

    def _head_top(self, name: str, g: int) -> tuple[float, float]:
        """The top of a figure's head at time g/600 s (a value of g alone: frames come out the same in
        any order and in any process)."""
        key = (name, g)
        v = self._heads.get(key)
        if v is None:
            P = self.sc.figures[name].joints(_clamp(g / 600.0, 0.0, self.sc.duration))[1]
            v = (P["head"][0], P["head"][1] - P["_head_r"] - 8)
            if len(self._heads) > 2048:
                self._heads.clear()
            self._heads[key] = v
        return v

    def _bubble_rect(self, plan: dict, ax: float, ay: float, g: float, lim: tuple) -> tuple[float, float, float, float]:
        """Where the bubble is at a moment: its place next to the speaker, kept inside the picture and out of
        the caption bands (design units: x, y, w, h)."""
        sc = self.sc
        w, h = plan["w"] * g, plan["h"] * g
        mg = 10.0
        y0, y1 = max(mg, lim[0] + mg), min(sc.h - mg, lim[1] - mg)
        bx = _clamp(ax + plan["ox"] * g, mg, max(mg, sc.w - mg - w))
        by = _clamp(ay + plan["oy"] * g, y0, max(y0, y1 - h))
        return bx, by, w, h

    def _bubble_plan(self, i: int) -> dict:
        """The place of bubble i, decided once (bubbles are planned in the order they open, each after
        the ones before it, which it never moves)."""
        plans = self._bubbles
        if i not in plans:
            for j in sorted(range(len(self.says)), key=lambda j: (self.says[j]["t"], j)):
                if j not in plans:
                    plans[j] = self._plan_bubble(j)
                if j == i:
                    break
        return plans[i]

    def _plan_bubble(self, i: int) -> dict:
        """Chooses where a bubble sits relative to its speaker for its whole time on screen, looking at
        moments spread over that time (the camera may move and zoom, the speaker may walk): above the
        speaker, a little towards the middle of the picture, when that is free; otherwise shifted, higher,
        with a narrower text, or beside the head — whatever covers least of the bubbles that are already up
        (never moved for this one) and of the figures' heads, and stays closest to the speaker."""
        sc = self.sc
        s = self.says[i]
        t0, dur = s["t"], s["dur"]
        samples = [t0 + dur * u for u in (0.0, 0.15, 0.32, 0.5, 0.68, 0.85, 0.999)]
        others = [j for j, p in self._bubbles.items() if j != i and p["t0"] < t0 + dur and p["t1"] > t0]
        bands: list = []
        moments = []
        for ts in samples:
            m = self.view(ts)
            bands += self._screen_layout(ts, m, False)["bands"]
            states = {f.name: f.joints(ts) for f in sc.figures.values()}
            g = _clamp(m[0] / self.k, 0.8, 1.5)
            heads = self._heads_in(states, m)
            near = []
            for j in others:
                o = self._bubbles[j]
                if o["t0"] <= ts < o["t1"]:
                    ox, oy = self._bubble_anchor(self.says[j], ts, m)
                    near.append(self._bubble_rect(o, ox, oy, g, o["lim"]))
            moments.append((self._bubble_anchor(s, ts, m), g, heads, near))
        side = 1 if moments[0][0][0] < sc.w / 2 else -1     # towards the middle of the picture, decided once
        plan = self._choose(s, moments, self._band_limits(bands), side)
        plan.update(t0=t0, t1=t0 + dur)
        return plan

    def _heads_in(self, states: dict, m: tuple) -> list:
        """The visible figures' heads in design units of the picture: (x, y, radius with a margin)."""
        z = m[0] / self.k
        return [((P["head"][0] * m[0] + m[4]) / self.k, (P["head"][1] * m[3] + m[5]) / self.k, P["_head_r"] * 1.15 * z)
                for st, P in states.values() if st.get("visible", True)]

    def _choose(self, s: dict, moments: list, lim: tuple, side: int, keep: dict | None = None) -> dict:
        """The best place for a bubble over the given moments ((anchor, growth, heads, other bubbles) each),
        scored by how much it covers other bubbles and heads, how far the edges of the picture push it and
        how far it ends up from its speaker. `keep`: a place to stay with when it scores well."""
        sc = self.sc
        mc = Canvas(_MEASURE_IMG, (self._BUB_REF, 0, 0, self._BUB_REF, 0, 0))
        gmax = max(mo[1] for mo in moments)
        size = float(s["size"])
        wrap0 = min(320.0, 0.8 * sc.w / gmax)
        best = None
        if keep is not None:
            best = (self._score(keep, moments, lim), keep)
            if best[0] < 0.05:
                return keep
        for wcost, wk in ((0.0, 1.0), (0.12, 0.72), (0.25, 0.5)):
            lay = bubble_layout(mc, str(s["value"]), size, wrap0 * wk)
            w, h, tail = lay["w"], lay["h"], lay["tail"]
            cands = []
            for scost, sh in ((0.0, 0.18), (0.03, 0.0), (0.05, 0.36), (0.08, -0.18), (0.1, 0.5), (0.14, -0.36), (0.18, 0.7), (0.22, -0.5)):
                for hcost, lift in ((0.0, 0.0), (0.06, 0.5), (0.12, 1.0), (0.2, 1.6)):
                    cands.append((wcost + scost + hcost, -w / 2 + side * sh * w, -h - tail - lift * (h + 6)))
            # beside the head, at its height (when there is no room above it)
            for scost, sgn in ((0.35, side), (0.42, -side)):
                cands.append((wcost + scost, 26.0 if sgn > 0 else -w - 26.0, -h * 0.35))
            for cost, ox, oy in cands:
                if best is not None and cost >= best[0]:
                    continue                           # cannot beat the best one any more
                plan = {"ox": ox, "oy": oy, "w": w, "h": h, "lim": lim, "side": side, "body": lay["body"], "tail": tail}
                total = cost + self._score(plan, moments, lim)
                if best is None or total < best[0]:
                    best = (total, plan)
            if best[0] < 0.05:
                break                                  # it fits with the full width: no narrower text
        return dict(best[1])

    def _score(self, plan: dict, moments: list, lim: tuple) -> float:
        """How bad a place is over the moments (0 = free, close to its speaker, inside the picture)."""
        cover = head = shift = far = 0.0
        for (ax, ay), g, heads, near in moments:
            bx, by, bw, bh = self._bubble_rect(plan, ax, ay, g, lim)
            area = bw * bh
            for r in near:
                cover = max(cover, _overlap(bx, by, bw, bh, *r) / min(area, r[2] * r[3]))
            for hx, hy, hr in heads:
                head = max(head, _overlap(bx, by, bw, bh, hx - hr, hy - hr, 2 * hr, 2 * hr) / (4 * hr * hr))
            shift += math.hypot(bx - (ax + plan["ox"] * g), by - (ay + plan["oy"] * g)) / bw
            far += max(0.0, abs(bx + bw / 2 - ax) - 0.6 * bw) / bw
        return 10 * cover + 3 * head + shift / len(moments) + 0.5 * far / len(moments)

    def _caption_y(self, i: int, cap: dict, bh: float, m: tuple, fixed: bool, top: float) -> float:
        """Where a caption sits (centre y in design units): under the floor line when the box fits there
        for its whole time on screen, at the bottom when the floor is below the picture, else at the top
        (under the UI texts that end at `top`) — it never covers the figures' feet."""
        sc = self.sc
        key = (i, round(bh, 1))
        if fixed or key not in self._caption_at:
            views = [m] if fixed else [self.view(cap["t"] + cap["dur"] * u) for u in (0.0, 0.25, 0.5, 0.75, 0.999)]
            floors = [(sc.floor * v[3] + v[5]) / self.k for v in views]
            low, high = max(floors), min(floors)
            if low + 6 + bh <= sc.h - 6:
                y = min(sc.h - 8 - bh / 2, max((low + sc.h) / 2, low + 6 + bh / 2))
            elif high >= sc.h - 2:
                y = sc.h - 12 - bh / 2
            else:
                y = None                              # at the top
            if fixed:
                return y if y is not None else top + 10 + bh / 2
            self._caption_at[key] = y
        y = self._caption_at[key]
        return y if y is not None else top + 10 + bh / 2

    def _screen_layout(self, t: float, m: tuple, fixed: bool) -> dict:
        """Where the screen-space words go (design units): UI texts wrapped to the room they have, and
        the captions' boxes — worked out before the speech bubbles, which keep out of the captions."""
        sc = self.sc
        k = self.W / sc.w
        c = Canvas(_MEASURE_IMG, (k, 0, 0, k, 0, 0))
        ui, caps = [], []
        top = 0.0                                       # where UI texts at the top of the picture end
        for tx in self.texts:
            if not tx.get("ui") or not (0 <= t - tx["t"] < float(tx["dur"])):
                continue
            room = sc.w - 16 - float(tx["x"]) if tx.get("x") is not None else sc.w * 0.9
            body = "\n".join(wrap_lines(c, tx["text"], float(tx["size"]), max(40.0, room), tx.get("font", "bold")))
            anchor = tx.get("anchor", "lt") if tx.get("x") is not None else "mm"
            ui.append({**tx, "text": body, "anchor": anchor})
            if anchor[1] == "t" and tx.get("y") is not None and float(tx["y"]) < sc.h / 3:
                top = max(top, float(tx["y"]) + c.text_size(body, float(tx["size"]))[1])
        for i, cap in enumerate(self.captions):
            age = t - cap["t"]
            if 0 <= age < cap["dur"]:
                size = float(cap["size"])
                body = "\n".join(wrap_lines(c, str(cap["value"]), size, sc.w * 0.9 - 36))
                tw, th = c.text_size(body, size)
                bh = th + 22
                y = self._caption_y(i, cap, bh, m, fixed, top)
                caps.append({"cap": cap, "body": body, "w": tw, "h": bh, "y": y, "alpha": min(1.0, age / 0.12, (cap["dur"] - age) / 0.2)})
        return {"ui": ui, "captions": caps, "bands": [(d["y"] - d["h"] / 2 - 4, d["y"] + d["h"] / 2 + 4) for d in caps]}

    def _overlay(self, img: Image.Image, t: float, m: tuple, fixed: bool = False, lay: dict | None = None) -> None:
        """Everything in screen space: UI texts, captions, titles, fades."""
        sc = self.sc
        k = self.W / sc.w
        c = Canvas(img, (k, 0, 0, k, 0, 0))
        lay = lay or self._screen_layout(t, m, fixed)
        for tx in lay["ui"]:
            self._text(c, tx, t, sc.w / 2, sc.h / 2)
        for d in lay["captions"]:
            a = d["alpha"]
            c.rect(sc.w / 2 - d["w"] / 2 - 18, d["y"] - d["h"] / 2, d["w"] + 36, d["h"], fill=(0, 0, 0, int(150 * a)), radius=8)
            c.text(d["body"], sc.w / 2, d["y"], float(d["cap"]["size"]), d["cap"]["color"], "mm", "bold", alpha=a)
        for ti in self.titles:
            age = t - ti["t"]
            dur = float(ti["dur"])
            if 0 <= age < dur:
                alpha = max(0.0, min(1.0, age / 0.35, (dur - age) / 0.45))
                ImageDraw.Draw(img, "RGBA").rectangle([0, 0, *img.size], fill=(0, 0, 0, int(255 * float(ti["shade"]) * alpha)))
                size = float(ti["size"])
                # long titles wrap inside the picture; the subtitle goes under the last line
                body = "\n".join(wrap_lines(c, str(ti["value"]), size, sc.w * 0.9))
                th = c.text_size(body, size)[1]
                cy = sc.h / 2 - (size * 0.3 if ti.get("sub") else 0)
                c.text(body, sc.w / 2, cy, size, ti["color"], "mm", "bold", stroke="#000000", stroke_width=size * 0.05, alpha=alpha)
                if ti.get("sub"):
                    sub = "\n".join(wrap_lines(c, str(ti["sub"]), size * 0.36, sc.w * 0.9, "regular"))
                    c.text(sub, sc.w / 2, cy + th / 2 + size * 0.36, size * 0.36, ti["color"], "mt", "regular", alpha=alpha)
        a, col = self.fade_at(t)
        if a > 0.003:
            ImageDraw.Draw(img, "RGBA").rectangle([0, 0, *img.size], fill=col + (int(255 * a),))

    def fade_at(self, t: float) -> tuple[float, tuple]:
        """How far the picture is faded at t (0 = clear, 1 = all colour) and the colour: one level for
        all fades together, so a fade-in after a fade-out brings the picture back (drawn one layer per
        fade, a finished fade-out stayed black for the rest of the scene). A fade starts from the level
        the one before it left (no jump when a fade begins during another); a fade-in with nothing to
        fade from starts from the full colour — at t 0 the scene opens from it."""
        fades = sorted(self.fades, key=lambda f: f[0])
        if not fades:
            return 0.0, (0, 0, 0)
        level = 1.0 if fades[0][1] == "in" and fades[0][0] <= 0.001 else 0.0
        cur = None                                     # (t0, from, to, dur) of the fade that runs now
        col = fades[0][3]

        def at(f, tt: float) -> float:
            t0, a, b, dur = f
            return a + (b - a) * min(1.0, max(0.0, (tt - t0) / max(dur, 1e-3)))

        for t0, kind, dur, c in fades:
            if t0 > t:
                break
            start = at(cur, t0) if cur else level
            if kind == "in" and start <= 0.003:
                start = 1.0
            cur = (t0, start, 0.0 if kind == "in" else 1.0, dur)
            col = c
        return (at(cur, t) if cur else level), col

    # -- close-ups for contact sheets ---------------------------------------------
    def focus_view(self, t: float, focus: str | None) -> tuple | None:
        """A view matrix around the figures (focus "action": every figure in the camera's picture; a
        figure's name: that one) with room for their bubbles and hit words; None = the camera's own view
        (also when the camera is already closer)."""
        sc = self.sc
        if not focus:
            return None
        cam = self.view(t)
        vx0, vy0, vx1, vy1 = self.visible(cam)
        names = [focus] if focus in sc.figures else list(sc.figures)
        boxes = []
        for name in names:
            f = sc.figures[name]
            st, P = f.joints(t)
            if not st["visible"]:
                continue
            pts = [v for k, v in P.items() if not k.startswith("_") and isinstance(v, tuple)]
            s = P["_scale"]
            r = P["_head_r"]
            reach = (0.6 * max([float(p.params.get("length", 90)) for p in self.held.get(name, []) if p.t_from <= t < p.t_to] + [0.0])) * s
            box = [min(q[0] for q in pts) - 24 * s - reach, min(min(q[1] for q in pts), P["head"][1] - r * 2.2) - 14 * s - reach,
                   max(q[0] for q in pts) + 24 * s + reach, max(max(q[1] for q in pts), sc.floor) + 8]
            if focus not in sc.figures and (box[2] < vx0 or box[0] > vx1 or box[3] < vy0 or box[1] > vy1):
                continue                                   # not in the camera's picture
            if any(str(sp.get("who")) == name and sp["t"] <= t < sp["t"] + sp["dur"] for sp in self.says):
                box[1] -= 110 * s                          # room for the speech bubble above the head
            boxes.append(box)
        if not boxes:
            return None
        for s_ in self.stars:
            if s_["t"] - 0.05 <= t <= s_["t"] + 0.6:
                boxes.append([s_["x"] - 70, s_["y"] - 150, s_["x"] + 70, s_["y"] + 30])
        x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
        x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
        aspect = sc.w / sc.h
        w, h = (x1 - x0) * 1.12, (y1 - y0) * 1.12
        if w / h < aspect:
            w = h * aspect
        else:
            h = w / aspect
        if w >= (vx1 - vx0) * 0.97:
            return None
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if w <= sc.world_w:
            cx = _clamp(cx, w / 2, sc.world_w - w / 2)
        if h <= sc.world_h:
            cy = _clamp(cy, h / 2, sc.world_h - h / 2)
        return self.view_of(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------
_MEASURE_IMG = Image.new("RGB", (1, 1))
_WORKER: Renderer | None = None
_FRAMES_DIR: str | None = None
_WORKER_ERROR: str | None = None
_SLOTS: list | None = None         # spawned workers (Windows): shared-memory blocks the frames are put in

# RGB -> YUV with the BT.709 matrix, and the stream says so: players and browsers then show the colours
# as drawn (untagged, they guess, and red #c0392b came out orange)
_COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
_COLOR_VF_CACHE: list = []


def _color_vf() -> str:
    """The conversion filter; setparams also marks primaries and transfer (without it ffmpeg 6-9 wrote
    "bt709/unknown/unknown"), when this ffmpeg has it."""
    if not _COLOR_VF_CACHE:
        vf = "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p"
        try:
            r = subprocess.run(["ffmpeg", "-hide_banner", "-h", "filter=setparams"], capture_output=True, text=True, timeout=10)
            if "color_primaries" in (r.stdout or ""):
                vf += ",setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
        except (OSError, subprocess.TimeoutExpired):
            pass
        _COLOR_VF_CACHE.append(vf)
    return _COLOR_VF_CACHE[0]


def _frame_job(job: tuple) -> bytes:
    i, t = job
    if _WORKER_ERROR is not None:
        return b"!" + _WORKER_ERROR.encode("utf-8", "replace")
    img = _WORKER.frame(t)  # type: ignore[union-attr]
    if _FRAMES_DIR:
        # the PNG sequence is written in the same pass as the video (each worker saves its own frames)
        img.save(os.path.join(_FRAMES_DIR, f"{i:05d}.png"), compress_level=1)
    return img.tobytes()


def _slot_job(job: tuple) -> bytes:
    """A spawned worker (Windows) renders frame i into shared-memory block k: only a few bytes go through
    the pipe. Whole frames (11 MB in a message of 4) through Windows pipes failed under load (WinError
    1450) and left the pool's result thread dead — the render then waited for ever."""
    i, t, k = job
    data = _frame_job((i, t))
    if data[:1] == b"!" and _WORKER_ERROR is not None:
        return data
    _SLOTS[k].buf[:len(data)] = data  # type: ignore[index]
    return b""


class _PoolStopped(Exception):
    """The worker processes stopped delivering frames: the main process renders the rest from `index`."""

    def __init__(self, index: int, reason: str):
        super().__init__(reason)
        self.index = index


def _short(e: BaseException, n: int = 300) -> str:
    """An error as one short line (a failed pickling message can hold megabytes of frame bytes)."""
    text = f"{type(e).__name__}: {e}"
    return text if len(text) <= n else text[:n] + " …"


def _await(get, pool, index: int, limit: float):
    """get(timeout) of a pool result, watched: when it does not come within `limit` seconds, when the
    pool's result thread has died or a worker process has died (the pool starts a new one, but the frame
    it was drawing is lost), raises _PoolStopped (an error of the frame itself is raised as it is)."""
    start = time.monotonic()
    while True:
        try:
            return get(1.0)
        except mp.TimeoutError:
            handler = getattr(pool, "_result_handler", None)
            if handler is not None and not handler.is_alive():
                raise _PoolStopped(index, "the pool's result thread stopped") from None
            if any(w.exitcode is not None for w in getattr(pool, "_stickman_workers", ())):
                raise _PoolStopped(index, "a worker process died") from None
            if time.monotonic() - start > limit:
                raise _PoolStopped(index, f"no frame from the worker processes for {limit:.0f}s") from None
        except StopIteration:
            raise _PoolStopped(index, "the worker processes stopped early") from None
        except RenderError:
            raise
        except Exception as e:  # noqa: BLE001  (a broken pipe, a result that could not be sent)
            raise _PoolStopped(index, _short(e)) from None


def _fork_frames(pool, it, n: int, limit: float):
    """The frames from forked workers, in order (raw bytes through the pipe), watched."""
    for i in range(n):
        yield _await(it.next, pool, i, limit)


def _slot_frames(pool, slots: list, rest: list, frame_size: int, limit: float, first_extra: float):
    """The frames from spawned workers, in order: each is rendered into a shared-memory block; at most
    len(slots) frames are ahead of the one being written (a block is used again only after it was read)."""
    from collections import deque

    n_slots = len(slots)
    pending: deque = deque()
    nxt = 0

    def submit() -> None:
        nonlocal nxt
        i, t = rest[nxt]
        pending.append(pool.apply_async(_slot_job, ((i, t, nxt % n_slots),)))
        nxt += 1

    while nxt < len(rest) and len(pending) < n_slots:
        submit()
    for k in range(len(rest)):
        res = _await(pending.popleft().get, pool, k, limit + (first_extra if k == 0 else 0.0))
        if res[:1] == b"!":
            raise _PoolStopped(k, "a worker could not start: " + res[1:].decode("utf-8", "replace")[:300])
        data = bytes(slots[k % n_slots].buf[:frame_size])
        if nxt < len(rest):
            submit()
        yield data


def _stop_pool(pool) -> None:
    """Ends the worker processes without hanging: Pool.terminate can block for ever on a pipe that a
    broken worker left locked, so it gets 8 seconds, then the processes are killed."""
    import threading

    th = threading.Thread(target=pool.terminate, daemon=True)
    th.start()
    th.join(8)
    if th.is_alive():
        for w in list(getattr(pool, "_pool", []) or []):
            try:
                w.kill()
            except Exception:  # noqa: BLE001
                pass


def _frame_bytes(t: float) -> bytes:
    return _WORKER.frame(t).tobytes()  # type: ignore[union-attr]


def _spawn_init(path: str, fingerprint: list, ss: int, scale: float, fps: int, frames_dir: str | None, slots: list | None = None) -> None:
    """A worker process on systems without fork (Windows): it loads the scene file itself."""
    global _WORKER, _FRAMES_DIR, _WORKER_ERROR, _SLOTS
    sys.stdout = sys.stderr                                  # plugin print() must not reach the JSON on stdout
    try:
        from .scene import load_scene

        sc = load_scene(path)
        if _fingerprint(sc) != fingerprint:
            raise RenderError("the scene file changed since it was loaded")
        _WORKER = Renderer(sc, ss=ss, scale=scale)
        _WORKER.fps = fps
        _FRAMES_DIR = frames_dir
        if slots:
            from multiprocessing import shared_memory

            _SLOTS = [shared_memory.SharedMemory(name=n) for n in slots]
    except BaseException as e:  # noqa: BLE001  (reported through the first frame; the main process renders alone)
        _WORKER_ERROR = f"{type(e).__name__}: {e}"


def _spawn_ok() -> bool:
    """Spawned workers run the main script again (as __mp_main__): only safe for the studio-stickman
    command, whose script starts the CLI under `if __name__ == "__main__"` — not for any other caller."""
    main = os.path.basename(getattr(sys.modules.get("__main__"), "__file__", "") or "")
    return main in ("studio-stickman", "studio-stickman.py") or os.environ.get("STUDIO_STICKMAN_SPAWN") == "1"


def _fingerprint(sc: Scene) -> list:
    return [round(sc.duration, 4), len(sc.events), sorted(sc.figures), [round(k.t, 4) for k in sc.camera], sc.w, sc.h]


def frame_times(t0: float, t1: float, fps: int) -> list[float]:
    n = max(1, int(round((t1 - t0) * fps)))
    return [t0 + i / fps for i in range(n)]


def _raw_input(r: Renderer, fps: int) -> list[str]:
    return ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{r.W}x{r.H}", "-r", str(fps), "-i", "-"]


def _mp4_cmd(r: Renderer, fps: int, crf: int, audio_wav: Path | None, out: Path) -> list[str]:
    cmd = _raw_input(r, fps)
    if audio_wav:
        cmd += ["-i", str(audio_wav)]
    # flat-colour cartoon frames: -tune animation (also with style.grain: -tune grain kept the noise at
    # 1.4 times the file size); a key frame every 2 seconds for quick seeking; +faststart so it plays
    # while it downloads
    cmd += ["-vf", _color_vf(), "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-tune", "animation",
            "-g", str(max(2, 2 * fps)), "-pix_fmt", "yuv420p", *_COLOR_TAGS, "-movflags", "+faststart"]
    if audio_wav:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
    return cmd + [str(out)]


def _gif_vf(fps: int, width: int) -> str:
    return (f"fps={min(fps, 15)},scale={min(width, 640)}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];"
            "[s1][p]paletteuse=dither=bayer:bayer_scale=4")


def _webm_args() -> list[str]:
    # VP9 with row multithreading and the "good" speed preset: about 3 times faster than the defaults
    return ["-vf", _color_vf(), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
            "-pix_fmt", "yuv420p", *_COLOR_TAGS]


def render_video(scene: Scene, out: Path, *, t0: float, t1: float, fps: int, scale: float, ss: int, jobs: int, audio_wav: Path | None,
                 crf: int = 18, progress=None, frames_dir: Path | None = None, gif: Path | None = None, webm: Path | None = None) -> dict:
    """Renders the scene to an MP4 (H.264, BT.709). In the same pass, optionally: every frame as
    frames_dir/00000.png …, a GIF and a WebM — all made from the rendered frames, not from the MP4.
    Worker processes render in parallel; when they stop delivering frames (a watchdog), the main process
    renders the rest — the frames already written are kept — and info["warnings"] says so."""
    global _WORKER, _FRAMES_DIR, _WORKER_ERROR
    if not shutil.which("ffmpeg"):
        raise RenderError("ffmpeg is not installed — cannot write video (use: studio-stickman still … for pictures)")
    r = Renderer(scene, ss=ss, scale=scale)
    r.fps = fps
    times = frame_times(t0, t1, fps)
    out.parent.mkdir(parents=True, exist_ok=True)
    fdir = None
    if frames_dir is not None:
        Path(frames_dir).mkdir(parents=True, exist_ok=True)
        fdir = str(frames_dir)
    cmds = [_mp4_cmd(r, fps, crf, audio_wav, out)]
    if gif is not None:
        Path(gif).parent.mkdir(parents=True, exist_ok=True)
        cmds.append(_raw_input(r, fps) + ["-filter_complex", _gif_vf(fps, r.W), "-loop", "0", str(gif)])
    if webm is not None:
        Path(webm).parent.mkdir(parents=True, exist_ok=True)
        cmd = _raw_input(r, fps) + (["-i", str(audio_wav)] if audio_wav else []) + _webm_args()
        cmds.append(cmd + (["-c:a", "libopus", "-b:a", "128k", "-shortest"] if audio_wav else []) + [str(webm)])
    jobs = min(max(1, int(jobs)), _memory_jobs(r.size[0] * r.size[1] * 3))
    errs = [tempfile.TemporaryFile() for _ in cmds]
    pool = None
    procs: list = []
    work = list(enumerate(times))
    codes: list[int] = []
    warnings: list[str] = []
    frame_size = r.W * r.H * 3
    slots: list = []
    used_pool = False
    try:
        _WORKER, _FRAMES_DIR, _WORKER_ERROR = r, fdir, None
        # the first frame in this process: it also tells how long a frame takes (the watchdog's patience)
        t_first = time.perf_counter()
        first = _frame_job(work[0])
        per_frame = time.perf_counter() - t_first
        rest = work[1:]
        frames_from_pool = None
        # the workers are forked BEFORE ffmpeg starts: otherwise they would inherit its input pipe
        # and ffmpeg would wait forever for the end of the video
        if jobs > 1 and len(times) > 8 and "fork" in mp.get_all_start_methods():
            pool = mp.get_context("fork").Pool(jobs)
            pool._stickman_workers = list(pool._pool)  # type: ignore[attr-defined]
            frames_from_pool = _fork_frames(pool, pool.imap(_frame_job, rest, chunksize=4), len(rest), max(30.0, 100 * per_frame))
        elif jobs > 1 and len(times) >= 90 and _spawn_ok() and getattr(scene, "path", None) and Path(scene.path).is_file():
            # no fork (Windows): workers that load the scene file themselves and hand each frame over in
            # shared memory; if they fail, the main process renders alone
            try:
                from multiprocessing import shared_memory

                n = min(jobs, 8)
                n_slots = max(n + 1, min(2 * n + 2, (512 << 20) // max(1, frame_size)))
                slots = [shared_memory.SharedMemory(create=True, size=frame_size) for _ in range(n_slots)]
                pool = mp.get_context("spawn").Pool(n, initializer=_spawn_init,
                                                    initargs=(str(Path(scene.path).resolve()), _fingerprint(scene), r.ss, r.scale, fps, fdir,
                                                              [sl.name for sl in slots]))
                pool._stickman_workers = list(pool._pool)  # type: ignore[attr-defined]
                # starting a worker loads Python, the plugins and the scene: the first frame may take longer
                frames_from_pool = _slot_frames(pool, slots, rest, frame_size, max(30.0, 25 * per_frame), 120.0)
            except Exception as e:  # noqa: BLE001
                log(f"  parallel rendering is not available ({_short(e)}); rendering in one process")
                if pool:
                    _stop_pool(pool)
                pool, frames_from_pool = None, None
        used_pool = pool is not None

        def produce():
            nonlocal pool
            yield first
            done = 0
            if frames_from_pool is not None:
                try:
                    for data in frames_from_pool:
                        yield data
                        done += 1
                except _PoolStopped as e:
                    # what was rendered stays; the rest is rendered here (the tool says so)
                    msg = (f"parallel rendering stopped at frame {done + 2} of {len(times)} ({e}); "
                           f"the remaining {len(rest) - done} frames were rendered in one process")
                    log("  " + msg)
                    warnings.append(msg)
                    _stop_pool(pool)
                    pool = None
            for w in rest[done:]:
                yield _frame_job(w)

        frames = produce()
        procs = [subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=err) for cmd, err in zip(cmds, errs)]
        for i, data in enumerate(frames):
            if data[:1] == b"!" and len(data) != frame_size:
                raise RenderError(f"a render worker failed: {data[1:].decode('utf-8', 'replace')[:500]}")
            alive = 0
            for p in procs:
                if p.stdin.closed:  # type: ignore[union-attr]
                    continue
                try:
                    p.stdin.write(data)  # type: ignore[union-attr]
                    alive += 1
                except (BrokenPipeError, OSError):
                    p.stdin.close()  # type: ignore[union-attr]
            if not alive:
                break
            if progress and (i % max(1, len(times) // 20) == 0):
                progress(i, len(times))
        for p in procs:
            try:
                p.stdin.close()  # type: ignore[union-attr]
            except OSError:
                pass
        codes = [p.wait() for p in procs]
    except BaseException:
        for p in procs:
            p.kill()
        for p in procs:
            try:
                p.wait(10)                             # it lets go of the audio file before that is deleted
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        if pool:
            _stop_pool(pool)
        _WORKER, _FRAMES_DIR, _WORKER_ERROR = None, None, None
        for sl in slots:
            try:
                sl.close()
                sl.unlink()
            except Exception:  # noqa: BLE001
                pass
    for code, err, kind in zip(codes, errs, ["mp4", "gif" if gif is not None else "webm", "webm"]):
        if code != 0:
            err.seek(0)
            raise RenderError(f"ffmpeg ({kind}) failed: {err.read().decode('utf-8', 'replace').strip()[-500:]}")
    info = {"frames": len(times), "width": r.W, "height": r.H, "jobs": jobs if used_pool else 1}
    if warnings:
        info["warnings"] = warnings
    if gif is not None:
        info["gif"] = str(gif)
    if webm is not None:
        info["webm"] = str(webm)
    if fdir:
        info["frames_dir"] = fdir
    return info


def convert(src: Path, dst: Path, kind: str, fps: int, width: int) -> None:
    """GIF or WebM from a video file (render_video(gif=…, webm=…) makes them from the frames instead, which
    is better: no second lossy step)."""
    if kind == "gif":
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-filter_complex", _gif_vf(fps, width), "-loop", "0", str(dst)]
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), *_webm_args(), "-c:a", "libopus", str(dst)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RenderError(f"ffmpeg ({kind}) failed: {r.stderr.decode('utf-8', 'replace').strip()[-400:]}")


# ---------------------------------------------------------------------------
# Pictures the AI looks at
# ---------------------------------------------------------------------------
def key_moments(scene: Scene, t0: float, t1: float, count: int) -> list[float]:
    """Times worth looking at: the end (how the scene ends), just after hits, a moment after someone
    starts talking (the bubble is open), the starts of actions — then the biggest gaps between those are
    filled, so no part of the scene is left out."""
    span = max(1e-6, t1 - t0)
    count = max(1, int(count))
    inside = lambda v: t0 <= v < t1  # noqa: E731
    hits = sorted(min(t1 - 1e-3, ev["t"] + 0.1) for ev in scene.events if ev["kind"] == "hit" and inside(ev["t"]))
    talk = sorted(min(t1 - 1e-3, ev["t"] + 0.25) for ev in scene.events if ev["kind"] in ("say", "text", "title", "caption") and inside(ev["t"]))
    acts = []
    for it in getattr(scene, "script", []) or []:
        if str(it.get("what", "")).startswith("do ") and inside(it["t"]):
            acts.append(min(t1 - 1e-3, it["t"] + min(0.35, max(0.0, it.get("end", it["t"]) - it["t"]) * 0.5)))
    even = [t0 + span * (i + 0.5) / count for i in range(count)]
    gap = span / (count * 3.0)
    # the end always has a cell (events filled every cell before and the last 2 s were never shown)
    picked: list[float] = [round(t1 - min(0.3, 0.05 * span), 3)] if count > 1 else []

    def take(cands: list, quota: int) -> None:
        cands = sorted(set(round(c, 3) for c in cands))
        if len(cands) > quota:                          # more than room: spread the choice over the scene
            cands = [cands[round(i * (len(cands) - 1) / max(1, quota - 1))] for i in range(quota)]
        n = 0
        for c in cands:
            if len(picked) >= count or n >= quota:
                return
            if all(abs(c - p) > gap for p in picked):
                picked.append(c)
                n += 1

    take(hits, math.ceil(count * 0.5))
    take(talk, math.ceil(count * 0.35))
    take(acts, count)
    # the rest: always the evenly spaced time farthest from every picked one (in time order they all
    # went to the start)
    while len(picked) < count:
        if not picked:
            picked.append(round(even[len(even) // 2], 3))
            continue
        best = max(even, key=lambda e: min(abs(e - p) for p in picked))
        if min(abs(best - p) for p in picked) <= gap:
            break
        picked.append(round(best, 3))
    return sorted(picked)[:count]


def _ellipsize(c: Canvas, s: str, size: float, w: float, font_name: str = "mono") -> str:
    if c.text_size(s, size, font_name)[0] <= w:
        return s
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if c.text_size(s[:mid] + "…", size, font_name)[0] <= w:
            lo = mid
        else:
            hi = mid - 1
    return s[:lo] + "…"


def _labels(scene: Scene, r: Renderer, t: float) -> tuple[str, str]:
    """Two lines under a thumbnail: the time and what each figure does (action, expression); then the
    words on screen (speech, captions, titles, hit words) in full."""
    parts = []
    script = getattr(scene, "script", []) or []
    for f in scene.figures.values():
        try:
            st = f.state(t)
        except Exception:  # noqa: BLE001
            continue
        if not st.get("visible", True):
            continue
        doing = [it for it in script if it.get("who") == f.name and it["t"] - 1e-6 <= t <= max(it.get("end", it["t"]), it["t"] + 0.3)]
        what = str(doing[-1]["what"]).split() if doing else []
        act = (what[1] if what and what[0] == "do" and len(what) > 1 else what[1] if len(what) > 1 and what[0] == "pose" else "")
        parts.append(f"{f.name}{(' ' + act) if act else ''} ({st.get('expr', 'calm')})")
    words = []
    for s in r.says:
        if s["t"] <= t < s["t"] + s["dur"]:
            words.append(f'{s.get("who") or ""}: "{s["value"]}"' if s.get("who") else f'"{s["value"]}"')
    for cap in r.captions:
        if cap["t"] <= t < cap["t"] + cap["dur"]:
            words.append(f'[{cap["value"]}]')
    for ti in r.titles:
        if ti["t"] <= t < ti["t"] + float(ti["dur"]):
            words.append(f'TITLE {ti["value"]}')
    for tx in r.texts:
        if tx["t"] - 0.02 <= t < tx["t"] + float(tx["dur"]):
            words.append(str(tx["text"]))
    for ev in scene.events:
        if ev["kind"] == "hit" and -0.02 <= t - ev["t"] < 0.25 and not ev.get("word"):
            v = ev["value"]
            words.append(f"hit {v.get('on')}" if isinstance(v, dict) else "hit")
    return (f"{scene.clock.label(t)}  " + " · ".join(parts), "  ".join(words))


def contact_sheet(scene: Scene, times: list[float], path: Path, cols: int = 4, thumb_w: int = 560, title: str | None = None,
                  focus: str | None = None, labels: bool = True, onion: int = 0, markers: bool = False) -> dict:
    """A grid of frames to look at. focus: None = the whole frame as the video shows it; "action" = a
    close-up around the figures in the picture; a figure's name = around that figure. labels: what
    happens under each frame (time, actions, expressions, the words on screen). onion: that many earlier
    poses (every second frame) drawn faintly behind; markers: floor line, x ticks, feet and hands."""
    thumb_w = max(120, int(thumb_w))
    r = Renderer(scene, ss=2, scale=thumb_w / scene.w)
    tw, th = r.W, r.H
    times = list(times) or [0.0]
    cols = max(1, min(int(cols), len(times)))
    rows = math.ceil(len(times) / cols)
    pad, head_h = 8, 40
    lsize = 13 if tw >= 360 else 11
    label_h = (lsize * 2 + 14) if labels else 0
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, head_h + rows * (th + label_h + pad) + pad), (13, 16, 22))
    c = Canvas(sheet)
    head = title or f"{scene.title} — {scene.duration:g}s, {scene.fps} fps, {scene.w}×{scene.h}" + (f"   close-ups: {focus}" if focus else "")
    c.text(_ellipsize(c, head, 17, sheet.width - 2 * pad, "bold"), pad + 2, head_h / 2, 17, "#e7e9ee", "lm", "bold")
    for i, t in enumerate(times):
        x = pad + (i % cols) * (tw + pad)
        y = head_h + (i // cols) * (th + label_h + pad)
        view = r.focus_view(t, focus) if focus else None
        ghosts = [t - (k + 1) * 2.0 / scene.fps for k in range(max(0, int(onion)))]
        sheet.paste(r.frame(t, view=view, ghosts=[g for g in ghosts if g >= 0], markers=markers), (x, y))
        if view is not None:
            c.rect(x + tw - 9, y + 3, 6, 6, fill="#ffb02e")      # a close-up, not the camera's picture
        if labels:
            l1, l2 = _labels(scene, r, t)
            c.text(_ellipsize(c, l1, lsize, tw - 6), x + 3, y + th + 4, lsize, "#c9d1e0", "lt", "mono")
            if l2:
                c.text(_ellipsize(c, l2, lsize, tw - 6), x + 3, y + th + 6 + lsize + 2, lsize, "#f3d36b", "lt", "mono")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(path))
    return {"path": str(path), "cell": [tw, th]}


def pose_sheet(names: list[str], path: Path, cell: int = 200) -> None:
    """All poses side by side with their names — a catalogue to look at."""
    from .scene import load_scene_text

    cols = min(8, max(1, math.ceil(math.sqrt(len(names) * 1.6))))
    rows = math.ceil(len(names) / cols)
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 22)), (236, 232, 222))
    lc = Canvas(sheet)
    for i, name in enumerate(names):
        text = json.dumps({
            "scene": {"size": [380, 380], "background": {"use": "plain", "color": "#ece8de", "floor": "#d8d2c2"}, "floor": 340, "style": {"vignette": 0, "shadow": True}},
            "figures": {"f": {"color": "#18181c", "x": 190, "pose": name, "fx": "still"}},
        })
        sc = load_scene_text(text, "pose.stick.yaml")
        img = Renderer(sc, ss=2, scale=cell / 380).frame(0.0)
        x, y = (i % cols) * cell, (i // cols) * (cell + 22)
        sheet.paste(img, (x, y))
        lc.text(name, x + cell / 2, y + cell + 11, 14, "#18181c", "mm", "mono")
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(path))


def validate_text(scene: Scene) -> list[str]:
    """Warnings ("<where>: <message>") about what is drawn, for `check`: words on screen with characters
    that no installed font has (they would show as empty boxes), comic words bigger than the picture
    (drawn smaller), and fades that leave the picture covered."""
    out = []
    mc = Canvas(_MEASURE_IMG)
    for ev in scene.events:
        word, kind = (ev.get("word"), "italic") if ev["kind"] == "hit" else (ev.get("value"), ev.get("font") or "bold") if ev["kind"] == "text" else (None, "")
        if word and not (ev["kind"] == "text" and ev.get("ui")) and ev.get("size"):
            w, h = mc.text_size(str(word), float(ev["size"]), kind if kind in ("bold", "regular", "italic", "mono") else "bold")
            over = max(w / (scene.w - 20), h / (scene.h - 20))
            if over > 1.0:
                out.append(f'{ev.get("_where", "events")}: "{word}" at size {float(ev["size"]):g} does not fit the picture ({over:.1f} times too big) — '
                           f"it is drawn at the largest size that fits (about {float(ev['size']) / over:.0f})")
    out += _fade_warnings(scene)
    for ev in scene.events:
        vals = []
        if ev["kind"] in ("text", "say", "caption", "title") and ev.get("value") is not None:
            vals.append((str(ev["value"]), "italic" if ev.get("font") == "italic" else "bold"))
        if ev["kind"] == "hit" and ev.get("word"):
            vals.append((str(ev["word"]), "italic"))
        if ev["kind"] == "title" and ev.get("sub"):
            vals.append((str(ev["sub"]), "regular"))
        for v, kind in vals:
            miss = missing_glyphs(v, kind if kind in ("bold", "regular", "italic", "mono") else "bold")
            if miss:
                out.append(f'{ev.get("_where", "events")}: the characters {miss} are in no installed font — they show as empty boxes')
    return out


def _fade_warnings(scene: Scene) -> list[str]:
    """A fade-out that nothing brings back long before the end, and a fade-in that first cuts to its
    colour in the middle of the scene: both are drawn as written, but are seldom what was meant."""
    fades = sorted((ev for ev in scene.events if ev["kind"] == "fade"), key=lambda ev: ev["t"])
    out = []
    for i, ev in enumerate(fades):
        t0, dur = float(ev["t"]), float(ev.get("dur") or 0)
        where = ev.get("_where", "events")
        later_in = any(e["value"] == "in" for e in fades[i + 1:])
        if ev["value"] == "out" and not later_in and t0 + dur < scene.duration - 0.5:
            out.append(f"{where}: after this fade-out the picture stays covered from {t0 + dur:g}s to the end ({scene.duration:g}s) — "
                       "add a `fade: in` later to bring it back")
        if ev["value"] == "in" and t0 > 0.001 and not any(e["value"] == "out" for e in fades[:i]):
            out.append(f"{where}: no fade-out before this fade-in — the picture cuts to the fade colour at {t0:g}s and then fades in "
                       "(to open the scene from it, put the fade-in at t: 0)")
    return out


# ---------------------------------------------------------------------------
# Sprite sheets (a figure alone on a transparent background, for games)
# ---------------------------------------------------------------------------
def _figure_rgba(scene: Scene, fig, t: float, m: tuple, size: tuple, held) -> Image.Image:
    """Draws the figure on black and on white and recovers the transparency from the difference."""
    st, P = fig.joints(t)
    st["_t"] = t
    style = {**scene.style, "shadow": False}
    layers = []
    for bg in ((0, 0, 0), (255, 255, 255)):
        img = Image.new("RGB", size, bg)
        hd = {"R": [], "L": []}
        for p in held:
            if p.t_from <= t < p.t_to:
                hd[p.hand].append(Renderer._held_fn(None, p, P, t))  # type: ignore[arg-type]
        draw_figure(Canvas(img, m), fig, st, P, style, scene.floor, hd)
        layers.append(np.asarray(img, dtype=np.float32))
    black, white = layers
    alpha = np.clip(1 - (white - black).mean(axis=2) / 255, 0, 1)
    rgb = np.where(alpha[..., None] > 1e-3, black / np.maximum(alpha[..., None], 1e-3), 0)
    out = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def sprite_sheet(scene: Scene, figure: str, t0: float, t1: float, frames: int, cell: int, out_png: Path, cols: int | None = None) -> dict:
    fig = scene.figures[figure]
    times = [t0 + (t1 - t0) * i / frames for i in range(frames)]
    held = [p for p in scene.props if p.held_by == figure]
    # 1. a first guess of the box from the joints, measured from the figure's own position: the figure
    # stays in place in every cell (the distance it travels is kept as "dx" per frame)
    xs, ys, roots = [], [], []
    for t in times:
        st, P = fig.joints(t)
        rx = st["x"]
        roots.append(rx)
        for n, v in P.items():
            if not n.startswith("_") and isinstance(v, tuple):
                xs.append(v[0] - rx)
                ys.append(v[1])
        r = P["_head_r"]
        xs += [P["head"][0] - rx - r, P["head"][0] - rx + r]
        ys += [P["head"][1] - r * 2.2, P["head"][1] + r]
    margin = fig.line * fig.scale * 2.2
    half = max(abs(min(xs)), abs(max(xs))) + margin
    y0, y1 = min(ys) - margin, max(max(ys) + margin, scene.floor + 2)
    # 2. draw every frame on a canvas three times that size and measure what was really drawn: held
    # props (a sword, a flag), hats and capes stick out of the joint box and were cut off before
    k0 = 96.0 / max(2 * half, y1 - y0)
    cw, ch = int(6 * half * k0) + 4, int(3 * (y1 - y0) * k0) + 4
    oy0 = (y1 - y0) * k0                                 # the joint box sits in the middle third
    ux0 = uy0 = math.inf
    ux1 = uy1 = -math.inf
    for i, t in enumerate(times):
        m = (k0, 0.0, 0.0, k0, cw / 2 - roots[i] * k0, oy0 - y0 * k0)
        box = _figure_rgba(scene, fig, t, m, (cw, ch), held).getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
        if box:
            ux0, ux1 = min(ux0, (box[0] - cw / 2) / k0), max(ux1, (box[2] - cw / 2) / k0)
            uy0, uy1 = min(uy0, (box[1] - oy0) / k0 + y0), max(uy1, (box[3] - oy0) / k0 + y0)
    if ux0 < ux1:
        pad = 2.5 / k0
        half = max(abs(ux0), abs(ux1)) + pad
        y0, y1 = uy0 - pad, max(uy1 + pad, scene.floor + 2)
    ss = 2
    k = cell / max(2 * half, y1 - y0)
    cols = cols or min(frames, 8)
    rows = math.ceil(frames / cols)
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))
    atlas = []
    oy = cell - (y1 - y0) * k
    for i, t in enumerate(times):
        m = (k * ss, 0.0, 0.0, k * ss, (cell / 2 - roots[i] * k) * ss, (oy - y0 * k) * ss)
        img = _figure_rgba(scene, fig, t, m, (cell * ss, cell * ss), held).reduce(ss)
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(img, (x, y))
        atlas.append({"frame": i, "x": x, "y": y, "w": cell, "h": cell, "t": round(t, 4), "dx": round((roots[i] - roots[0]) * k, 2)})
    out_png.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(out_png))
    meta = {
        "image": out_png.name, "figure": figure, "cell": cell, "columns": cols, "rows": rows, "frames": atlas,
        "fps": round(frames / max(1e-6, t1 - t0), 3), "seconds": round(t1 - t0, 4),
        # where the feet stand inside a cell (put this point on the ground in the game)
        "anchor": {"x": round(cell / 2, 2), "y": round(oy + (scene.floor - y0) * k, 2)},
        "pixels_per_unit": round(k, 4),
    }
    out_png.with_suffix(".json").write_text(json.dumps(meta, indent=2), "utf-8")
    return meta


# ---------------------------------------------------------------------------
# How many processes
# ---------------------------------------------------------------------------
def _cgroup_cpus() -> float | None:
    """The CPU limit of the container (Docker --cpus), when there is one."""
    try:
        q, p = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]          # cgroup v2: "200000 100000" or "max 100000"
        return None if q == "max" else int(q) / int(p)
    except (OSError, ValueError):
        pass
    try:
        q = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())        # cgroup v1
        p = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
        return q / p if q > 0 and p > 0 else None
    except (OSError, ValueError):
        return None


def _memory_jobs(frame_bytes: int) -> int:
    """How many render processes the free memory allows (each holds a few frame-sized pictures; at 4K
    with supersampling one frame is 100 MB)."""
    avail = None
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                avail = int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    try:
        lim = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        if lim != "max":
            used = int(Path("/sys/fs/cgroup/memory.current").read_text())
            avail = min(avail or 1 << 62, int(lim) - used)
    except (OSError, ValueError):
        pass
    if not avail:
        return 64
    return max(1, int(avail * 0.7 // (frame_bytes * 5 + 80 * 1024 * 1024)))


def default_jobs() -> int:
    try:
        n = len(os.sched_getaffinity(0))
    except AttributeError:
        n = os.cpu_count() or 2
    cg = _cgroup_cpus()
    if cg:
        n = min(n, max(1, math.ceil(cg)))
    return max(1, min(8, n))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
