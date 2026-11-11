"""Rendering: scene + time -> picture; pictures -> video (ffmpeg), contact sheet, sprite sheet."""
from __future__ import annotations

import json
import math
import multiprocessing as mp
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw

from . import registry
from .draw import Canvas, draw_figure, rgba, speech_bubble
from .scene import Scene
from .skeleton import color, hash01, luminance


class RenderError(Exception):
    pass


class Renderer:
    def __init__(self, scene: Scene, ss: int = 2, scale: float = 1.0):
        self.sc = scene
        self.ss = max(1, int(ss))
        self.scale = scale
        self.W = max(2, int(round(scene.w * scale / 2)) * 2)
        self.H = max(2, int(round(scene.h * scale / 2)) * 2)
        self.k = self.ss * self.W / scene.w            # work pixels per world unit at zoom 1
        self.size = (self.W * self.ss, self.H * self.ss)
        self._expand_events()
        max_zoom = max([k.zoom for k in scene.camera] + [1.0]) * (1 + max([z for _, z in self.zooms] + [0.0]))
        self.bgk = self.k * min(2.0, max(1.0, max_zoom))
        self.bg = Image.new("RGB", (max(1, int(scene.world_w * self.bgk)), max(1, int(scene.world_h * self.bgk))), (0, 0, 0))
        name, params = scene.background
        try:
            registry.BACKDROPS[name].fn(Canvas(self.bg, (self.bgk, 0, 0, self.bgk, 0, 0)), scene.world_w, scene.world_h, scene.floor, params)
        except Exception as e:  # noqa: BLE001
            raise RenderError(f'backdrop "{name}" failed: {type(e).__name__}: {e}') from None
        # figures without a color of their own: dark on light scenery, light on dark scenery
        for f in scene.figures.values():
            if getattr(f, "auto_color", False):
                x = min(max(f.keys[0].x, 0), scene.world_w - 1) * self.bgk
                y0 = max(0.0, scene.floor - 200 * f.scale) * self.bgk
                y1 = max(y0 + 2, (scene.floor - 20) * self.bgk)
                box = (int(max(0, x - 40 * self.bgk)), int(y0), int(min(self.bg.width, x + 40 * self.bgk)), int(min(self.bg.height, y1)))
                if box[2] > box[0] and box[3] > box[1]:
                    px = self.bg.crop(box).resize((1, 1), Image.BOX).getpixel((0, 0))
                    f.color = (236, 236, 240) if luminance(px) < 95 else (24, 24, 28)
        self.vignette = self._vignette(float(scene.style.get("vignette") or 0))
        self.grain = float(scene.style.get("grain") or 0)
        self.held: dict[str, list] = {}
        for p in scene.props:
            if p.held_by:
                self.held.setdefault(p.held_by, []).append(p)

    # -- preparation --------------------------------------------------------------
    def _expand_events(self) -> None:
        sc = self.sc
        self.texts, self.shakes, self.flashes, self.bursts, self.zooms = [], [], [], [], []
        self.says, self.captions, self.titles, self.fades = [], [], [], []
        for i, ev in enumerate(sc.events):
            k, t = ev["kind"], ev["t"]
            if k == "text":
                self.texts.append({**ev, "text": str(ev["value"]), "seed": i})
            elif k == "say":
                dur = ev["dur"] if ev.get("dur") else 0.9 + 0.055 * len(str(ev["value"]))
                self.says.append({**ev, "dur": dur})
            elif k == "caption":
                dur = ev["dur"] if ev.get("dur") else 1.0 + 0.06 * len(str(ev["value"]))
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
                    self.bursts.append(self._burst({"t": t, "value": "spark", "x": x, "y": y, "n": 9, "speed": 420, "dir": [0, 0], "spread": 2.0, "life": 0.2,
                                                    "gravity": 0, "color": None, "size": None}, i + 7000))

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

    # -- one frame ------------------------------------------------------------------
    def view(self, t: float) -> tuple:
        """World -> work-pixel matrix of the camera at time t (with shake and zoom punches)."""
        sc = self.sc
        cx, cy, z = sc.cam_at(t)
        for t0, amt in self.zooms:
            if t0 <= t < t0 + 0.22:
                z *= 1 + amt * (1 - (t - t0) / 0.22) ** 2
        # keep the picture inside the scenery when it fits
        vw, vh = sc.w / z, sc.h / z
        if vw <= sc.world_w:
            cx = min(max(cx, vw / 2), sc.world_w - vw / 2)
        if vh <= sc.world_h:
            cy = min(max(cy, vh / 2), sc.world_h - vh / 2)
        ox = oy = 0.0
        fr = round(t * sc.fps)
        for t0, amp, dur in self.shakes:
            if t0 <= t < t0 + dur:
                a = amp * (1 - (t - t0) / dur)
                ox += (hash01(fr, t0, 1) - 0.5) * 2 * a
                oy += (hash01(fr, t0, 2) - 0.5) * 2 * a
        kk = self.k * z
        return (kk, 0.0, 0.0, kk, self.k * sc.w / 2 - cx * kk + ox * self.k, self.k * sc.h / 2 - cy * kk + oy * self.k)

    def frame(self, t: float) -> Image.Image:
        sc = self.sc
        m = self.view(t)
        kk = m[0]
        a = self.bgk / kk
        cx0, cy0 = -m[4] / kk * self.bgk, -m[5] / kk * self.bgk
        if abs(a - 1) < 1e-9 and abs(cx0) < 1e-6 and abs(cy0) < 1e-6 and self.bg.size == self.size:
            img = self.bg.copy()
        else:
            img = self.bg.transform(self.size, Image.AFFINE, (a, 0, cx0, 0, a, cy0), resample=Image.BILINEAR)
        c = Canvas(img, m)

        self._props(c, t, "back")
        figs = sorted(sc.figures.values(), key=lambda f: f.z)
        states = {}
        for f in figs:
            st, P = f.joints(t)
            st["_t"] = t
            states[f.name] = (st, P)
            if not st["visible"]:
                continue
            held = {"R": [], "L": []}
            for p in self.held.get(f.name, []):
                if p.t_from <= t < p.t_to:
                    held[p.hand].append(self._held_fn(p, P, t))
            try:
                draw_figure(c, f, st, P, sc.style, sc.floor, held)
            except Exception as e:  # noqa: BLE001
                raise RenderError(f'drawing figure "{f.name}" at {t:.2f}s failed: {type(e).__name__}: {e}') from None
        self._props(c, t, "front")
        self._particles(c, t)
        for tx in self.texts:
            if not tx.get("ui"):
                self._text(c, tx, t, sc.w / 2, sc.floor - 260)
        for s in self.says:
            if s["t"] <= t < s["t"] + s["dur"]:
                self._say(c, s, t, states)
        for t0, col, dur, alpha in self.flashes:
            if t0 <= t < t0 + dur:
                ImageDraw.Draw(img, "RGBA").rectangle([0, 0, *img.size], fill=col + (int(255 * alpha * (1 - (t - t0) / dur)),))

        if self.ss > 1:
            img = img.reduce(self.ss)
        if self.vignette is not None:
            img = ImageChops.multiply(img, self.vignette)
        if self.grain > 0:
            rng = np.random.default_rng(int(t * 1000) + sc.seed)
            noise = rng.normal(0, 255 * self.grain, (self.H, self.W, 1))
            img = Image.fromarray(np.clip(np.asarray(img, dtype=np.float32) + noise, 0, 255).astype(np.uint8), "RGB")
        self._overlay(img, t)
        return img

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

    def _text(self, c: Canvas, tx: dict, t: float, dx: float, dy: float) -> None:
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
        outline = "#101014" if tx.get("outline", True) else None
        c.text(tx["text"], x, y, size, tx["color"], tx.get("anchor", "mm"), tx.get("font", "bold"), rot=float(tx.get("rot") or 0), stroke=outline,
               stroke_width=max(2.0, size * 0.09) if outline else 0, alpha=alpha)

    def _say(self, c: Canvas, s: dict, t: float, states: dict) -> None:
        sc = self.sc
        age = t - s["t"]
        alpha = min(1.0, age / 0.1, (s["dur"] - age) / 0.15)
        who = s.get("who")
        if who and who in states:
            st, P = states[who]
            x, y = P["head"][0], P["head"][1] - P["_head_r"] - 8
            side = 1 if x < sc.world_w * 0.6 else -1
        else:
            x, y, side = sc.w / 2, sc.floor - 280, 1
        speech_bubble(c, str(s["value"]), x, y, float(s["size"]), s["color"], s["bubble"], max_w=320, alpha=max(0.0, alpha), side=side)

    def _overlay(self, img: Image.Image, t: float) -> None:
        """Everything in screen space: UI texts, captions, titles, fades."""
        sc = self.sc
        k = self.W / sc.w
        c = Canvas(img, (k, 0, 0, k, 0, 0))
        for tx in self.texts:
            if tx.get("ui"):
                self._text(c, {**tx, "anchor": tx.get("anchor", "lt") if tx.get("x") is not None else "mm"}, t, sc.w / 2, sc.h / 2)
        for cap in self.captions:
            age = t - cap["t"]
            if 0 <= age < cap["dur"]:
                alpha = min(1.0, age / 0.12, (cap["dur"] - age) / 0.2)
                size = float(cap["size"])
                tw, th = c.text_size(str(cap["value"]), size)
                c.rect(sc.w / 2 - tw / 2 - 18, sc.h - 70 - th / 2 - 10, tw + 36, th + 22, fill=(0, 0, 0, int(150 * alpha)), radius=8)
                c.text(str(cap["value"]), sc.w / 2, sc.h - 70, size, cap["color"], "mm", "bold", alpha=alpha)
        for ti in self.titles:
            age = t - ti["t"]
            dur = float(ti["dur"])
            if 0 <= age < dur:
                alpha = max(0.0, min(1.0, age / 0.35, (dur - age) / 0.45))
                ImageDraw.Draw(img, "RGBA").rectangle([0, 0, *img.size], fill=(0, 0, 0, int(255 * float(ti["shade"]) * alpha)))
                size = float(ti["size"])
                c.text(str(ti["value"]), sc.w / 2, sc.h / 2 - (size * 0.3 if ti.get("sub") else 0), size, ti["color"], "mm", "bold", stroke="#000000",
                       stroke_width=size * 0.05, alpha=alpha)
                if ti.get("sub"):
                    c.text(str(ti["sub"]), sc.w / 2, sc.h / 2 + size * 0.62, size * 0.36, ti["color"], "mm", "regular", alpha=alpha)
        for t0, kind, dur, col in self.fades:
            if t < t0:
                a = 1.0 if kind == "in" and t0 <= 0.001 else 0.0
            else:
                u = min(1.0, (t - t0) / max(dur, 1e-3))
                a = (1 - u) if kind == "in" else u
            if a > 0.003:
                ImageDraw.Draw(img, "RGBA").rectangle([0, 0, *img.size], fill=col + (int(255 * a),))


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------
_WORKER: Renderer | None = None


