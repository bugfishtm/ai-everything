"""Rendering: every frame is composed in Python (clips → transition → overlays) and piped to
ffmpeg; the sound is mixed with numpy and added in the same encode."""
from __future__ import annotations

import bisect
import math
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from . import registry
from .media import SR, MediaError, VideoReader, decode_audio, open_image
from .timeline import Clip, Overlay, Timeline, VideoError, fmt_time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
import studio_gfx as gfx  # noqa: E402


class RenderError(Exception):
    pass


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


# ---------------------------------------------------------------------------
# Clip sources
# ---------------------------------------------------------------------------
class Source:
    def frame(self, t: float) -> Image.Image:  # pragma: no cover
        raise NotImplementedError

    def close(self) -> None:
        pass


class StillSource(Source):
    """A picture, optionally with a slow zoom / pan (Ken Burns)."""

    def __init__(self, img: Image.Image, size: tuple[int, int], clip: Clip, tl: Timeline, bg: Image.Image):
        self.size, self.dur = size, max(clip.dur, 1e-6)
        z = clip.spec.get("zoom")
        self.z0, self.z1 = (float(z[0]), float(z[1])) if isinstance(z, list) else ((float(z), float(z)) if z else (1.0, 1.0))
        p = clip.spec.get("pan")
        if p is None:
            self.p0 = self.p1 = (0.5, 0.5)
        else:
            pts = p if isinstance(p, list) and len(p) == 2 and not all(isinstance(x, (int, float)) for x in p) else [p, p]
            self.p0, self.p1 = tl.position(pts[0], "pan"), tl.position(pts[1], "pan")
        self.moving = (self.z0, self.p0) != (self.z1, self.p1) or self.z0 != 1.0 or self.p0 != (0.5, 0.5)
        w, h = size
        zmax = max(self.z0, self.z1, 1.0)
        # the picture fitted to the frame at the largest zoom that is needed (kept sharp while zooming)
        big = (int(math.ceil(w * zmax)), int(math.ceil(h * zmax)))
        if clip.fit == "contain":
            fitted = gfx.fit(img, big, "contain", (0, 0, 0, 0))
            base = bg.resize(big, Image.BILINEAR).convert("RGBA")
            base.alpha_composite(fitted)
            self.big = base.convert("RGB")
        else:
            flat = Image.new("RGBA", img.size, (0, 0, 0, 255))
            flat.alpha_composite(img)
            self.big = gfx.fit(flat, big, clip.fit).convert("RGB")
        self.static = None if self.moving else self.big.resize(size, Image.LANCZOS) if self.big.size != size else self.big

    def frame(self, t: float) -> Image.Image:
        if self.static is not None:
            return self.static
        u = min(1.0, max(0.0, t / self.dur))
        u = u * u * (3 - 2 * u)
        z = self.z0 + (self.z1 - self.z0) * u
        px, py = self.p0[0] + (self.p1[0] - self.p0[0]) * u, self.p0[1] + (self.p1[1] - self.p0[1]) * u
        # `big` shows the whole picture (zoom 1); at zoom z a part of 1/z of its width and height fills the frame
        W, H = self.big.size
        z = max(1.0, z)
        cw, ch = W / z, H / z
        x0, y0 = (W - cw) * px, (H - ch) * py
        return self.big.resize(self.size, Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))


class GeneratorSource(Source):
    def __init__(self, entry: registry.Entry, params: dict, size: tuple[int, int], where: str):
        self.e, self.p, self.size, self.where = entry, params, size, where

    def frame(self, t: float) -> Image.Image:
        try:
            out = self.e.fn(t, self.size[0], self.size[1], self.p)
        except Exception as ex:  # noqa: BLE001
            raise RenderError(f'{self.where}: generator "{self.e.name}" failed: {type(ex).__name__}: {ex}') from None
        if isinstance(out, np.ndarray):
            out = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
        if not isinstance(out, Image.Image):
            raise RenderError(f'{self.where}: generator "{self.e.name}" must return a picture')
        out = out.convert("RGB")
        return out if out.size == self.size else out.resize(self.size, Image.BILINEAR)


