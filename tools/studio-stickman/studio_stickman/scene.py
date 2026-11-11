"""Scene files (*.stick.yaml): load, validate, expand actions into keyframes.

The result is a Scene: figures with resolved keyframes (state at any time), props, camera keys
and a flat list of timed events (texts, hits, sounds, particles …) for the renderer.
"""
from __future__ import annotations

import bisect
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import registry
from .registry import suggest
from .skeleton import ANGLES, EASES, STAND, color, ease, fk, lerp


class SceneError(Exception):
    pass


# --- YAML: "5:1" must stay text (bar:beat), not become the base-60 number 301 ----------------
class _Loader(yaml.SafeLoader):
    pass


_Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag not in ("tag:yaml.org,2002:int", "tag:yaml.org,2002:float")]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_Loader.add_implicit_resolver("tag:yaml.org,2002:int", re.compile(r"^[-+]?(?:0|[1-9][0-9_]*)$"), list("-+0123456789"))
_Loader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(r"^[-+]?(?:[0-9][0-9_]*\.[0-9_]*(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[0-9][0-9_]*[eE][-+]?[0-9]+)$"),
    list("-+0123456789."),
)


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------
@dataclass
class Clock:
    bpm: float | None
    beats_per_bar: float

    @property
    def beat(self) -> float | None:
        return 60.0 / self.bpm if self.bpm else None

    def span(self, v, where: str) -> float:
        """A length of time: 1.5 (seconds), "1.5s", "2b" (beats), "1bar"."""
        if isinstance(v, bool):
            raise SceneError(f"{where}: expected a time, got {v}")
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip().lower()
        m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*(s|sec|b|beat|beats|bar|bars)?", s)
        if not m:
            raise SceneError(f'{where}: "{v}" is not a time (seconds like 1.5, beats like 2b, bars like 1bar)')
        n = float(m.group(1))
        unit = m.group(2) or "s"
        if unit in ("s", "sec"):
            return n
        if not self.bpm:
            raise SceneError(f'{where}: "{v}" needs scene.bpm (beats and bars are measured against the music)')
        return n * self.beat * (self.beats_per_bar if unit.startswith("bar") else 1)

    def at(self, v, prev_end: float, where: str) -> float:
        """A point in time: seconds, "bar:beat" (both from 1), or "+…" after the previous item ended."""
        if v is None:
            return prev_end
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
        s = str(v).strip()
        if s.startswith("+"):
            return prev_end + self.span(s[1:], where)
        m = re.fullmatch(r"([0-9]+):([0-9]*\.?[0-9]+)", s)
        if m:
            if not self.bpm:
                raise SceneError(f'{where}: "{v}" (bar:beat) needs scene.bpm')
            bar, beat = int(m.group(1)), float(m.group(2))
            if bar < 1 or beat < 1:
                raise SceneError(f'{where}: "{v}" — bars and beats count from 1 (the first beat is 1:1)')
            return ((bar - 1) * self.beats_per_bar + (beat - 1)) * self.beat
        return self.span(s, where)

    def label(self, t: float) -> str:
        if not self.bpm:
            return f"{t:.2f}s"
        beats = t / self.beat
        bar = int(beats // self.beats_per_bar) + 1
        beat = beats % self.beats_per_bar + 1
        return f"{t:.2f}s  {bar}:{beat:.3g}"


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------
KEY_FIELDS = {"t", "pose", "x", "y", "rot", "face", "ease", "expr", "look", "fx", "arc", "in", "hold", "do", "visible"}
EXPRESSIONS = ["calm", "happy", "angry", "sad", "surprised", "hurt", "focus", "ko", "sleepy", "smirk", "scared", "none"]
LOOKS = ["fwd", "back", "up", "down", "camera"]


@dataclass
class Key:
    t: float
    ang: dict
    x: float
    y: float
    rot: float
    face: int
    ease: str
    expr: str
    look: str
    fx: list
    arc: float
    visible: bool


def _face(v, where: str) -> int:
    if v in (1, -1):
        return int(v)
    s = str(v).strip().lower()
    if s in ("right", "r", "1", "+1"):
        return 1
    if s in ("left", "l", "-1"):
        return -1
    raise SceneError(f'{where}: face must be left or right, got "{v}"')


def _fx_list(v, where: str) -> list:
    """fx: walk | "walk+nod" | {use: walk, speed: 1.2} | [ … ] -> [(name, params)]"""
    if v is None or v is False or v == "none" or v == "":
        return []
    items = v if isinstance(v, list) else [v]
    out = []
    for it in items:
        if isinstance(it, dict):
            name = it.get("use")
            params = {k: val for k, val in it.items() if k != "use"}
            names = [(name, params)]
        else:
            names = [(n.strip(), {}) for n in str(it).split("+") if n.strip()]
        for name, params in names:
            e = registry.MOTIONS.get(str(name))
            if not e:
                raise SceneError(f'{where}: unknown fx "{name}"{suggest(name, registry.MOTIONS)} (studio-stickman list fx)')
            unknown = [k for k in params if k not in e.params]
            if unknown:
                raise SceneError(f'{where}: fx "{name}" has no parameter "{unknown[0]}" (has: {", ".join(e.params) or "none"})')
            out.append((e.name, {**e.params, **params}))
    return out


class Figure:
    def __init__(self, name: str, spec: dict, scene: "Scene", index: int):
        where = f"figures.{name}"
        self.name = name
        self.scene = scene
        try:
            self.color = color(spec.get("color"), (24, 24, 28))
            self.outline = color(spec["outline"]) if spec.get("outline") else None
        except ValueError as e:
            raise SceneError(f"{where}: {e}") from None
        self.auto_color = spec.get("color") is None      # the renderer picks dark or light against the scenery
        self.scale = float(spec.get("scale", 1.0))
        if not 0.2 <= self.scale <= 4:
            raise SceneError(f"{where}: scale must be between 0.2 and 4")
        self.build = {k: float(v) for k, v in (spec.get("build") or {}).items()}
        self.line = float(spec.get("line", scene.style["line"]))
        self.z = float(spec.get("z", index))
        self.label = spec.get("label")
        self.extras = {k: spec[k] for k in ("hat", "glasses", "tie", "badge", "cape", "hair", "eyes", "belt", "scarf", "shoes", "skin") if spec.get(k) not in (None, False)}
        self.phase = (index * 1.7) % 6.28
        self.raw: list[dict] = []
        self.keys: list[Key] = []
        self.times: list[float] = []
        self.user_times: list[float] = []
        self.held: list = []
        first = {"t": 0.0, "pose": spec.get("pose", "stand"), "x": float(spec.get("x", scene.w / 2)), "face": _face(spec.get("face", "right"), where), "_in": 0.0}
        if spec.get("y"):
            first["y"] = float(spec["y"])
        if spec.get("expr"):
            first["expr"] = spec["expr"]
        if spec.get("fx"):
            first["fx"] = spec["fx"]
        if spec.get("visible") is False:
            first["visible"] = False
        self.raw.append(first)
        self._where = [where]

    # -- building ----------------------------------------------------------------
    def add(self, t: float, pose, kw: dict, where: str) -> None:
        d = {**kw, "t": max(0.0, float(t))}
        if pose is not None:
            d["pose"] = pose
        d["_where"] = where
        self.raw.append(d)

    def last(self, field_: str, t: float, default=None):
        """The value a field has at time t according to the keys added so far."""
        best, best_t = default, -1.0
        for k in self.raw:
            if field_ in k and best_t <= k["t"] <= t + 1e-9:
                best, best_t = k[field_], k["t"]
        return best

    def resolve(self) -> None:
        raw = sorted(self.raw, key=lambda k: k["t"])  # stable: later items win at the same time
        blend = self.scene.blend
        keys: list[Key] = []
        prev: Key | None = None
        for k in raw:
            where = k.get("_where", f"figures.{self.name}")
            ang = dict(prev.ang) if prev else dict(STAND)
            rot = prev.rot if prev else 0.0
            fx = prev.fx if prev else []
            if "pose" in k:
                e = registry.POSES.get(str(k["pose"]))
                if not e:
                    raise SceneError(f'{where}: unknown pose "{k["pose"]}"{suggest(k["pose"], registry.POSES)} (studio-stickman list poses)')
                ang = {a: float(e.data.get(a, STAND[a])) for a in ANGLES}
                rot = float(e.data.get("rot", 0.0))
                fx = []
            for a in ANGLES:
                if a in k:
                    try:
                        ang[a] = float(k[a])
                    except (TypeError, ValueError):
                        raise SceneError(f'{where}: {a} must be an angle in degrees, got "{k[a]}"') from None
            if "rot" in k:
                rot = float(k["rot"])
            if "fx" in k:
                fx = _fx_list(k["fx"], where)
            ez = str(k.get("ease", "io"))
            if ez not in EASES:
                raise SceneError(f'{where}: unknown ease "{ez}" (one of: {", ".join(EASES)})')
            expr = str(k.get("expr", prev.expr if prev else "calm"))
            if expr not in EXPRESSIONS:
                raise SceneError(f'{where}: unknown expr "{expr}"{suggest(expr, EXPRESSIONS)} (one of: {", ".join(EXPRESSIONS)})')
            look = str(k.get("look", prev.look if prev else "fwd"))
            if look not in LOOKS:
                raise SceneError(f'{where}: unknown look "{look}" (one of: {", ".join(LOOKS)})')
            key = Key(
                t=k["t"], ang=ang, x=float(k.get("x", prev.x if prev else 0.0)), y=float(k.get("y", 0.0)), rot=rot,
                face=_face(k["face"], where) if "face" in k else (prev.face if prev else 1), ease=ez, expr=expr, look=look, fx=fx,
                arc=float(k.get("arc", 0.0)), visible=bool(k.get("visible", prev.visible if prev else True)),
            )
            # "be in this pose at t": hold the previous pose until shortly before (the transition time)
            if prev is not None:
                gap = key.t - prev.t
                d = k.get("_in", blend)
                d = gap if d is None else min(float(d), gap)
                if gap - d > 1e-6:
                    keys.append(Key(t=key.t - d, ang=prev.ang, x=prev.x, y=prev.y, rot=prev.rot, face=prev.face, ease="lin", expr=prev.expr, look=prev.look,
                                    fx=prev.fx, arc=0.0, visible=prev.visible))
            keys.append(key)
            prev = key
        self.keys = keys
        self.times = [k.t for k in keys]

    # -- playback -----------------------------------------------------------------
    def state(self, t: float) -> dict:
        ks = self.keys
        i = bisect.bisect_right(self.times, t) - 1
        if i < 0:
            a = b = ks[0]
            u = 0.0
        elif i >= len(ks) - 1:
            a = b = ks[-1]
            u = 0.0
        else:
            a, b = ks[i], ks[i + 1]
            span = b.t - a.t
            u = ease(b.ease, (t - a.t) / span) if span > 1e-9 else 1.0
        st = {n: lerp(a.ang[n], b.ang[n], u) for n in ANGLES}
        st["x"] = lerp(a.x, b.x, u)
        st["y"] = lerp(a.y, b.y, u) + (b.arc * 4 * u * (1 - u) if a is not b else 0.0)
        st["rot"] = lerp(a.rot, b.rot, u)
        st["face"] = a.face
        st["expr"] = b.expr if u > 0.5 else a.expr
        st["look"] = a.look
        st["visible"] = a.visible
        ctx = {"beat": self.scene.clock.beat, "phase": self.phase, "fps": self.scene.fps, "figure": self.name}
        fxs = a.fx if (a is b or u < 1.0) else b.fx
        if not fxs and st["rot"] == 0:
            fxs = [("idle", registry.MOTIONS["idle"].params)] if "idle" in registry.MOTIONS else []
        for name, params in fxs:
            registry.MOTIONS[name].fn(st, t, params, ctx)
        st["fx"] = [n for n, _ in fxs]
        return st

    def joints(self, t: float) -> tuple[dict, dict]:
        st = self.state(t)
        return st, fk(st, self.scene.floor, self.scale, self.build)


class ActionCtx:
    """What an action function gets: where and when it starts, and how to add keyframes / events."""

    def __init__(self, scene: "Scene", fig: Figure, t: float, params: dict, where: str, explicit: bool = False):
        self.scene = scene
        # the scene gave this action a fixed time (strikes then LAND at t instead of starting at t)
        self.explicit = explicit
        self.figure = fig
        self.name = fig.name
        self.t = t
        self.p = params
        self.where = where
        self.dur: float | None = None
        self._last = 0.0
        self.x = float(fig.last("x", t, scene.w / 2))
        self.face = _face(fig.last("face", t, 1), where)
        self.floor = scene.floor
        self.beat = scene.clock.beat or 0.5
        self.scale = fig.scale

    def key(self, dt: float, pose=None, **kw) -> None:
        """A keyframe of this figure, dt seconds after the action starts. kw: x, y, rot, face, ease,
        expr, look, fx, arc, in (transition seconds), angle overrides (RS=120 …)."""
        self._key(self.figure, dt, pose, kw)

    def key_for(self, name: str, dt: float, pose=None, **kw) -> None:
        """A keyframe of another figure (reactions)."""
        self._key(self.other(name), dt, pose, kw)

    def _key(self, fig: Figure, dt: float, pose, kw: dict) -> None:
        if "in_" in kw:
            kw["in"] = kw.pop("in_")
        if "in" in kw:
            kw["_in"] = kw.pop("in")
        bad = [k for k in kw if k not in KEY_FIELDS and k not in ANGLES and k != "_in"]
        if bad:
            raise SceneError(f'{self.where}: action key has an unknown field "{bad[0]}"')
        fig.add(self.t + dt, pose, kw, self.where)
        if fig is self.figure:
            self._last = max(self._last, dt)

    def event(self, dt: float, **ev) -> None:
        """A timed event: sfx="punch", text="POW", hit=[x, y], shake=8, flash=True, burst="dust" …"""
        self.scene.add_event({"t": self.t + dt, **ev}, self.where)

    def other(self, name: str) -> Figure:
        f = self.scene.figures.get(str(name))
        if not f:
            raise SceneError(f'{self.where}: unknown figure "{name}"{suggest(name, self.scene.figures)}')
        return f

    def x_of(self, name: str, dt: float = 0.0) -> float:
        return float(self.other(name).last("x", self.t + dt, self.scene.w / 2))

    def warn(self, msg: str) -> None:
        self.scene.warnings.append(f"{self.where}: {msg}")

    def free(self, name: str, t0: float, t1: float) -> bool:
        """True when the scene file itself gives `name` no keyframe between t0 and t1 (seconds after
        the action starts) — then an automatic reaction does not fight the author's choreography."""
        f = self.other(name)
        return not any(self.t + t0 - 1e-6 <= t <= self.t + t1 + 1e-6 for t in f.user_times)

    def point(self, name: str, part: str = "chest", dt: float = 0.0) -> tuple[float, float]:
        """World position of a body part of a figure (head, chest, hip, hand, foot) as posed so far."""
        f = self.other(name)
        x = float(f.last("x", self.t + dt, self.scene.w / 2))
        s = f.scale
        h = {"head": 190, "chest": 135, "hip": 100, "hand": 120, "knee": 55, "foot": 10}.get(part, 135) * s
        return (x, self.floor - h)

    @property
    def end(self) -> float:
        return self.dur if self.dur is not None else self._last


# ---------------------------------------------------------------------------
# Props, camera
# ---------------------------------------------------------------------------
@dataclass
class Prop:
    name: str
    kind: str
    params: dict
    layer: str
    x: float
    y: float
    rot: float
    scale: float
    flip: int
    t_from: float
    t_to: float
    keys: list = field(default_factory=list)   # (t, x, y, rot, arc, ease)
    held_by: str | None = None
    hand: str = "R"
    angle: float = 0.0

    def at(self, t: float) -> tuple[float, float, float]:
        ks = self.keys
        if not ks:
            return self.x, self.y, self.rot
        if t <= ks[0][0]:
            return ks[0][1], ks[0][2], ks[0][3]
        for a, b in zip(ks, ks[1:]):
            if a[0] <= t <= b[0]:
                span = b[0] - a[0]
                u = ease(b[5], (t - a[0]) / span) if span > 1e-9 else 1.0
                lift = b[4] * 4 * u * (1 - u)
                return lerp(a[1], b[1], u), lerp(a[2], b[2], u) - lift, lerp(a[3], b[3], u)
        return ks[-1][1], ks[-1][2], ks[-1][3]


@dataclass
class CamKey:
    t: float
    x: float | None
    y: float | None
    zoom: float
    ease: str
    follow: str | None
    dx: float
    dy: float


EVENT_KINDS = ["text", "say", "caption", "title", "hit", "sfx", "shake", "flash", "burst", "fade"]
EVENT_DEFAULTS = {
    "text": {"x": None, "y": None, "size": 48, "color": "#ffe628", "dur": 0.8, "ui": False, "font": "bold", "pop": True, "rot": None, "outline": True},
    "say": {"who": None, "dur": None, "size": 24, "color": "#16181d", "bubble": "#ffffff", "sfx": "pop"},
    "caption": {"dur": None, "size": 30, "color": "#ffffff"},
    "title": {"sub": None, "dur": 2.5, "size": 84, "color": "#ffffff", "shade": 0.55},
    "hit": {"word": None, "sfx": "punch", "shake": 9, "flash": False, "sparks": True, "zoom": 0.05, "color": "#ffe628", "size": 64, "gain": 1.0},
    "sfx": {"gain": 1.0, "pan": None},
    "shake": {"dur": 0.35},
    "flash": {"dur": 0.09, "alpha": 0.85},
    "burst": {"x": None, "y": None, "n": 18, "speed": 300, "dir": [0, -0.4], "spread": 1.0, "life": 0.8, "gravity": None, "color": None, "size": None},
    "fade": {"dur": 1.0, "color": "#000000"},
}


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------
class Scene:
    def __init__(self, data: dict, path: Path):
        self.path = path
        self.warnings: list[str] = []
        unknown = set(data) - {"scene", "figures", "props", "timeline", "camera", "events", "use"}
        if unknown:
            self.warnings.append(f"ignored top-level keys: {', '.join(sorted(map(str, unknown)))} (known: scene figures props timeline camera events use)")
        registry.load_builtins()
        for pack_id in data.get("use") or []:
            try:
                registry.load_pack(str(pack_id))
            except ImportError as e:
                raise SceneError(f"use: {e}") from None
        registry.load_project_plugins()
        for err in registry.PLUGIN_ERRORS:
            self.warnings.append(f'plugin {err["file"]} failed to load: {err["error"]}')

        s = data.get("scene") or {}
        if not isinstance(s, dict):
            raise SceneError("scene: must be a mapping (title, size, fps, bpm …)")
        self.title = str(s.get("title") or path.name.split(".")[0])
        size = s.get("size", [1280, 720])
        if not (isinstance(size, list) and len(size) == 2):
            raise SceneError("scene.size must be [width, height], e.g. [1280, 720]")
        self.w, self.h = int(size[0]), int(size[1])
        if not (64 <= self.w <= 3840 and 64 <= self.h <= 2160) or self.w % 2 or self.h % 2:
            raise SceneError("scene.size: width and height must be even numbers between 64 and 3840×2160")
        world = s.get("world", [self.w, self.h])
        self.world_w, self.world_h = int(world[0]), int(world[1])
        if self.world_w < self.w or self.world_h < self.h:
            raise SceneError("scene.world must be at least as large as scene.size (it is the scenery the camera moves over)")
        self.fps = int(s.get("fps", 30))
        if not 5 <= self.fps <= 60:
            raise SceneError("scene.fps must be between 5 and 60")
        bpm = s.get("bpm")
        if bpm is None and str(s.get("audio") or "").endswith((".song.yaml", ".song.yml")):
            # the soundtrack is a studio-daw song: its tempo is the tempo of the scene
            try:
                song = yaml.safe_load((registry.project_dir() / str(s["audio"])).read_text("utf-8")) or {}
                bpm = (song.get("song") or {}).get("bpm")
            except (OSError, yaml.YAMLError, AttributeError):
                bpm = None
        meter = str(s.get("time", "4/4"))
        try:
            num, den = [int(v) for v in meter.split("/")]
            beats_per_bar = num * 4 / den
        except ValueError:
            raise SceneError(f'scene.time must look like "4/4", got "{meter}"') from None
        if bpm is not None and not 20 <= float(bpm) <= 400:
            raise SceneError("scene.bpm must be between 20 and 400")
        self.clock = Clock(float(bpm) if bpm else None, beats_per_bar)
        self.floor = float(s.get("floor", self.world_h - 80))
        self.blend = self.clock.span(s.get("blend", 0.22), "scene.blend")
        self.seed = int(s.get("seed", 1))
        style = {"line": 9.0, "outline": True, "shadow": True, "vignette": 0.25, "grain": 0.0, "faces": True, "highlight": True}
        for k, v in (s.get("style") or {}).items():
            if k not in style:
                raise SceneError(f'scene.style: unknown option "{k}" (options: {", ".join(style)})')
            style[k] = v
        self.style = style
        self.audio = s.get("audio")
        self.audio_gain = float(s.get("audio_gain", 0.0))       # dB
        self.audio_offset = self.clock.span(s.get("audio_offset", 0), "scene.audio_offset")
        self.sfx_gain = float(s.get("sfx_gain", 0.0))           # dB
        self.background = self._backdrop(s.get("background", "room"))

        # figures
        figs = data.get("figures") or {}
        if not isinstance(figs, dict) or not figs:
            raise SceneError("figures: define at least one, e.g.  figures: { hero: { color: black, x: 400 } }")
        self.figures: dict[str, Figure] = {}
        for i, (name, spec) in enumerate(figs.items()):
            if not isinstance(spec, dict):
                spec = {} if spec is None else {"color": spec}
            bad = set(spec) - {"color", "outline", "scale", "build", "line", "z", "label", "x", "y", "face", "pose", "expr", "fx", "visible",
                               "hat", "glasses", "tie", "badge", "cape", "hair", "eyes", "belt", "scarf", "shoes", "skin"}
            if bad:
                self.warnings.append(f'figures.{name}: unknown option(s) {", ".join(sorted(bad))}')
            self.figures[str(name)] = Figure(str(name), spec, self, i)

        self.events: list[dict] = []
        self.script: list[dict] = []          # the timeline as written: who does what from when to when (for `info`)
        self._timeline(data.get("timeline") or {})
        for i, ev in enumerate(data.get("events") or []):
            if not isinstance(ev, dict):
                raise SceneError(f"events[{i}] must be a mapping like {{t: 2, text: \"Hi\"}}")
            ev = dict(ev)
            ev["t"] = self.clock.at(ev.get("t", 0), 0.0, f"events[{i}].t")
            self.add_event(ev, f"events[{i}]")
        for f in self.figures.values():
            f.resolve()
        self.props = self._props(data.get("props") or {})
        self.camera = self._camera(data.get("camera") or [])
        self.events.sort(key=lambda e: e["t"])

        last = max([f.keys[-1].t for f in self.figures.values()] + [e["t"] + float(e.get("dur") or 0.5) for e in self.events] + [k.t for k in self.camera] + [0.0])
        if s.get("duration") is not None:
            self.duration = self.clock.span(s["duration"], "scene.duration")
            if self.duration < last - 0.5:
                self.warnings.append(f"scene.duration is {self.duration:g}s but things still happen at {last:.2f}s — they are cut off")
        else:
            self.duration = round(last + 1.0, 3)
        if not 0.1 <= self.duration <= 1800:
            raise SceneError("the scene must be between 0.1 seconds and 30 minutes long")
        self._lint()

    # -- helpers --------------------------------------------------------------------
    def _backdrop(self, v) -> tuple:
        if v is None or v is False:
            v = "plain"
        spec = {"use": v} if isinstance(v, str) else dict(v)
        name = str(spec.pop("use", "plain"))
        if name not in registry.BACKDROPS:
            try:
                col = color(name)
            except ValueError:
                raise SceneError(f'scene.background: unknown backdrop "{name}"{suggest(name, registry.BACKDROPS)} (studio-stickman list backdrops; or a color)') from None
            name, spec = "plain", {"color": list(col), **spec}
        e = registry.BACKDROPS[name]
        bad = [k for k in spec if k not in e.params]
        if bad:
            raise SceneError(f'scene.background: backdrop "{name}" has no parameter "{bad[0]}" (has: {", ".join(e.params) or "none"})')
        return (name, {**e.params, **spec})

    def add_event(self, ev: dict, where: str) -> None:
        kinds = [k for k in EVENT_KINDS if k in ev]
        if len(kinds) != 1:
            if "hit" in kinds and len(kinds) > 1:
                kinds = ["hit"]
            else:
                raise SceneError(f"{where}: an event needs exactly one of: {', '.join(EVENT_KINDS)} — got {', '.join(kinds) or 'none'}")
        kind = kinds[0]
        out = {"kind": kind, "t": float(ev["t"]), "value": ev[kind], "_where": where}
        defaults = EVENT_DEFAULTS[kind]
        extra_ok = kind in ("sfx", "burst")       # parameters of the sound / particle
        for k, v in ev.items():
            if k in ("t", kind, "_where"):
                continue
            if k not in defaults and not extra_ok:
                raise SceneError(f'{where}: a "{kind}" event has no option "{k}" (options: {", ".join(defaults)})')
            out[k] = v
        for k, v in defaults.items():
            out.setdefault(k, v)
        for k in ("dur",):
            if out.get(k) is not None:
                out[k] = self.clock.span(out[k], f"{where}.{k}")
        if kind == "sfx":
            self._sound_name(out["value"], where)
        if kind == "say":
            if out.get("sfx") in (None, False, "", "none"):
                out["sfx"] = None
            else:
                self._sound_name(out["sfx"], where)
        if kind == "hit":
            if out.get("sfx"):
                self._sound_name(out["sfx"], where)
            v = out["value"]
            if isinstance(v, dict):
                if str(v.get("on")) not in self.figures:
                    raise SceneError(f'{where}: hit.on must name a figure{suggest(v.get("on"), self.figures)}')
            elif not (isinstance(v, list) and len(v) == 2):
                raise SceneError(f"{where}: hit must be [x, y] or {{on: figure, part: head}}")
        if kind == "burst" and str(out["value"]) not in registry.PARTICLES:
            raise SceneError(f'{where}: unknown particle "{out["value"]}"{suggest(out["value"], registry.PARTICLES)} (studio-stickman list particles)')
        if kind == "say" and out.get("who") is not None and str(out["who"]) not in self.figures:
            raise SceneError(f'{where}: say.who — unknown figure "{out["who"]}"{suggest(out["who"], self.figures)}')
        if kind == "fade" and str(out["value"]) not in ("in", "out"):
            raise SceneError(f'{where}: fade must be "in" or "out"')
        for k in ("color", "bubble"):
            if out.get(k) is not None:
                try:
                    color(out[k])
                except ValueError as e:
                    raise SceneError(f"{where}: {e}") from None
        self.events.append(out)

    def _sound_name(self, name, where: str) -> None:
        n = str(name)
        if n in registry.SOUNDS or "/" in n or n.lower().endswith((".wav", ".mp3", ".ogg", ".flac")):
            return
        raise SceneError(f'{where}: unknown sound "{n}"{suggest(n, registry.SOUNDS)} (studio-stickman list sounds; or an audio file / pack item)')

    def _timeline(self, tl: dict) -> None:
        if not isinstance(tl, dict):
            raise SceneError("timeline: must map figure names to lists of keyframes / actions")
        for name in tl:
            if str(name) not in self.figures:
                raise SceneError(f'timeline: unknown figure "{name}"{suggest(name, self.figures)}')
        # keyframes written with a fixed time: automatic reactions must not fight them
        for name, items in tl.items():
            f = self.figures[str(name)]
            for it in items or []:
                if isinstance(it, dict) and "do" not in it and it.get("t") is not None and not str(it["t"]).startswith("+"):
                    try:
                        f.user_times.append(self.clock.at(it["t"], 0.0, "t"))
                    except SceneError:
                        pass
        for name, items in tl.items():
            f = self.figures[str(name)]
            if not isinstance(items, list):
                raise SceneError(f"timeline.{name}: must be a list of keyframes / actions")
            prev_end = 0.0
            for i, it in enumerate(items):
                where = f"timeline.{name}[{i}]"
                if not isinstance(it, dict):
                    raise SceneError(f"{where}: must be a mapping like {{t: 2, pose: guard}} or {{do: punch, target: other}}")
                it = dict(it)
                explicit = it.get("t") is not None and not str(it.get("t")).strip().startswith("+")
                t = self.clock.at(it.pop("t", None), prev_end, f"{where}.t")
                if t < -1e-9:
                    raise SceneError(f"{where}: time is negative")
                # events written next to a key ("say", "sfx", "text" …) belong to this figure
                for kind in EVENT_KINDS:
                    if kind in it and kind != "hit":
                        ev = {"t": t, kind: it.pop(kind)}
                        if kind == "say":
                            ev["who"] = f.name
                            if "say_dur" in it:
                                ev["dur"] = it.pop("say_dur")
                        self.add_event(ev, where)
                end = t
                what = ""
                if "do" in it:
                    aname = str(it.pop("do"))
                    what = "do " + aname + "".join(f" {k}={v}" for k, v in it.items())
                    e = registry.ACTIONS.get(aname)
                    if not e:
                        raise SceneError(f'{where}: unknown action "{aname}"{suggest(aname, registry.ACTIONS)} (studio-stickman list actions)')
                    params = dict(e.params)
                    for k, v in it.items():
                        if k not in e.params:
                            raise SceneError(f'{where}: action "{aname}" has no parameter "{k}" (has: {", ".join(e.params) or "none"})')
                        params[k] = v
                    for k in ("dur", "hold"):
                        if params.get(k) is not None and k in e.params:
                            params[k] = self.clock.span(params[k], f"{where}.{k}")
                    ctx = ActionCtx(self, f, t, params, where, explicit)
                    try:
                        e.fn(ctx)
                    except SceneError:
                        raise
                    except Exception as ex:  # noqa: BLE001
                        raise SceneError(f'{where}: action "{aname}" failed: {type(ex).__name__}: {ex}') from None
                    end = t + ctx.end
                elif it:
                    bad = [k for k in it if k not in KEY_FIELDS and k not in ANGLES]
                    if bad:
                        raise SceneError(f'{where}: unknown field "{bad[0]}"{suggest(bad[0], [*KEY_FIELDS, *ANGLES])}')
                    kw = dict(it)
                    what = (f"pose {kw['pose']}" if "pose" in kw else "key") + "".join(f" {k}={v}" for k, v in kw.items() if k != "pose")
                    hold = self.clock.span(kw.pop("hold", 0), f"{where}.hold")
                    if "in" in kw:
                        v = kw.pop("in")
                        kw["_in"] = None if str(v) in ("full", "all") else self.clock.span(v, f"{where}.in")
                    pose = kw.pop("pose", None)
                    f.add(t, pose, kw, where)
                    if hold > 0:
                        f.add(t + hold, None, {"_in": 0.0}, where)
                    end = t + hold
                if what:
                    self.script.append({"t": t, "end": max(end, t), "who": f.name, "what": what})
                prev_end = max(end, t)

    def _props(self, spec: dict) -> list[Prop]:
        if not isinstance(spec, dict):
            raise SceneError("props: must map names to props, e.g.  props: { box: { kind: crate, x: 600 } }")
        out = []
        for name, p in spec.items():
            where = f"props.{name}"
            if not isinstance(p, dict):
                raise SceneError(f"{where}: must be a mapping like {{kind: crate, x: 600}}")
            p = dict(p)
            kind = str(p.pop("kind", name))
            e = registry.PROPS.get(kind)
            if not e:
                raise SceneError(f'{where}: unknown prop kind "{kind}"{suggest(kind, registry.PROPS)} (studio-stickman list props)')
            layer = str(p.pop("layer", "back"))
            if layer not in ("back", "front"):
                raise SceneError(f"{where}: layer must be back (behind the figures) or front")
            x = float(p.pop("x", self.w / 2))
            y = float(p.pop("y", self.floor))
            rot = float(p.pop("rot", 0))
            scale = float(p.pop("scale", 1))
            flip = -1 if p.pop("flip", False) else 1
            t_from = self.clock.at(p.pop("from", 0), 0.0, f"{where}.from")
            t_to = self.clock.at(p.pop("to", 1e9), 0.0, f"{where}.to")
            held_by = p.pop("held_by", None)
            if held_by is not None and str(held_by) not in self.figures:
                raise SceneError(f'{where}: held_by — unknown figure "{held_by}"{suggest(held_by, self.figures)}')
            hand = str(p.pop("hand", "R")).upper()[:1]
            if hand not in "RL":
                raise SceneError(f"{where}: hand must be R (near hand) or L (far hand)")
            angle = float(p.pop("angle", 0))
            keys = []
            cx, cy, cr = x, y, rot
            for i, k in enumerate(p.pop("keys", []) or []):
                kw = f"{where}.keys[{i}]"
                if not isinstance(k, dict) or "t" not in k:
                    raise SceneError(f"{kw}: needs t and x / y / rot")
                cx, cy, cr = float(k.get("x", cx)), float(k.get("y", cy)), float(k.get("rot", cr))
                ez = str(k.get("ease", "io"))
                if ez not in EASES:
                    raise SceneError(f'{kw}: unknown ease "{ez}"')
                keys.append((self.clock.at(k["t"], 0.0, kw), cx, cy, cr, float(k.get("arc", 0)), ez))
            if keys:
                keys.sort(key=lambda k: k[0])
                if keys[0][0] > 0:
                    keys.insert(0, (0.0, x, y, rot, 0.0, "io"))
            bad = [k for k in p if k not in e.params]
            if bad:
                raise SceneError(f'{where}: prop "{kind}" has no parameter "{bad[0]}" (has: {", ".join(e.params) or "none"})')
            prop = Prop(str(name), kind, {**e.params, **p}, layer, x, y, rot, scale, flip, t_from, t_to, keys, str(held_by) if held_by else None, hand, angle)
            out.append(prop)
        return out

    def _camera(self, keys: list) -> list[CamKey]:
        if isinstance(keys, dict):
            keys = [keys]
        out = []
        zoom = 1.0
        for i, k in enumerate(keys):
            where = f"camera[{i}]"
            if not isinstance(k, dict):
                raise SceneError(f"{where}: must be a mapping like {{t: 0, x: 640, y: 360, zoom: 1.2}}")
            bad = set(k) - {"t", "x", "y", "zoom", "ease", "follow", "dx", "dy", "cut"}
            if bad:
                raise SceneError(f'{where}: unknown field "{sorted(bad)[0]}" (fields: t x y zoom ease follow dx dy cut)')
            zoom = float(k.get("zoom", zoom))
            if not 0.2 <= zoom <= 8:
                raise SceneError(f"{where}: zoom must be between 0.2 and 8")
            follow = k.get("follow")
            if follow is not None and str(follow) not in self.figures:
                raise SceneError(f'{where}: follow — unknown figure "{follow}"{suggest(follow, self.figures)}')
            ez = "hold" if k.get("cut") else str(k.get("ease", "io"))
            if ez not in EASES:
                raise SceneError(f'{where}: unknown ease "{ez}"')
            out.append(CamKey(self.clock.at(k.get("t", 0), 0.0, f"{where}.t"), k.get("x"), k.get("y"), zoom, ez, str(follow) if follow else None,
                              float(k.get("dx", 0)), float(k.get("dy", 0))))
        out.sort(key=lambda c: c.t)
        return out

    def cam_at(self, t: float) -> tuple[float, float, float]:
        """Camera centre (world) and zoom at time t."""
        def target(k: CamKey) -> tuple[float, float]:
            x = k.x if k.x is not None else self.w / 2
            y = k.y if k.y is not None else self.h / 2
            if k.follow:
                st = self.figures[k.follow].state(t)
                x = st["x"] + k.dx
                if k.y is None:
                    y = self.floor - 110 * self.figures[k.follow].scale - st["y"] * 0.6 + k.dy
            return float(x), float(y)

        ks = self.camera
        if not ks:
            return self.w / 2, self.h / 2, 1.0
        if t <= ks[0].t:
            x, y = target(ks[0])
            return x, y, ks[0].zoom
        for a, b in zip(ks, ks[1:]):
            if a.t <= t < b.t:
                u = ease(b.ease, (t - a.t) / (b.t - a.t)) if b.t > a.t else 1.0
                ax, ay = target(a)
                bx, by = target(b)
                # zoom feels even when it changes by ratio, not by difference
                z = math.exp(lerp(math.log(a.zoom), math.log(b.zoom), u))
                return lerp(ax, bx, u), lerp(ay, by, u), z
        x, y = target(ks[-1])
        return x, y, ks[-1].zoom

    def _lint(self) -> None:
        for f in self.figures.values():
            xs = [k.x for k in f.keys]
            if max(xs) < -50 or min(xs) > self.world_w + 50:
                self.warnings.append(f'figure "{f.name}" is never inside the scene (x {min(xs):g}…{max(xs):g}, scene width {self.world_w})')
            elif min(xs) < -200 or max(xs) > self.world_w + 200:
                self.warnings.append(f'figure "{f.name}" moves far outside the scene (x {min(xs):g}…{max(xs):g}, scene width {self.world_w})')
            if len(f.raw) == 1:
                self.warnings.append(f'figure "{f.name}" has no timeline — it just stands there')
        for ev in self.events:
            if ev["t"] > self.duration + 1e-6:
                self.warnings.append(f'{ev["_where"]}: happens at {ev["t"]:.2f}s, after the end ({self.duration:g}s)')
        for k in self.camera:
            if k.zoom < 0.999 and (self.world_w, self.world_h) == (self.w, self.h):
                self.warnings.append("camera zoom below 1 shows the area around the scenery — set scene.world larger than scene.size for wide shots")
                break
        if self.audio and not self.clock.bpm:
            self.warnings.append('scene.audio is set but scene.bpm is not — with the bpm of the music you can place moves on beats ("5:1")')

    def hit_point(self, ev: dict) -> tuple[float, float]:
        v = ev["value"]
        if isinstance(v, dict):
            f = self.figures[str(v["on"])]
            _, P = f.joints(ev["t"])
            part = str(v.get("part", "chest"))
            if part == "chest":
                return ((P["sho"][0] + P["hip"][0]) / 2, P["sho"][1] * 0.7 + P["hip"][1] * 0.3)
            key = {"head": "head", "hip": "hip", "hand": "Rhand", "foot": "Rfoot", "knee": "Rknee", "neck": "neck"}.get(part, "head")
            return P[key]
        return float(v[0]), float(v[1])


def load_scene_text(text: str, path: str | Path = "scene.stick.yaml") -> Scene:
    path = Path(path)
    try:
        data = yaml.load(text, Loader=_Loader) or {}
    except yaml.YAMLError as e:
        raise SceneError(f"{path.name}: YAML syntax error: {e}") from None
    if not isinstance(data, dict):
        raise SceneError("a scene file must be a mapping with scene / figures / timeline")
    return Scene(data, path)


def load_scene(path: str | Path) -> Scene:
    path = Path(path)
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        raise SceneError(f"file not found: {path}") from None
    return load_scene_text(text, path)