def _frame_bytes(t: float) -> bytes:
    return _WORKER.frame(t).tobytes()  # type: ignore[union-attr]


def frame_times(t0: float, t1: float, fps: int) -> list[float]:
    n = max(1, int(round((t1 - t0) * fps)))
    return [t0 + i / fps for i in range(n)]


def render_video(scene: Scene, out: Path, *, t0: float, t1: float, fps: int, scale: float, ss: int, jobs: int, audio_wav: Path | None,
                 crf: int = 18, progress=None) -> dict:
    global _WORKER
    if not shutil.which("ffmpeg"):
        raise RenderError("ffmpeg is not installed — cannot write video (use: studio-stickman still … for pictures)")
    r = Renderer(scene, ss=ss, scale=scale)
    times = frame_times(t0, t1, fps)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{r.W}x{r.H}", "-r", str(fps), "-i", "-"]
    if audio_wav:
        cmd += ["-i", str(audio_wav)]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if audio_wav:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += [str(out)]
    err = tempfile.TemporaryFile()
    pool = None
    proc = None
    try:
        _WORKER = r
        # the workers are forked BEFORE ffmpeg starts: otherwise they would inherit its input pipe
        # and ffmpeg would wait forever for the end of the video
        if jobs > 1 and len(times) > 8 and "fork" in mp.get_all_start_methods():
            pool = mp.get_context("fork").Pool(jobs)
            frames = pool.imap(_frame_bytes, times, chunksize=4)
        else:
            frames = (_frame_bytes(t) for t in times)
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=err)
        for i, data in enumerate(frames):
            try:
                proc.stdin.write(data)  # type: ignore[union-attr]
            except BrokenPipeError:
                break
            if progress and (i % max(1, len(times) // 20) == 0):
                progress(i, len(times))
        proc.stdin.close()  # type: ignore[union-attr]
        code = proc.wait()
    except BaseException:
        if proc:
            proc.kill()
        raise
    finally:
        if pool:
            pool.terminate()
            pool.join()
        _WORKER = None
    if code != 0:
        err.seek(0)
        raise RenderError(f"ffmpeg failed: {err.read().decode('utf-8', 'replace').strip()[-500:]}")
    return {"frames": len(times), "width": r.W, "height": r.H}


def convert(src: Path, dst: Path, kind: str, fps: int, width: int) -> None:
    if kind == "gif":
        vf = f"fps={min(fps, 15)},scale={min(width, 640)}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4"
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-filter_complex", vf, "-loop", "0", str(dst)]
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus", str(dst)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RenderError(f"ffmpeg ({kind}) failed: {r.stderr.decode('utf-8', 'replace').strip()[-400:]}")


# ---------------------------------------------------------------------------
# Pictures the AI looks at
# ---------------------------------------------------------------------------
def key_moments(scene: Scene, t0: float, t1: float, count: int) -> list[float]:
    """Times worth looking at: hits and poses reached, filled up with evenly spaced ones."""
    span = max(1e-6, t1 - t0)
    want: list[float] = []
    for ev in scene.events:
        if ev["kind"] == "hit" and t0 <= ev["t"] < t1:
            want.append(min(t1 - 1e-3, ev["t"] + 0.1))   # just after the impact (and its flash)
    even = [t0 + span * (i + 0.5) / count for i in range(count)]
    picked = sorted(set(round(t, 3) for t in want))[: max(0, count // 2)]
    for t in even:
        if len(picked) >= count:
            break
        if all(abs(t - p) > span / (count * 2.5) for p in picked):
            picked.append(round(t, 3))
    return sorted(picked)[:count]


def contact_sheet(scene: Scene, times: list[float], path: Path, cols: int = 4, thumb_w: int = 420, title: str | None = None) -> None:
    scale = thumb_w / scene.w
    r = Renderer(scene, ss=2, scale=scale)
    tw, th = r.W, r.H
    cols = max(1, min(cols, len(times)))
    rows = math.ceil(len(times) / cols)
    pad, label_h, head_h = 8, 26, 40
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, head_h + rows * (th + label_h + pad) + pad), (13, 16, 22))
    c = Canvas(sheet)
    c.text(title or f"{scene.title} — {scene.duration:g}s, {scene.fps} fps, {scene.w}×{scene.h}", pad + 2, head_h / 2, 17, "#e7e9ee", "lm", "bold")
    for i, t in enumerate(times):
        x = pad + (i % cols) * (tw + pad)
        y = head_h + (i // cols) * (th + label_h + pad)
        sheet.paste(r.frame(t), (x, y))
        words = []
        for ev in scene.events:
            if ev["kind"] in ("hit", "text", "say", "title") and -0.02 <= t - ev["t"] < 0.2:
                v = ev["value"]
                words.append(ev.get("word") or (f"hit {v.get('on')}" if isinstance(v, dict) else "hit" if isinstance(v, list) else str(v)))
        label = scene.clock.label(t) + (f"   {' · '.join(str(w) for w in words if isinstance(w, str))[:34]}" if words else "")
        c.text(label, x + 3, y + th + label_h / 2, 14, "#a2abbd", "lm", "mono")
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(path))


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
    # the box around the figure over the whole range, measured from its own position: the figure
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
    half = max(abs(min(xs)), abs(max(xs))) + margin          # symmetric: the figure's x is the cell centre
    y0, y1 = min(ys) - margin, max(max(ys) + margin, scene.floor + 2)
    ss = 2
    k = cell / max(2 * half, y1 - y0)
    held = [p for p in scene.props if p.held_by == figure]
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


def default_jobs() -> int:
    try:
        n = len(os.sched_getaffinity(0))
    except AttributeError:
        n = os.cpu_count() or 2
    return max(1, min(8, n))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
