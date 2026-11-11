"""Video files (*.video.yaml): load, validate, work out the timeline.

    clips      the main track: one after another, joined by transitions
    overlays   text, pictures and boxes on top (absolute times, or relative to a clip)
    subtitles  lines at the bottom (+ an .srt file next to the video)
    audio      music and sounds under / over the clips' own sound

Clips can be made by the other Studio tools: a stick scene (studio-stickman), a picture
(studio-image), a song (studio-daw) — they are rendered when needed and cached.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import registry
from .media import MediaError, probe
from .registry import suggest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
import studio_gfx as gfx  # noqa: E402
from studio_gfx import GfxError  # noqa: E402


class VideoError(Exception):
    pass


CLIP_KINDS = ["file", "image", "title", "color", "scene", "picture", "generator"]
CLIP_COMMON = {"name", "dur", "transition", "fade_in", "fade_out", "volume", "mute", "look", "caption", "fit"}
CLIP_OPTIONS = {
    "file": {"from", "to", "speed"},
    "image": {"zoom", "pan", "background"},
    "title": {"sub", "background", "color", "size", "font", "align", "animate", "dim"},
    "color": set(),
    "scene": {"from", "to", "speed"},
    "picture": {"zoom", "pan", "background"},
    "generator": set(),
}
OVERLAY_KINDS = ["text", "image", "picture", "rect"]
OVERLAY_COMMON = {"t", "dur", "clip", "at", "anchor", "opacity", "in", "out", "fade", "name"}
OVERLAY_OPTIONS = {
    "text": {"size", "font", "color", "valign", "width", "align", "stroke", "stroke_width", "shadow", "box", "line_height", "spacing", "upper"},
    "image": {"width", "height", "rotate"},
    "picture": {"width", "height", "rotate"},
    "rect": {"color", "radius"},
}
AUDIO_KINDS = ["file", "song", "sfx"]
AUDIO_OPTIONS = {"t", "gain", "fade_in", "fade_out", "from", "dur", "loop", "duck", "clip", "name", "pitch", "seed"}
LOOK = {"brightness", "contrast", "saturation", "grayscale", "blur"}
POSITIONS = {"center": (0.5, 0.5), "left": (0.0, 0.5), "right": (1.0, 0.5), "top": (0.5, 0.0), "bottom": (0.5, 1.0),
             "top-left": (0.0, 0.0), "top-right": (1.0, 0.0), "bottom-left": (0.0, 1.0), "bottom-right": (1.0, 1.0)}


def parse_time(v, where: str) -> float:
    """Seconds: 12, 1.5, "1.5s", "1:23", "1:23.5", "0:01:05"."""
    if isinstance(v, bool) or v is None:
        raise VideoError(f"{where}: expected a time, got {v}")
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lower().rstrip("s")
    try:
        if ":" in s:
            parts = [float(p) for p in s.split(":")]
            if len(parts) > 3:
                raise ValueError
            t = 0.0
            for p in parts:
                t = t * 60 + p
            return t
        return float(s)
    except ValueError:
        raise VideoError(f'{where}: "{v}" is not a time (seconds like 12.5, or minutes:seconds like 1:23)') from None


def fmt_time(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m)}:{s:05.2f}"


@dataclass
class Clip:
    index: int
    kind: str
    name: str
    spec: dict
    dur: float = 0.0
    start: float = 0.0
    trans: str = "cut"
    trans_params: dict = field(default_factory=dict)
    trans_dur: float = 0.0
    path: Path | None = None           # source file (video, picture), once known
    src_from: float = 0.0
    speed: float = 1.0
    fit: str = "cover"
    volume: float = 1.0
    has_audio: bool = False
    fade_in: float = 0.0
    fade_out: float = 0.0
    look: dict = field(default_factory=dict)
    where: str = ""

    @property
    def end(self) -> float:
        return self.start + self.dur


@dataclass
class Overlay:
    kind: str
    spec: dict
    t0: float
    t1: float
    fade_in: float
    fade_out: float
    where: str
    path: Path | None = None


@dataclass
class Sound:
    kind: str
    spec: dict
    t: float
    gain: float
    where: str
    path: Path | None = None
    src_from: float = 0.0
    dur: float | None = None
    loop: bool = False
    fade_in: float = 0.0
    fade_out: float = 0.0
    duck: float = 0.0


class Timeline:
    def __init__(self, data: dict, path: Path):
        self.path = Path(path)
        self.base = registry.project_dir()
        self.warnings: list[str] = []
        unknown = set(data) - {"video", "clips", "overlays", "subtitles", "audio", "use"}
        if unknown:
            self.warnings.append(f"ignored top-level keys: {', '.join(sorted(map(str, unknown)))} (known: video clips overlays subtitles audio use)")
        registry.load_builtins()
        for pack_id in data.get("use") or []:
            try:
                registry.load_pack(str(pack_id))
            except ImportError as e:
                raise VideoError(f"use: {e}") from None
        registry.load_project_plugins()
        for err in registry.PLUGIN_ERRORS:
            self.warnings.append(f'plugin {err["file"]} failed to load: {err["error"]}')

        v = data.get("video") or {}
        if not isinstance(v, dict):
            raise VideoError("video: must be a mapping (title, size, fps …)")
        bad = set(v) - {"title", "size", "fps", "background", "volume", "subtitle_size", "subtitle_color", "subtitle_box"}
        if bad:
            raise VideoError(f'video: unknown option "{sorted(bad)[0]}"{suggest(sorted(bad)[0], ["title", "size", "fps", "background", "volume"])}')
        self.title = str(v.get("title") or self.path.name.split(".")[0])
        size = v.get("size", [1280, 720])
        if not (isinstance(size, list) and len(size) == 2):
            raise VideoError("video.size must be [width, height], e.g. [1280, 720] (or [1080, 1920] for a vertical video)")
        self.w, self.h = int(size[0]), int(size[1])
        if not (64 <= self.w <= 3840 and 64 <= self.h <= 3840) or self.w % 2 or self.h % 2:
            raise VideoError("video.size: width and height must be even numbers between 64 and 3840")
        self.fps = int(v.get("fps", 30))
        if not 5 <= self.fps <= 60:
            raise VideoError("video.fps must be between 5 and 60")
        self.background = self._color(v.get("background", "#000000"), "video.background")
        self.volume = float(v.get("volume", 0.0))            # dB on the final mix
        self.sub_style = {"size": float(v.get("subtitle_size", self.h / 22)), "color": v.get("subtitle_color", "#ffffff"), "box": v.get("subtitle_box", "#000000b0")}
        self._color(self.sub_style["color"], "video.subtitle_color")

        clips = data.get("clips") or []
        if not isinstance(clips, list) or not clips:
            raise VideoError("clips: list at least one, e.g.  clips: [ { title: \"Hello\", dur: 3 } ]")
        self.clips = [self._clip(c, i) for i, c in enumerate(clips)]
        self._layout()
        self.duration = round(self.clips[-1].end, 4)
        if self.duration > 3600:
            raise VideoError("the video would be longer than one hour")
        self.overlays = [self._overlay(o, f"overlays[{i}]") for i, o in enumerate(data.get("overlays") or [])]
        for c in self.clips:                                 # caption: a line of text during the clip
            if c.spec.get("caption"):
                self.overlays.append(self._overlay({"text": str(c.spec["caption"]), "clip": c.index + 1, "t": 0, "dur": c.dur, "at": [self.w / 2, self.h * 0.9],
                                                    "valign": "bottom", "size": self.h / 20, "box": True}, f"{c.where}.caption"))
        self.subtitles = self._subtitles(data.get("subtitles"))
        self.sounds = [self._sound(s, f"audio[{i}]") for i, s in enumerate(data.get("audio") or [])]

    # -- helpers --------------------------------------------------------------------
    def _color(self, c, where: str):
        try:
            return gfx.color(c)
        except GfxError as e:
            raise VideoError(f"{where}: {e}") from None

    def file(self, ref, where: str) -> Path:
        s = str(ref)
        p = (self.base / s) if not Path(s).is_absolute() else Path(s)
        if p.is_file():
            return p
        rel = self.path.parent / s
        if rel.is_file():
            return rel
        if "/" in s and not s.startswith((".", "/")):
            packed = registry.pack_file(s)
            if packed and Path(packed).is_file():
                return Path(packed)
        raise VideoError(f"{where}: file not found: {s} (paths are relative to the project folder; pack items as pack-id/item-id)")

    def _background(self, spec, where: str):
        """color | { gradient: [...], angle } | { image: file } — validated, returned as it is."""
        if spec is None:
            return None
        if isinstance(spec, dict):
            if "gradient" in spec:
                cols = spec["gradient"]
                if not isinstance(cols, list) or len(cols) < 2:
                    raise VideoError(f"{where}.gradient: give at least two colors")
                for c in cols:
                    self._color(c, f"{where}.gradient")
            elif "image" in spec:
                self.file(spec["image"], f"{where}.image")
            else:
                raise VideoError(f"{where}: a color, {{ gradient: [colors], angle: 90 }} or {{ image: file }}")
        else:
            self._color(spec, where)
        return spec

    # -- clips ------------------------------------------------------------------------
    def _clip(self, spec, i: int) -> Clip:
        where = f"clips[{i}]"
        if not isinstance(spec, dict):
            raise VideoError(f"{where}: a clip must be a mapping like {{ file: assets/a.mp4, from: 2, to: 8 }}")
        kinds = [k for k in CLIP_KINDS if k in spec]
        if len(kinds) != 1:
            first = next((k for k in spec if k not in CLIP_COMMON), None)
            raise VideoError(f"{where}: " + (f"one clip, one kind — found {', '.join(kinds)}" if kinds else
                                              f'no clip kind{(" — unknown " + chr(34) + str(first) + chr(34) + suggest(first, CLIP_KINDS)) if first else ""}') +
                             f" (kinds: {', '.join(CLIP_KINDS)})")
        kind = kinds[0]
        where = f"{where} ({spec.get('name') or kind})"
        gen = None
        allowed = CLIP_COMMON | {kind} | CLIP_OPTIONS[kind]
        if kind == "generator":
            gen = registry.GENERATORS.get(str(spec["generator"]))
            if not gen:
                raise VideoError(f'{where}: unknown generator "{spec["generator"]}"{suggest(spec["generator"], registry.GENERATORS)} (studio-video list generators)')
            allowed |= set(gen.params)
        for k in spec:
            if k not in allowed:
                raise VideoError(f'{where}: unknown option "{k}"{suggest(k, allowed)}')
        c = Clip(i, kind, str(spec.get("name") or f"{kind}{i + 1}"), dict(spec), where=where)
        c.fit = str(spec.get("fit", "cover"))
        if c.fit not in ("cover", "contain", "stretch"):
            raise VideoError(f"{where}.fit: cover, contain or stretch")
        c.fade_in = max(0.0, parse_time(spec.get("fade_in", 0), f"{where}.fade_in"))
        c.fade_out = max(0.0, parse_time(spec.get("fade_out", 0), f"{where}.fade_out"))
        c.volume = 0.0 if spec.get("mute") else float(spec.get("volume", 1.0))
        look = spec.get("look") or {}
        if not isinstance(look, dict) or set(look) - LOOK:
            raise VideoError(f"{where}.look: a mapping with {', '.join(sorted(LOOK))}")
        c.look = {k: float(v) for k, v in look.items()}

        if kind in ("file", "scene"):
            c.path = self.file(spec[kind], f"{where}.{kind}")
            c.speed = float(spec.get("speed", 1.0))
            if not 0.1 <= c.speed <= 10:
                raise VideoError(f"{where}.speed: between 0.1 and 10")
            if kind == "file":
                try:
                    info = probe(c.path)
                except MediaError as e:
                    raise VideoError(f"{where}: {e}") from None
                if not info["video"]:
                    raise VideoError(f"{where}: {c.path.name} has no picture — put sound files under audio:")
                if info["duration"] <= 0.05:
                    raise VideoError(f"{where}: {c.path.name} is a still picture — write it as  image: {spec[kind]}  (with dur:)")
                src_dur = info["duration"]
                c.has_audio = bool(info["audio"])
            else:
                if not c.path.name.endswith((".stick.yaml", ".stick.yml")):
                    raise VideoError(f"{where}.scene: expects a studio-stickman scene (*.stick.yaml)")
                src_dur = self._scene_seconds(c.path, where)
                c.has_audio = True
            c.src_from = max(0.0, parse_time(spec.get("from", 0), f"{where}.from"))
            if c.src_from >= src_dur - 0.01 and src_dur > 0:
                raise VideoError(f"{where}.from: {c.src_from:g}s is after the end of {c.path.name} ({src_dur:g}s)")
            if "to" in spec and "dur" in spec:
                raise VideoError(f"{where}: give to: or dur:, not both")
            to = parse_time(spec["to"], f"{where}.to") if "to" in spec else (c.src_from + parse_time(spec["dur"], f"{where}.dur") * c.speed if "dur" in spec else src_dur)
            if to > src_dur + 0.05 and src_dur > 0:
                self.warnings.append(f"{where}: to {to:g}s is past the end of {c.path.name} ({src_dur:g}s) — the clip ends there")
                to = src_dur
            if to <= c.src_from:
                raise VideoError(f"{where}: to ({to:g}s) must be after from ({c.src_from:g}s)")
            c.dur = (to - c.src_from) / c.speed
        else:
            c.dur = parse_time(spec.get("dur", 2.5 if kind == "title" else 3.0), f"{where}.dur")
            if c.dur <= 0:
                raise VideoError(f"{where}.dur: must be longer than 0")
            if kind == "image":
                c.path = self.file(spec["image"], f"{where}.image")
            elif kind == "picture":
                c.path = self.file(spec["picture"], f"{where}.picture")
                if not c.path.name.endswith((".image.yaml", ".image.yml")):
                    raise VideoError(f"{where}.picture: expects a studio-image picture (*.image.yaml) — plain pictures go under image:")
            elif kind == "color":
                self._color(spec["color"], f"{where}.color")
            elif kind == "title":
                self._background(spec.get("background"), f"{where}.background")
                self._color(spec.get("color", "#ffffff"), f"{where}.color")
                try:
                    gfx.font(spec.get("font", "bold"), 20, self.base, registry.pack_file)
                except GfxError as e:
                    raise VideoError(f"{where}.font: {e}") from None
                if str(spec.get("animate", "rise")) not in ("rise", "fade", "zoom", "none"):
                    raise VideoError(f"{where}.animate: rise, fade, zoom or none")
            if kind in ("image", "picture"):
                self._background(spec.get("background"), f"{where}.background")
                z = spec.get("zoom")
                if z is not None and not (isinstance(z, (int, float)) or (isinstance(z, list) and len(z) == 2)):
                    raise VideoError(f"{where}.zoom: a number or [start, end], e.g. [1.0, 1.15]")
                p = spec.get("pan")
                if p is not None:
                    pts = p if isinstance(p, list) and len(p) == 2 and not all(isinstance(x, (int, float)) for x in p) else [p, p]
                    for q in pts:
                        self.position(q, f"{where}.pan")
        if c.dur > 1800:
            raise VideoError(f"{where}: a clip of {c.dur:.0f}s is too long (30 minutes at most)")
        # the transition INTO this clip
        t = spec.get("transition")
        if t is not None and i == 0:
            self.warnings.append(f"{where}: the first clip has nothing to transition from — use fade_in: 0.5")
        elif t is not None:
            tspec = t if isinstance(t, dict) else {"type": t}
            name = str(tspec.get("type", "crossfade"))
            e = registry.TRANSITIONS.get(name)
            if not e:
                raise VideoError(f'{where}.transition: unknown transition "{name}"{suggest(name, registry.TRANSITIONS)} (studio-video list transitions)')
            params = dict(e.params)
            for k, val in tspec.items():
                if k in ("type", "dur"):
                    continue
                if k not in e.params:
                    raise VideoError(f'{where}.transition: "{name}" has no parameter "{k}" (has: {", ".join(e.params) or "none"})')
                params[k] = val
            c.trans, c.trans_params = name, params
            c.trans_dur = 0.0 if name == "cut" else max(0.0, parse_time(tspec.get("dur", 0.5), f"{where}.transition.dur"))
        return c

    def _scene_seconds(self, path: Path, where: str) -> float:
        r = run_tool("studio-stickman", ["check", str(path), "--json"], self.base)
        try:
            data = json.loads((r.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise VideoError(f"{where}: studio-stickman could not read {path.name}: {(r.stderr or r.stdout).strip()[-300:]}") from None
        if not data.get("ok"):
            raise VideoError(f"{where}: {path.name}: {data.get('error')}")
        return float(data["seconds"])

    def _layout(self) -> None:
        t = 0.0
        for i, c in enumerate(self.clips):
            if i > 0 and c.trans_dur > 0:
                most = min(self.clips[i - 1].dur, c.dur) * 0.5
                if c.trans_dur > most:
                    self.warnings.append(f"{c.where}: the transition ({c.trans_dur:g}s) is longer than half of the clips around it — shortened to {most:.2f}s")
                    c.trans_dur = most
                t -= c.trans_dur
            c.start = max(0.0, t)
            t = c.start + c.dur

    def position(self, v, where: str) -> tuple[float, float]:
        """A place in a picture as fractions: a name (left, top-right …) or [fx, fy]."""
        if isinstance(v, str):
            if v not in POSITIONS:
                raise VideoError(f'{where}: "{v}" — one of {", ".join(POSITIONS)} or [fx, fy] (0 … 1)')
            return POSITIONS[v]
        if isinstance(v, (list, tuple)) and len(v) == 2:
            return (float(v[0]), float(v[1]))
        raise VideoError(f"{where}: a position name or [fx, fy]")

    def clip_ref(self, ref, where: str) -> Clip:
        if isinstance(ref, int) or str(ref).isdigit():
            n = int(ref)
            if not 1 <= n <= len(self.clips):
                raise VideoError(f"{where}.clip: there are {len(self.clips)} clips (counted from 1)")
            return self.clips[n - 1]
        for c in self.clips:
            if c.name == str(ref):
                return c
        raise VideoError(f'{where}.clip: no clip named "{ref}"{suggest(ref, [c.name for c in self.clips])} (give clips a name:, or use their number)')

    # -- overlays ------------------------------------------------------------------------
    def _overlay(self, spec, where: str) -> Overlay:
        if not isinstance(spec, dict):
            raise VideoError(f"{where}: an overlay must be a mapping like {{ text: \"Hi\", t: 2, dur: 3 }}")
        kinds = [k for k in OVERLAY_KINDS if k in spec]
        if len(kinds) != 1:
            raise VideoError(f"{where}: needs exactly one of: {', '.join(OVERLAY_KINDS)}")
        kind = kinds[0]
        where = f"{where} ({spec.get('name') or kind})"
        allowed = OVERLAY_COMMON | {kind} | OVERLAY_OPTIONS[kind]
        for k in spec:
            if k not in allowed:
                raise VideoError(f'{where}: unknown option "{k}"{suggest(k, allowed)}')
        base, span = 0.0, self.duration
        if spec.get("clip") is not None:
            c = self.clip_ref(spec["clip"], where)
            base, span = c.start, c.dur
        t0 = base + parse_time(spec.get("t", 0), f"{where}.t")
        d = spec.get("dur")
        t1 = (base + span) if d in (None, "end", "all") else t0 + parse_time(d, f"{where}.dur")
        if t1 <= t0:
            raise VideoError(f"{where}: it would be shown for no time (t {t0:g}s, until {t1:g}s)")
        if t0 >= self.duration:
            self.warnings.append(f"{where}: starts at {t0:g}s, after the end of the video ({self.duration:g}s)")
        fade = max(0.0, float(spec.get("fade", 0.3)))
        mode_in, mode_out = str(spec.get("in", "fade")), str(spec.get("out", "fade"))
        for m, key in ((mode_in, "in"), (mode_out, "out")):
            if m not in ("fade", "none", "rise"):
                raise VideoError(f"{where}.{key}: fade, rise or none")
        o = Overlay(kind, dict(spec), t0, min(t1, max(self.duration, t0 + 0.01)), 0.0 if mode_in == "none" else fade, 0.0 if mode_out == "none" else fade, where)
        if kind == "text":
            try:
                gfx.font(spec.get("font", "bold"), 20, self.base, registry.pack_file)
            except GfxError as e:
                raise VideoError(f"{where}.font: {e}") from None
            self._color(spec.get("color", "#ffffff"), f"{where}.color")
            if spec.get("stroke") not in (None, False):
                self._color(spec["stroke"], f"{where}.stroke")
            if spec.get("box") not in (None, False, True) and not isinstance(spec["box"], dict):
                self._color(spec["box"], f"{where}.box")
        elif kind == "image":
            o.path = self.file(spec["image"], f"{where}.image")
        elif kind == "picture":
            o.path = self.file(spec["picture"], f"{where}.picture")
        else:
            r = spec["rect"]
            if not (isinstance(r, list) and len(r) == 4):
                raise VideoError(f"{where}.rect: [x, y, width, height]")
            self._color(spec.get("color", "#000000aa"), f"{where}.color")
        if "at" in spec and not (isinstance(spec["at"], list) and len(spec["at"]) == 2):
            raise VideoError(f"{where}.at: [x, y]")
        return o

    def _subtitles(self, spec) -> list[dict]:
        if not spec:
            return []
        if isinstance(spec, str):
            return self._srt(self.file(spec, "subtitles"))
        if not isinstance(spec, list):
            raise VideoError("subtitles: a list of { t, dur, text } or the path of an .srt file")
        out = []
        for i, s in enumerate(spec):
            if not isinstance(s, dict) or "text" not in s:
                raise VideoError(f"subtitles[{i}]: write a line as {{ t: 1.0, dur: 2.5, text: \"Hello\" }}")
            t = parse_time(s.get("t", out[-1]["t1"] if out else 0), f"subtitles[{i}].t")
            d = parse_time(s["dur"], f"subtitles[{i}].dur") if "dur" in s else max(1.2, 0.35 + 0.06 * len(str(s["text"])))
            out.append({"t0": t, "t1": t + d, "text": str(s["text"])})
        return out

    def _srt(self, path: Path) -> list[dict]:
        out = []
        blocks = re.split(r"\n\s*\n", path.read_text("utf-8", errors="replace").replace("\r", ""))
        for b in blocks:
            m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)\s*\n([\s\S]+)", b)
            if m:
                g = [int(x) for x in m.groups()[:8]]
                out.append({"t0": g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000, "t1": g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000, "text": re.sub(r"<[^>]+>", "", m.group(9)).strip()})
        if not out:
            raise VideoError(f"subtitles: no lines found in {path.name} (expected the .srt format)")
        return out

    # -- audio -----------------------------------------------------------------------------
    def _sound(self, spec, where: str) -> Sound:
        if not isinstance(spec, dict):
            raise VideoError(f"{where}: a sound must be a mapping like {{ file: exports/song.mp3, gain: -6 }}")
        kinds = [k for k in AUDIO_KINDS if k in spec]
        if len(kinds) != 1:
            raise VideoError(f"{where}: needs exactly one of: {', '.join(AUDIO_KINDS)}")
        kind = kinds[0]
        where = f"{where} ({spec.get('name') or kind})"
        for k in spec:
            if k not in AUDIO_OPTIONS and k != kind:
                raise VideoError(f'{where}: unknown option "{k}"{suggest(k, AUDIO_OPTIONS)}')
        base = self.clip_ref(spec["clip"], where).start if spec.get("clip") is not None else 0.0
        s = Sound(kind, dict(spec), base + parse_time(spec.get("t", 0), f"{where}.t"), float(spec.get("gain", 0.0)), where)
        s.src_from = max(0.0, parse_time(spec.get("from", 0), f"{where}.from"))
        s.dur = parse_time(spec["dur"], f"{where}.dur") if "dur" in spec else None
        s.loop = bool(spec.get("loop", False))
        s.fade_in = max(0.0, parse_time(spec.get("fade_in", 0), f"{where}.fade_in"))
        s.fade_out = max(0.0, parse_time(spec.get("fade_out", 0), f"{where}.fade_out"))
        s.duck = abs(float(spec.get("duck", 0.0)))
        if kind == "file":
            s.path = self.file(spec["file"], f"{where}.file")
            try:
                if not probe(s.path)["audio"]:
                    raise VideoError(f"{where}: {s.path.name} has no sound")
            except MediaError as e:
                raise VideoError(f"{where}: {e}") from None
        elif kind == "song":
            s.path = self.file(spec["song"], f"{where}.song")
            if not s.path.name.endswith((".song.yaml", ".song.yml")):
                raise VideoError(f"{where}.song: expects a studio-daw song (*.song.yaml) — finished audio goes under file:")
        else:
            names = sfx_names(self.base)
            if names and str(spec["sfx"]) not in names:
                raise VideoError(f'{where}: unknown sound effect "{spec["sfx"]}"{suggest(spec["sfx"], names)} (studio-daw sfx list)')
        if s.t >= self.duration:
            self.warnings.append(f"{where}: starts at {s.t:g}s, after the end of the video ({self.duration:g}s)")
        return s

    # -- things made by the other Studio tools ---------------------------------------------------
    def prepare(self, log=None) -> None:
        """Render stick scenes, pictures, songs and sound effects that the timeline uses (cached)."""
        cache = self.base / ".studio" / "cache" / "video"
        for c in self.clips:
            if c.kind == "scene":
                c.path = self._made("studio-stickman", c.path, cache, "mp4", ["render", "{src}", "--json", "--out", "{dir}", "--name", "{name}"], "mp4", c.where, log)
            elif c.kind == "picture":
                c.path = self._made("studio-image", c.path, cache, "png", ["render", "{src}", "--json", "--out", "{dir}", "--name", "{name}"], "image", c.where, log)
        for o in self.overlays:
            if o.kind == "picture" and o.path and o.path.name.endswith((".image.yaml", ".image.yml")):
                o.path = self._made("studio-image", o.path, cache, "png", ["render", "{src}", "--json", "--out", "{dir}", "--name", "{name}"], "image", o.where, log)
        for s in self.sounds:
            if s.kind == "song":
                s.path = self._made("studio-daw", s.path, cache, "wav", ["render", "{src}", "--json", "--out", "{dir}", "--name", "{name}", "--format", "wav"], "wav", s.where, log)
            elif s.kind == "sfx":
                name = str(s.spec["sfx"])
                pitch, seed = float(s.spec.get("pitch", 1.0)), int(s.spec.get("seed", 1))
                out = cache / f"sfx-{re.sub(r'[^a-z0-9]+', '-', name.lower())}-{pitch:g}-{seed}.wav"
                if not out.is_file():
                    cache.mkdir(parents=True, exist_ok=True)
                    r = run_tool("studio-daw", ["sfx", name, "--out", str(out), "--pitch", str(pitch), "--seed", str(seed), "--json"], self.base)
                    if r.returncode != 0 or not out.is_file():
                        raise VideoError(f"{s.where}: {_tool_error(r, 'studio-daw')}")
                s.path = out

    def _made(self, tool: str, src: Path, cache: Path, ext: str, args: list[str], key: str, where: str, log) -> Path:
        st = src.stat()
        h = hashlib.sha1(f"{src.resolve()}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()[:12]
        name = f"{src.name.split('.')[0]}-{h}"
        out = cache / f"{name}.{ext}"
        if out.is_file() and out.stat().st_size > 0:
            return out
        cache.mkdir(parents=True, exist_ok=True)
        if log:
            log(f"  rendering {src.name} with {tool} …")
        r = run_tool(tool, [a.replace("{src}", str(src)).replace("{dir}", str(cache)).replace("{name}", name) for a in args], self.base)
        try:
            data = json.loads((r.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            data = {}
        made = (data.get("files") or {}).get(key)
        if r.returncode != 0 or not data.get("ok") or not made or not Path(made).is_file():
            raise VideoError(f"{where}: {tool} could not render {src.name}: {data.get('error') or _tool_error(r, tool)}")
        if Path(made) != out:
            shutil.move(made, out)
        return out


def _tool_error(r, tool: str) -> str:
    text = (r.stderr or r.stdout or "").strip()
    try:
        return str(json.loads(text.splitlines()[-1]).get("error"))
    except (ValueError, IndexError, AttributeError):
        return text[-300:] or f"{tool} failed"


_sfx_names: list[str] | None = None


def sfx_names(cwd: Path) -> list[str]:
    """The one-shot sound effects studio-daw can make (empty when it cannot be asked)."""
    global _sfx_names
    if _sfx_names is None:
        try:
            r = run_tool("studio-daw", ["sfx", "list", "--json"], cwd)
            _sfx_names = [str(x["name"]) for x in json.loads((r.stdout or "").strip().splitlines()[-1]).get("sounds", [])]
        except (VideoError, ValueError, IndexError, KeyError):
            _sfx_names = []
    return _sfx_names


def run_tool(tool: str, args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """Runs a sibling Studio tool (studio-stickman, studio-image, studio-daw)."""
    exe = shutil.which(tool)
    cmd = [exe] if exe else [sys.executable, str(Path(__file__).resolve().parents[2] / tool / "bin" / tool)]
    try:
        return subprocess.run(cmd + args, cwd=str(cwd), capture_output=True, text=True, timeout=1800)
    except FileNotFoundError:
        raise VideoError(f"{tool} is not installed here") from None
    except subprocess.TimeoutExpired:
        raise VideoError(f"{tool} took longer than 30 minutes") from None


def load_timeline_text(text: str, path: str | Path = "video.video.yaml") -> Timeline:
    path = Path(path)
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise VideoError(f"{path.name}: YAML syntax error: {e}") from None
    if not isinstance(data, dict):
        raise VideoError("a video file must be a mapping with video / clips")
    return Timeline(data, path)


def load_timeline(path: str | Path) -> Timeline:
    path = Path(path)
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        raise VideoError(f"file not found: {path}") from None
    return load_timeline_text(text, path)