class TitleSource(Source):
    """A card with a title and a line below it; the text can rise, fade or zoom in."""

    def __init__(self, clip: Clip, size: tuple[int, int], k: float, bg: Image.Image, tl: Timeline):
        self.size, self.bg = size, bg
        s = clip.spec
        w, h = size
        tsize = float(s.get("size", tl.h / 7.5)) * k
        col = gfx.color(s.get("color", "#ffffff"))
        f_title = gfx.font(s.get("font", "bold"), tsize, tl.base, registry.pack_file)
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        align = str(s.get("align", "center"))
        x = w / 2 if align == "center" else (w * 0.08 if align == "left" else w * 0.92)
        sub = str(s["sub"]) if s.get("sub") else ""
        y = h / 2 - (tsize * 0.35 if sub else 0)
        shadow = {"dx": 0, "dy": tsize * 0.05, "blur": tsize * 0.12, "color": (0, 0, 0, 150)}
        gfx.draw_text(layer, str(s["title"]), (x, y), f_title, col, anchor=align, valign="middle", max_width=w * 0.86, shadow=shadow)
        if sub:
            f_sub = gfx.font("sans", tsize * 0.36, tl.base, registry.pack_file)
            b = gfx.text_block(str(s["title"]), f_title, w * 0.86)
            gfx.draw_text(layer, sub, (x, y + b["height"] / 2 + tsize * 0.3), f_sub, gfx.with_alpha(col, 0.82), anchor=align, valign="top", max_width=w * 0.8)
        self.text = layer
        self.mode = str(s.get("animate", "rise"))
        self.rise = tsize * 0.35
        self.static = None
        if self.mode == "none":
            self.static = self._compose(1.0, 0.0, 1.0)

    def _compose(self, alpha: float, dy: float, zoom: float) -> Image.Image:
        t = self.text
        if zoom != 1.0:
            w, h = self.size
            zw, zh = max(2, int(w * zoom)), max(2, int(h * zoom))
            z = t.resize((zw, zh), Image.BILINEAR)
            t = Image.new("RGBA", self.size, (0, 0, 0, 0))
            t.paste(z, ((w - zw) // 2, (h - zh) // 2))
        if dy:
            t = gfx.shifted(t, 0, dy)
        if alpha < 0.999:
            t = t.copy()
            t.putalpha(t.getchannel("A").point(lambda v: int(v * max(0.0, alpha))))
        out = self.bg.convert("RGBA")
        out.alpha_composite(t)
        return out.convert("RGB")

    def frame(self, t: float) -> Image.Image:
        if self.static is not None:
            return self.static
        u = min(1.0, max(0.0, t / 0.6))
        e = 1 - (1 - u) ** 3
        if u >= 1.0:
            self.static = self._compose(1.0, 0.0, 1.0)
            return self.static
        if self.mode == "fade":
            return self._compose(e, 0.0, 1.0)
        if self.mode == "zoom":
            return self._compose(e, 0.0, 0.86 + 0.14 * e)
        return self._compose(e, self.rise * (1 - e), 1.0)


# ---------------------------------------------------------------------------
# Compositor
# ---------------------------------------------------------------------------
class Compositor:
    def __init__(self, tl: Timeline, scale: float = 1.0, fps: int | None = None):
        self.tl = tl
        self.k = scale
        self.W, self.H = _even(tl.w * scale), _even(tl.h * scale)
        self.size = (self.W, self.H)
        self.fps = fps or tl.fps
        self.starts = [c.start for c in tl.clips]
        self.sources: dict[int, Source] = {}
        self.blank = Image.new("RGB", self.size, tl.background[:3])
        self.sprites: dict[int, tuple[Image.Image, int, int]] = {}
        self.subs = [Overlay("text", {"text": s["text"], "at": [tl.w / 2, tl.h * 0.93], "valign": "bottom", "size": tl.sub_style["size"], "font": "sans",
                                      "color": tl.sub_style["color"], "box": tl.sub_style["box"], "width": tl.w * 0.84}, s["t0"], s["t1"], 0.08, 0.08, "subtitles")
                     for s in tl.subtitles]
        self.overlays = list(tl.overlays) + self.subs
        self._faded: dict[tuple[int, int], Image.Image] = {}

    # -- backgrounds, sources -----------------------------------------------------------
    def _bg(self, spec) -> Image.Image:
        if spec is None:
            return self.blank
        if isinstance(spec, dict) and "gradient" in spec:
            return gfx.gradient(self.size, spec["gradient"], float(spec.get("angle", 90)), str(spec.get("kind", "linear"))).convert("RGB")
        if isinstance(spec, dict) and "image" in spec:
            img = open_image(self.tl.file(spec["image"], "background"))
            flat = Image.new("RGBA", img.size, (0, 0, 0, 255))
            flat.alpha_composite(img)
            out = gfx.fit(flat, self.size, "cover").convert("RGB")
            dim = float(spec.get("dim", 0))
            return ImageEnhance.Brightness(out).enhance(1 - dim) if dim else out
        return Image.new("RGB", self.size, gfx.color(spec)[:3])

    def _source(self, i: int) -> Source:
        s = self.sources.get(i)
        if s is not None:
            return s
        c = self.tl.clips[i]
        try:
            if c.kind in ("file", "scene"):
                s = VideoReader(c.path, self.size, self.fps, c.src_from, c.speed, c.fit, self.tl.background)  # type: ignore[arg-type]
            elif c.kind in ("image", "picture"):
                s = StillSource(open_image(c.path), self.size, c, self.tl, self._bg(c.spec.get("background")))  # type: ignore[arg-type]
            elif c.kind == "title":
                bg = self._bg(c.spec.get("background"))
                dim = float(c.spec.get("dim", 0))
                s = TitleSource(c, self.size, self.k, ImageEnhance.Brightness(bg).enhance(1 - dim) if dim else bg, self.tl)
            elif c.kind == "color":
                img = Image.new("RGB", self.size, gfx.color(c.spec["color"])[:3])
                s = _Fixed(img)
            else:
                e = registry.GENERATORS[str(c.spec["generator"])]
                s = GeneratorSource(e, {**e.params, **{k: v for k, v in c.spec.items() if k in e.params}}, self.size, c.where)
        except (MediaError, gfx.GfxError) as ex:
            raise RenderError(f"{c.where}: {ex}") from None
        self.sources[i] = s
        return s

    def _clip_frame(self, i: int, local: float) -> Image.Image:
        c = self.tl.clips[i]
        try:
            img = self._source(i).frame(min(max(0.0, local), max(0.0, c.dur - 0.5 / self.fps)))
        except MediaError as ex:
            raise RenderError(f"{c.where}: {ex}") from None
        if c.look:
            lk = c.look
            if "brightness" in lk:
                img = ImageEnhance.Brightness(img).enhance(lk["brightness"])
            if "contrast" in lk:
                img = ImageEnhance.Contrast(img).enhance(lk["contrast"])
            if "saturation" in lk:
                img = ImageEnhance.Color(img).enhance(lk["saturation"])
            if lk.get("grayscale"):
                img = Image.blend(img, ImageOps.grayscale(img).convert("RGB"), min(1.0, lk["grayscale"]))
            if lk.get("blur"):
                img = img.filter(ImageFilter.GaussianBlur(lk["blur"] * self.k))
        f = 1.0
        if c.fade_in > 0 and local < c.fade_in:
            f = min(f, local / c.fade_in)
        if c.fade_out > 0 and local > c.dur - c.fade_out:
            f = min(f, max(0.0, (c.dur - local) / c.fade_out))
        if f < 0.999:
            img = Image.blend(self.blank, img, max(0.0, f))
        return img

    # -- overlays ---------------------------------------------------------------------------
    def _sprite(self, idx: int, o: Overlay) -> tuple[Image.Image, int, int]:
        sp = self.sprites.get(idx)
        if sp is not None:
            return sp
        k, s = self.k, o.spec
        layer = Image.new("RGBA", self.size, (0, 0, 0, 0))
        try:
            if o.kind == "text":
                size = float(s.get("size", self.tl.h / 15)) * k
                f = gfx.font(s.get("font", "bold"), size, self.tl.base, registry.pack_file)
                at = s.get("at", [self.tl.w / 2, self.tl.h / 2])
                text = str(s["text"]).upper() if s.get("upper") else str(s["text"])
                box = s.get("box")
                box_spec = None
                if box not in (None, False):
                    b = box if isinstance(box, dict) else {"color": "#000000aa" if box is True else box}
                    box_spec = {"color": gfx.color(b.get("color", "#000000aa")), "padding": float(b.get("padding", size / k * 0.4)) * k, "radius": float(b.get("radius", size / k * 0.22)) * k}
                sh = s.get("shadow", box_spec is None)
                shadow = None
                if sh not in (None, False):
                    d = sh if isinstance(sh, dict) else {}
                    shadow = {"dx": float(d.get("dx", 0)) * k, "dy": float(d.get("dy", size / k * 0.06)) * k, "blur": float(d.get("blur", size / k * 0.12)) * k, "color": gfx.color(d.get("color", "#000000b0"))}
                stroke = gfx.color(s["stroke"]) if s.get("stroke") not in (None, False) else None
                gfx.draw_text(layer, text, (float(at[0]) * k, float(at[1]) * k), f, gfx.color(s.get("color", "#ffffff")), anchor=str(s.get("anchor", "center")),
                              valign=str(s.get("valign", "middle")), align=s.get("align"), max_width=float(s.get("width", self.tl.w * 0.86)) * k,
                              line_height=float(s.get("line_height", 1.2)), spacing=float(s.get("spacing", 0)) * k, stroke=stroke,
                              stroke_width=float(s.get("stroke_width", size / k * 0.07 if stroke else 0)) * k, shadow=shadow, box=box_spec)
            elif o.kind in ("image", "picture"):
                img = open_image(o.path)  # type: ignore[arg-type]
                w, h = s.get("width"), s.get("height")
                if w and h:
                    img = gfx.fit(img, (max(1, int(float(w) * k)), max(1, int(float(h) * k))), "contain")
                else:
                    fct = (float(w) / img.width) if w else (float(h) / img.height) if h else 1.0
                    img = img.resize((max(1, int(img.width * fct * k)), max(1, int(img.height * fct * k))), Image.LANCZOS)
                if s.get("rotate"):
                    img = img.rotate(-float(s["rotate"]), resample=Image.BICUBIC, expand=True)
                at = s.get("at", [self.tl.w / 2, self.tl.h / 2])
                ax, ay = self.tl.position(s.get("anchor", "center"), f"{o.where}.anchor")
                layer.paste(img, (int(float(at[0]) * k - img.width * ax), int(float(at[1]) * k - img.height * ay)))
            else:
                x, y, w, h = [float(v) * k for v in s["rect"]]
                ImageDraw.Draw(layer).rounded_rectangle([x, y, x + w, y + h], radius=float(s.get("radius", 0)) * k, fill=gfx.color(s.get("color", "#000000aa")))
        except (MediaError, gfx.GfxError, VideoError) as ex:
            raise RenderError(f"{o.where}: {ex}") from None
        op = float(s.get("opacity", 1.0))
        if op < 0.999:
            layer.putalpha(layer.getchannel("A").point(lambda v: int(v * max(0.0, op))))
        bbox = layer.getchannel("A").getbbox()
        if bbox is None:
            self.tl.warnings.append(f"{o.where}: draws nothing — it is empty or outside the picture")
            sp = (Image.new("RGBA", (1, 1), (0, 0, 0, 0)), 0, 0)
        else:
            sp = (layer.crop(bbox), bbox[0], bbox[1])
        self.sprites[idx] = sp
        return sp

    def _overlays(self, img: Image.Image, t: float) -> Image.Image:
        out = None
        for idx, o in enumerate(self.overlays):
            if not (o.t0 <= t < o.t1):
                continue
            sprite, x, y = self._sprite(idx, o)
            a, dy = 1.0, 0.0
            if o.fade_in > 0 and t - o.t0 < o.fade_in:
                a = (t - o.t0) / o.fade_in
                if o.spec.get("in") == "rise":
                    dy = (1 - a) ** 2 * self.H * 0.04
            if o.fade_out > 0 and o.t1 - t < o.fade_out:
                a = min(a, (o.t1 - t) / o.fade_out)
            if a <= 0.004:
                continue
            if a < 0.996:
                q = int(a * 24)
                key = (idx, q)
                sp = self._faded.get(key)
                if sp is None:
                    sp = sprite.copy()
                    sp.putalpha(sprite.getchannel("A").point(lambda v, f=q / 24: int(v * f)))
                    if len(self._faded) > 240:
                        self._faded.clear()
                    self._faded[key] = sp
                sprite = sp
            if out is None:
                out = img.copy()
            out.paste(sprite, (x, int(y + dy)), sprite)
        return out if out is not None else img

    # -- one frame ---------------------------------------------------------------------------
    def frame(self, t: float) -> Image.Image:
        tl = self.tl
        t = min(max(0.0, t), max(0.0, tl.duration - 0.5 / self.fps))
        i = max(0, bisect.bisect_right(self.starts, t) - 1)
        c = tl.clips[i]
        img = self._clip_frame(i, t - c.start)
        if i > 0 and c.trans_dur > 0 and t - c.start < c.trans_dur:
            prev = tl.clips[i - 1]
            a = self._clip_frame(i - 1, t - prev.start)
            e = registry.TRANSITIONS[c.trans]
            try:
                img = e.fn(a, img, (t - c.start) / c.trans_dur, c.trans_params)
            except Exception as ex:  # noqa: BLE001
                raise RenderError(f'{c.where}: transition "{c.trans}" failed: {type(ex).__name__}: {ex}') from None
            if not isinstance(img, Image.Image) or img.size != self.size:
                raise RenderError(f'{c.where}: transition "{c.trans}" must return a picture of the frame size')
            img = img.convert("RGB")
        # clips that are over do not need their decoder any more
        for j in [j for j in self.sources if j < i - 1]:
            self.sources.pop(j).close()
        return self._overlays(img, t)

    def close(self) -> None:
        for s in self.sources.values():
            s.close()
        self.sources.clear()


class _Fixed(Source):
    def __init__(self, img: Image.Image):
        self.img = img

    def frame(self, t: float) -> Image.Image:
        return self.img


# ---------------------------------------------------------------------------
# Sound
# ---------------------------------------------------------------------------
def _fade(x: np.ndarray, fade_in: float, fade_out: float) -> np.ndarray:
    n = len(x)
    if n == 0:
        return x
    a = min(n, int(fade_in * SR))
    b = min(n, int(fade_out * SR))
    if a > 1:
        x[:a] *= np.linspace(0, 1, a, dtype=np.float32)[:, None]
    if b > 1:
        x[-b:] *= np.linspace(1, 0, b, dtype=np.float32)[:, None]
    return x


def _place(buf: np.ndarray, x: np.ndarray, t: float) -> None:
    i = int(round(t * SR))
    if i < 0:
        x, i = x[-i:], 0
    n = min(len(x), len(buf) - i)
    if n > 0:
        buf[i : i + n] += x[:n]


def build_audio(tl: Timeline, t0: float, t1: float) -> tuple[np.ndarray | None, dict]:
    """The mixed sound between t0 and t1 (None when there is nothing to hear)."""
    info: dict = {"clips": 0, "sounds": 0, "peak_db": None}
    n = int((t1 - t0) * SR) + 1
    clip_bus = np.zeros((n, 2), dtype=np.float32)
    other = np.zeros((n, 2), dtype=np.float32)
    ducked = np.zeros((n, 2), dtype=np.float32)
    duck_db = 0.0
    for i, c in enumerate(tl.clips):
        if not c.has_audio or c.volume <= 0 or c.path is None or c.end <= t0 or c.start >= t1:
            continue
        x = decode_audio(c.path, c.src_from, c.dur, c.speed)
        if not len(x):
            continue
        x = x[: int(c.dur * SR) + 1] * np.float32(c.volume)
        nxt = tl.clips[i + 1].trans_dur if i + 1 < len(tl.clips) else 0.0
        x = _fade(x, max(c.trans_dur, c.fade_in, 0.01), max(nxt, c.fade_out, 0.01))
        _place(clip_bus, x, c.start - t0)
        info["clips"] += 1
    for s in tl.sounds:
        if s.path is None or s.t >= t1:
            continue
        x = decode_audio(s.path, s.src_from, s.dur)
        if not len(x):
            continue
        if s.loop:
            need = int(max(0.0, tl.duration - s.t) * SR) + 1
            x = np.tile(x, (need // len(x) + 1, 1))[:need]
        x = x[: max(0, int((tl.duration - s.t) * SR) + 1)].copy()
        x = _fade(x, s.fade_in, s.fade_out) * np.float32(10 ** (s.gain / 20))
        if s.duck > 0:
            duck_db = max(duck_db, s.duck)
            _place(ducked, x, s.t - t0)
        else:
            _place(other, x, s.t - t0)
        info["sounds"] += 1
    if duck_db > 0 and np.any(clip_bus):
        # music steps back while the clips have something to say
        env = np.max(np.abs(clip_bus), axis=1)
        win = int(0.25 * SR)
        loud = np.convolve((env > 0.02).astype(np.float32), np.ones(win, dtype=np.float32) / win, mode="same")
        loud = np.convolve(np.clip(loud * 3, 0, 1), np.ones(win, dtype=np.float32) / win, mode="same")
        ducked *= (10 ** (-duck_db * np.clip(loud, 0, 1) / 20))[:, None].astype(np.float32)
    mix = (clip_bus + other + ducked) * np.float32(10 ** (tl.volume / 20))
    if not info["clips"] and not info["sounds"]:
        return None, info
    peak = float(np.max(np.abs(mix))) if len(mix) else 0.0
    if peak > 0.98:
        mix = (np.tanh(mix / peak * 1.25) / math.tanh(1.25) * 0.97).astype(np.float32)   # gentle limiting instead of clipping
    info["peak_db"] = round(20 * math.log10(max(peak, 1e-9)), 1)
    return mix, info


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------
def frame_times(t0: float, t1: float, fps: float) -> list[float]:
    n = max(1, int(round((t1 - t0) * fps)))
    return [t0 + i / fps for i in range(n)]


def render_video(tl: Timeline, out_mp4: Path, t0: float, t1: float, fps: int, scale: float, audio_wav: Path | None, crf: int = 18, progress=None,
                 thumbs_at: list[float] | None = None) -> dict:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RenderError("ffmpeg is not installed")
    comp = Compositor(tl, scale, fps)
    times = frame_times(t0, t1, fps)
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{comp.W}x{comp.H}", "-r", str(fps), "-i", "-"]
    if audio_wav:
        cmd += ["-i", str(audio_wav)]
    cmd += ["-c:v", "libx264", "-preset", "medium" if crf <= 20 else "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if audio_wav:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += [str(out_mp4)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    want = sorted(set(int(round((t - t0) * fps)) for t in (thumbs_at or []) if t0 <= t < t1))
    thumbs: dict[int, Image.Image] = {}
    try:
        for i, t in enumerate(times):
            img = comp.frame(t)
            if i in want:
                thumbs[i] = img.copy()
            try:
                proc.stdin.write(img.tobytes())  # type: ignore[union-attr]
            except (BrokenPipeError, OSError):
                break
            if progress and (i % max(1, len(times) // 20) == 0):
                progress(i, len(times))
        proc.stdin.close()  # type: ignore[union-attr]
        err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        if proc.wait() != 0:
            raise RenderError(f"ffmpeg could not write the video: {err.strip()[-400:]}")
    except BaseException:
        proc.kill()
        raise
    finally:
        comp.close()
    return {"frames": len(times), "width": comp.W, "height": comp.H, "thumbs": [(t0 + i / fps, im) for i, im in sorted(thumbs.items())]}


def convert(mp4: Path, out: Path, kind: str, fps: int, width: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if kind == "gif":
        vf = f"fps={min(fps, 15)},scale={min(width, 640)}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer"
        cmd = [ffmpeg, "-y", "-v", "error", "-i", str(mp4), "-filter_complex", vf, "-loop", "0", str(out)]
    else:
        cmd = [ffmpeg, "-y", "-v", "error", "-i", str(mp4), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-c:a", "libopus", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RenderError(f"ffmpeg could not write the {kind}: {r.stderr.strip()[-300:]}")


def key_times(tl: Timeline, t0: float, t1: float, count: int) -> list[float]:
    """Moments worth looking at: the middle of every clip and of every transition, then filled up evenly."""
    pts: list[float] = []
    for c in tl.clips:
        if c.trans_dur > 0:
            pts.append(c.start + c.trans_dur / 2)
        pts.append(c.start + max(c.trans_dur, 0.0) + (c.dur - c.trans_dur) / 2)
    for o in tl.overlays:
        pts.append(o.t0 + min(0.6, (o.t1 - o.t0) / 2))
    pts = sorted(set(round(p, 3) for p in pts if t0 <= p < t1))
    if len(pts) > count:
        step = len(pts) / count
        pts = [pts[int(i * step)] for i in range(count)]
    while len(pts) < min(count, 6):
        gaps = sorted(zip([t0, *pts], [*pts, t1]), key=lambda g: g[0] - g[1])
        a, b = gaps[0]
        if b - a < 0.2:
            break
        pts = sorted([*pts, round((a + b) / 2, 3)])
    return pts


def label_at(tl: Timeline, t: float) -> str:
    i = max(0, bisect.bisect_right([c.start for c in tl.clips], t) - 1)
    c = tl.clips[i]
    extra = f" ⇄ {c.trans}" if c.trans_dur > 0 and t - c.start < c.trans_dur else ""
    return f"{fmt_time(t)}  {c.name}{extra}"


def contact_sheet(tl: Timeline, frames: list[tuple[float, Image.Image]], path: Path, cols: int = 4) -> None:
    cells = [(label_at(tl, t), im) for t, im in frames]
    gfx.contact_sheet(cells, path, f"{tl.title} — {fmt_time(tl.duration)}, {tl.fps} fps, {tl.w}×{tl.h}", cols=cols, cell_w=420 if tl.w >= tl.h else 260)


def stills(tl: Timeline, times: list[float], scale: float = 1.0) -> list[tuple[float, Image.Image]]:
    comp = Compositor(tl, scale)
    try:
        return [(t, comp.frame(t).copy()) for t in sorted(times)]
    finally:
        comp.close()
