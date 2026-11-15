"""Scene files (*.stick.yaml): load, validate, expand actions into keyframes.

The result is a Scene: figures with resolved keyframes (state at any time), props, camera keys
and a flat list of timed events (texts, hits, sounds, particles …) for the renderer.

Every problem names its place in the file — the YAML path (`timeline.red[2]`) and the line — and
loading carries on after a problem wherever that is safe, so one `check` reports all independent
mistakes at once instead of one per round trip. Values are checked here, at load time, so a scene
that passes `check` does not fail later while it is drawn.
"""
from __future__ import annotations

import bisect
import difflib
import math
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import registry
from .registry import suggest  # noqa: F401  (kept for plugins that import it from here)
from .skeleton import ANGLES, DIMS, EASES, STAND, color, ease, fk, lerp

MAX_SECONDS = 1800.0          # 30 minutes: the longest scene
MAX_KEYS = 200_000            # keyframes per scene (a runaway `times:` / `beats:` stops here, fast)
MAX_ERRORS = 40               # more than this many problems: the first ones are enough to start with


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class SceneError(Exception):
    """A problem in a scene. `where` is the YAML path (timeline.red[2]), `line` its line in the file;
    `code` names the kind of problem, `got` the bad value and `suggest` close valid values."""

    def __init__(self, msg: str = "", *, where: str | None = None, line: int | None = None, col: int | None = None,
                 code: str | None = None, got=None, suggest=None):
        super().__init__(msg)
        self.message = str(msg)
        self.where = where
        self.line = line
        self.col = col
        self.code = code
        self.got = got
        self.suggest = list(suggest) if suggest else None

    def __str__(self) -> str:
        if not self.where:
            return self.message
        return f"{self.where}{f' (line {self.line})' if self.line else ''}: {self.message}"

    def to_dict(self) -> dict:
        d = {"message": str(self), "where": self.where, "line": self.line, "col": self.col, "code": self.code,
             "got": _plain(self.got), "suggest": self.suggest}
        return {k: v for k, v in d.items() if v is not None}

    def __reduce__(self):
        # keep where / line / code when the error crosses a process boundary (render workers)
        return (_restore_error, (type(self), self.message, dict(self.__dict__)))


class SceneErrors(SceneError):
    """Several independent problems found in one pass; `errors` in file order."""

    def __init__(self, errors: list):
        self.errors = list(errors)
        super().__init__("\n".join(str(e) for e in self.errors), code="several")

    def __str__(self) -> str:
        return "\n".join(str(e) for e in self.errors)

    def to_dict(self) -> dict:
        return {"message": str(self), "code": "several", "errors": [e.to_dict() for e in self.errors]}


def _restore_error(cls, msg: str, state: dict):
    e = cls.__new__(cls)
    Exception.__init__(e, msg)
    e.__dict__.update(state)
    return e


def _plain(v):
    """A value as it can go into JSON (the bad value an error reports)."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def _show(v) -> str:
    return f'"{v}"' if isinstance(v, str) else "nothing" if v is None else str(v)


def _close(word, options, n: int = 3) -> list[str]:
    return difflib.get_close_matches(str(word), [str(o) for o in options], n=n, cutoff=0.5)


def _dym(close: list[str]) -> str:
    return f" — did you mean {', '.join(close)}?" if close else ""


def _plugin_note() -> str:
    """A name that should come from a plugin is unknown: say first if a plugin failed to load."""
    errs = registry.PLUGIN_ERRORS
    if not errs:
        return ""
    e = errs[0]
    return f' (note: plugin {e["file"]} failed to load: {e["error"]} — fix it first)'


def _unknown(where: str, what: str, got, options, hint: str = "", plugins: bool = True) -> SceneError:
    close = _close(got, options)
    msg = f'unknown {what} "{got}"{_dym(close)}' + (f" ({hint})" if hint else "") + (_plugin_note() if plugins else "")
    return SceneError(msg, where=where, code=f"unknown-{what.split()[-1]}", got=got, suggest=close)


# ---------------------------------------------------------------------------
# Values: each check raises a SceneError that names the place
# ---------------------------------------------------------------------------
BOOL_WORDS = {"true": True, "yes": True, "on": True, "false": False, "no": False, "off": False}


def _bool_word(v):
    """yes / no / on / off (plain text since YAML 1.2, see _Loader) -> True / False; others unchanged."""
    if isinstance(v, str) and v.strip().lower() in BOOL_WORDS:
        return BOOL_WORDS[v.strip().lower()]
    return v


def _bool(v, where: str) -> bool:
    v = _bool_word(v)
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    raise SceneError(f"expected true or false, got {_show(v)}", where=where, code="bad-bool", got=v)


def _range_text(lo, hi) -> str:
    if lo is not None and hi is not None:
        return f"between {lo:g} and {hi:g}"
    return f"at least {lo:g}" if lo is not None else f"at most {hi:g}"


def _num(v, where: str, lo: float | None = None, hi: float | None = None, what: str = "a number") -> float:
    if isinstance(v, bool) or v is None or isinstance(v, (list, dict)):
        raise SceneError(f"expected {what}, got {_show(v)}", where=where, code="bad-number", got=v)
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise SceneError(f"expected {what}, got {_show(v)}", where=where, code="bad-number", got=v) from None
    if not math.isfinite(x):
        raise SceneError(f"expected {what}, got {_show(v)}", where=where, code="bad-number", got=v)
    if (lo is not None and x < lo) or (hi is not None and x > hi):
        raise SceneError(f"must be {_range_text(lo, hi)}, got {x:g}", where=where, code="out-of-range", got=v)
    return x


def _int(v, where: str, lo: float | None = None, hi: float | None = None) -> int:
    x = _num(v, where, lo, hi, "a whole number")
    if x != int(x):
        raise SceneError(f"expected a whole number, got {x:g}", where=where, code="bad-number", got=v)
    return int(x)


def _pair(v, where: str, example: str = "[x, y]") -> tuple[float, float]:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise SceneError(f"expected two numbers like {example}, got {_show(v)}", where=where, code="bad-value", got=v)
    return _num(v[0], f"{where}[0]"), _num(v[1], f"{where}[1]")


def _col(v, where: str) -> tuple:
    try:
        return color(v)
    except (TypeError, ValueError) as e:
        msg = str(e) if isinstance(e, ValueError) else f"{_show(v)} is not a color"
        raise SceneError(msg, where=where, code="bad-color", got=v) from None


def _param(default, v, where: str, clock: "Clock | None" = None):
    """A parameter of an action, fx, prop, backdrop or particle, checked against the type of its
    default value (plugins declare their parameters with defaults, so this covers them too)."""
    if v is None:
        return None
    if isinstance(default, bool):
        return _bool(v, where)
    if isinstance(default, (int, float)):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if not math.isfinite(float(v)):
                raise SceneError(f"expected a number, got {v}", where=where, code="bad-number", got=v)
            return v
        if clock is not None and where.rsplit(".", 1)[-1] in ("dur", "hold"):
            return clock.span(v, where)             # says what a time looks like when it is not one
        if clock is not None and isinstance(v, str):
            try:
                return clock.span(v, where)        # a length with a unit: "1b", "0.5s", "1bar"
            except SceneError:
                pass
        x = _num(v, where)
        return int(x) if isinstance(default, int) and x == int(x) else x
    if isinstance(default, str) and default.startswith("#"):
        _col(v, where)
        return v
    if isinstance(default, (list, tuple)) and not isinstance(v, (list, tuple)):
        raise SceneError(f"expected a list like {list(default)}, got {_show(v)}", where=where, code="bad-value", got=v)
    return v


def _check_params(e, given: dict, where: str, what: str, clock: "Clock | None" = None) -> dict:
    """Merge the given parameters over the defaults of a registry entry; unknown names are errors."""
    out = dict(e.params)
    for k, v in given.items():
        if k not in e.params:
            close = _close(k, e.params)
            raise SceneError(f'{what} "{e.name}" has no parameter "{k}"{_dym(close)} (has: {", ".join(map(str, e.params)) or "none"})',
                             where=where, code="unknown-param", got=k, suggest=close)
        out[k] = _param(e.params[k], v, f"{where}.{k}", clock)
    # parameters that take one of a few words (roll dir: front | back) or a number in a range (power 0..5),
    # as the entry declares them (api: @action(…, choices={…}, ranges={…}))
    for k, allowed in (getattr(e, "choices", None) or {}).items():
        if out.get(k) is None or k not in given:
            continue
        s = str(out[k]).strip().lower()
        if CHOICE_ALIASES.get(s) in allowed:
            s = CHOICE_ALIASES[s]
        if s not in allowed:
            close = _close(s, allowed)
            raise SceneError(f'{k} must be {" or ".join(allowed)}, got {_show(out[k])}{_dym(close)}', where=f"{where}.{k}", code="bad-value",
                             got=out[k], suggest=close)
        out[k] = s
    for k, (lo, hi) in (getattr(e, "ranges", None) or {}).items():
        if out.get(k) is not None and k in given:
            x = _num(out[k], f"{where}.{k}", lo, hi)
            out[k] = int(x) if isinstance(out[k], int) and x == int(x) else x
    return out


# ---------------------------------------------------------------------------
# YAML: "5:1" must stay text (bar:beat), not become the base-60 number 301; on / off / yes / no stay
# text (YAML 1.2), so `hit: { on: b }` and a figure called "no" work; a key written twice is an error
# ---------------------------------------------------------------------------
class _Loader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        if isinstance(node, yaml.MappingNode):
            seen: dict = {}
            for key_node, _ in node.value:
                if key_node.tag == "tag:yaml.org,2002:merge" or not isinstance(key_node, yaml.ScalarNode):
                    continue
                key = self.construct_object(key_node, deep=deep)
                if key in seen:
                    # an appended second `timeline:` block would silently wipe out the first one
                    raise yaml.constructor.ConstructorError(
                        None, None, f'"{key}" is written twice (first at line {seen[key] + 1}) — the second one would silently replace the first; '
                        "merge the two", key_node.start_mark)
                seen[key] = key_node.start_mark.line
        return super().construct_mapping(node, deep=deep)


_DROP = ("tag:yaml.org,2002:int", "tag:yaml.org,2002:float", "tag:yaml.org,2002:bool")
_Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag not in _DROP]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_Loader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))
_Loader.add_implicit_resolver("tag:yaml.org,2002:int", re.compile(r"^[-+]?(?:0|[1-9][0-9_]*)$"), list("-+0123456789"))
_Loader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(r"^[-+]?(?:[0-9][0-9_]*\.[0-9_]*(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[0-9][0-9_]*[eE][-+]?[0-9]+)$"),
    list("-+0123456789."),
)


def _index(node, path: str, out: dict, depth: int = 0) -> None:
    """Record the (line, column) of every YAML path: "timeline.red[2]" -> (17, 7)."""
    if depth > 40:
        return
    if isinstance(node, yaml.MappingNode):
        for k, v in node.value:
            if k.tag == "tag:yaml.org,2002:merge":
                continue
            key = k.value if isinstance(k, yaml.ScalarNode) else "?"
            p = f"{path}.{key}" if path else str(key)
            out[p] = (k.start_mark.line + 1, k.start_mark.column + 1)   # later wins: a key overrides a merged one
            _index(v, p, out, depth + 1)
    elif isinstance(node, yaml.SequenceNode):
        for i, v in enumerate(node.value):
            p = f"{path}[{i}]"
            out[p] = (v.start_mark.line + 1, v.start_mark.column + 1)
            _index(v, p, out, depth + 1)


_YAML_HINTS = [
    ("cannot start any token", "'\\t'", " — tabs cannot indent YAML: use spaces"),
    ("mapping values are not allowed here", "", " — a text that contains ': ' needs quotes (title: \"Round 1: go\"), or the indentation is off"),
    ("expected ',' or '}'", "", " — a { … } item above misses a comma or its closing }"),
    ("expected ',' or ']'", "", " — a [ … ] list above misses a comma or its closing ]"),
    ("could not find expected ':'", "", " — a line misses its ': ', or a quote is not closed"),
    ("found unexpected end of stream", "", " — a quote or bracket is not closed"),
    ("expected <block end>", "", " — this line is indented differently from the lines above it"),
    ("found undefined alias", "", " — the *name refers to an &name that is not defined above it"),
]


def _yaml_error(e: yaml.YAMLError, path: Path) -> SceneError:
    mark = getattr(e, "problem_mark", None) or getattr(e, "context_mark", None)
    problem = getattr(e, "problem", None) or str(e)
    context, cmark = getattr(e, "context", None), getattr(e, "context_mark", None)
    code = "duplicate-key" if "written twice" in problem else "yaml-syntax"
    kind = "duplicate key" if code == "duplicate-key" else "YAML syntax error"
    text = f"{kind}{f' at column {mark.column + 1}' if mark else ''}: {problem}"
    if context and cmark and (not mark or cmark.line != mark.line):
        text += f" ({context} at line {cmark.line + 1})"
    for needle, also, hint in _YAML_HINTS:
        if needle in problem and also in problem:
            text += hint
            break
    return SceneError(text, where=path.name, line=mark.line + 1 if mark else None, col=mark.column + 1 if mark else None, code=code)


def _parse(text: str) -> tuple:
    loader = _Loader(text)
    try:
        node = loader.get_single_node()
        data = loader.construct_document(node) if node is not None else None
    finally:
        loader.dispose()
    lines: dict = {}
    if node is not None:
        _index(node, "", lines)
    return data, lines


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

    def span(self, v, where: str, allow_negative: bool = False) -> float:
        """A length of time: 1.5 (seconds), "1.5s", "2b" (beats), "1bar"."""
        if isinstance(v, bool) or v is None or isinstance(v, (list, dict)):
            raise SceneError(f"expected a time, got {_show(v)}", where=where, code="bad-time", got=v)
        if isinstance(v, (int, float)):
            x = float(v)
            if not math.isfinite(x):
                raise SceneError(f"expected a time, got {v}", where=where, code="bad-time", got=v)
            if x < 0 and not allow_negative:
                raise SceneError(f"must not be negative, got {x:g}", where=where, code="out-of-range", got=v)
            return x
        s = str(v).strip().lower()
        m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*(s|sec|b|beat|beats|bar|bars)?", s)
        if not m:
            raise SceneError(f'"{v}" is not a time (seconds like 1.5, beats like 2b, bars like 1bar)', where=where, code="bad-time", got=v)
        n = float(m.group(1))
        unit = m.group(2) or "s"
        if unit in ("s", "sec"):
            return n
        if not self.bpm:
            raise SceneError(f'"{v}" needs scene.bpm (beats and bars are measured against the music)', where=where, code="needs-bpm", got=v)
        return n * self.beat * (self.beats_per_bar if unit.startswith("bar") else 1)

    def at(self, v, prev_end: float, where: str) -> float:
        """A point in time: seconds, "bar:beat" (both from 1), or "+…" after the previous item ended."""
        if v is None:
            return prev_end
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            x = float(v)
            if not math.isfinite(x):
                raise SceneError(f"expected a time, got {v}", where=where, code="bad-time", got=v)
            return x
        s = str(v).strip()
        if s.startswith("+"):
            return prev_end + self.span(s[1:], where)
        m = re.fullmatch(r"([0-9]+):([0-9]*\.?[0-9]+)", s)
        if m:
            if not self.bpm:
                raise SceneError(f'"{v}" (bar:beat) needs scene.bpm', where=where, code="needs-bpm", got=v)
            bar, beat = int(m.group(1)), float(m.group(2))
            if bar < 1 or beat < 1:
                raise SceneError(f'"{v}" — bars and beats count from 1 (the first beat is 1:1)', where=where, code="bad-time", got=v)
            if beat >= self.beats_per_bar + 1:
                raise SceneError(f'"{v}": beat {beat:g} does not exist in a bar of {self.beats_per_bar:g} beats (beats 1–{self.beats_per_bar:g}; '
                                 f'the next bar is "{bar + 1}:1")', where=where, code="bad-time", got=v)
            return ((bar - 1) * self.beats_per_bar + (beat - 1)) * self.beat
        return self.span(s, where)

    def label(self, t: float) -> str:
        if not self.bpm or not self.beats_per_bar:
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
FIGURE_KEYS = ["color", "outline", "scale", "build", "line", "z", "label", "x", "y", "face", "pose", "expr", "fx", "visible",
               "hat", "glasses", "tie", "badge", "cape", "hair", "eyes", "belt", "scarf", "shoes", "skin", "talk"]
# what a timeline entry does to the body (a key with only say / expr / look / fx leaves it where it is)
BODY_FIELDS = ("pose", "x", "y", "rot", *ANGLES)
ARM_ANGLES = ("RS", "RE", "LS", "LE")
# what a figure may still do while it falls, knocked out (they do not move the body)
KO_ALLOWED = ("vanish", "wait")
# poses a speaker gestures in (say): anything else is held on purpose — a hand at the chin (think), a
# hand over the face, fists up — and the automatic talk gestures would pull the hands away from it
TALK_POSES = ("stand", "sit", "sit_floor")
# a hinge joint outside these is clamped while drawing (skeleton.LIMITS): the name for the warning
JOINT_NAMES = {"RE": "elbow", "LE": "elbow", "RK": "knee", "LK": "knee", "H": "head"}
# say these words to a choice parameter and the scene means that value (roll dir: forward = front)
CHOICE_ALIASES = {"forward": "front", "forwards": "front", "backward": "back", "backwards": "back", "l": "left", "r": "right"}
EXTRAS = ("hat", "glasses", "tie", "badge", "cape", "hair", "eyes", "belt", "scarf", "shoes", "skin")
COLOR_EXTRAS = ("glasses", "tie", "cape", "hair", "belt", "scarf", "skin")     # true (the default color) or a color
_HATS = ["cap", "tophat", "crown", "headband", "helmet", "beanie", "horns"]

# joints that can turn all the way round go the short way between two keys; hinge joints (elbows,
# knees) never wrap, and neither does `rot` (360 = a flip on purpose)
WRAP = ("T", "H", "RS", "LS", "RH", "LH")


def _turn(a: float, b: float) -> float:
    """How far to turn from angle a to b: the short way round. When both ways are nearly equally long
    (around 180°) take the one that keeps the limb away from pointing up behind the body, where
    shoulders and hips cannot go (stand -> overhead swings the arm up in front, not backwards)."""
    d = (b - a + 180.0) % 360.0 - 180.0
    if abs(d) > 150.0:
        alt = d - 360.0 if d > 0 else d + 360.0
        if _off_back(a + alt / 2) > _off_back(a + d / 2):
            d = alt
    return d


def _off_back(ang: float) -> float:
    return abs((ang + 135.0 + 180.0) % 360.0 - 180.0)


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
    # walk/run/sneak: the x range of the stretch this key's segment belongs to (footstep planning)
    run: tuple | None = None
    where: str = ""
    # how far each angle moves from the previous key to this one (the short way for WRAP joints)
    dang: dict | None = None
    # the fx of this key other than walk/run/sneak, with `idle` when it has none (layered in state())
    nfx: list = field(default_factory=list)


GAIT_FX = ("walk", "run", "sneak")


def _gait(fx: list) -> tuple | None:
    """The walk/run/sneak entry of an fx list (name, params), if any."""
    return next(((n, p) for n, p in fx if n in GAIT_FX), None)


def _face(v, where: str) -> int:
    if v in (1, -1) and not isinstance(v, bool):
        return int(v)
    s = str(v).strip().lower()
    if s in ("right", "r", "1", "+1"):
        return 1
    if s in ("left", "l", "-1"):
        return -1
    raise SceneError(f'face must be left or right, got "{v}"', where=where, code="bad-face", got=v)


def _fx_list(v, where: str) -> list:
    """fx: walk | "walk+nod" | {use: walk, speed: 1.2} | [ … ] -> [(name, params)]"""
    v = _bool_word(v)
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
                raise _unknown(f"{where}.fx", "fx", name, registry.MOTIONS, "studio-stickman list fx")
            out.append((e.name, _check_params(e, params, f"{where}.fx", "fx")))
    return out


def _check_key_fields(kw: dict, where: str) -> None:
    """Values of a keyframe written in the scene file, checked where they are written."""
    for k in ("x", "y", "rot", "arc"):
        if k in kw:
            kw[k] = _num(kw[k], f"{where}.{k}")
    for a in ANGLES:
        if a in kw:
            kw[a] = _num(kw[a], f"{where}.{a}", what="an angle in degrees")
    if "face" in kw:
        _face(kw["face"], f"{where}.face")
    if "visible" in kw:
        kw["visible"] = _bool(kw["visible"], f"{where}.visible")
    if "ease" in kw and str(kw["ease"]) not in EASES:
        raise _unknown(f"{where}.ease", "ease", kw["ease"], EASES, "one of: " + ", ".join(EASES), plugins=False)
    if "expr" in kw and str(kw["expr"]) not in EXPRESSIONS:
        raise _unknown(f"{where}.expr", "expr", kw["expr"], EXPRESSIONS, "one of: " + ", ".join(EXPRESSIONS), plugins=False)
    if "look" in kw and str(kw["look"]) not in LOOKS:
        raise _unknown(f"{where}.look", "look", kw["look"], LOOKS, "one of: " + ", ".join(LOOKS), plugins=False)
    if "pose" in kw and str(kw["pose"]) not in registry.POSES:
        raise _unknown(f"{where}.pose", "pose", kw["pose"], registry.POSES, "studio-stickman list poses")
    if "fx" in kw:
        _fx_list(kw["fx"], where)


class Figure:
    def __init__(self, name: str, spec: dict, scene: "Scene", index: int):
        where = f"figures.{name}"
        v = scene._v                      # a bad value is reported and the default used, so loading goes on
        self.name = name
        self.scene = scene
        self.color = v((24, 24, 28), _col, spec["color"], f"{where}.color") if spec.get("color") is not None else (24, 24, 28)
        self.outline = v(None, _col, spec["outline"], f"{where}.outline") if spec.get("outline") else None
        self.auto_color = spec.get("color") is None      # the renderer picks dark or light against the scenery
        self.scale = v(1.0, _num, spec.get("scale", 1.0), f"{where}.scale", 0.2, 4)
        self.build: dict = {}
        build = spec.get("build") or {}
        if not isinstance(build, dict):
            scene._fail(SceneError(f"expected a mapping like {{ head: 24 }}, got {_show(build)}", where=f"{where}.build", code="bad-value", got=build))
            build = {}
        for k, val in build.items():
            if k not in DIMS:
                close = _close(k, DIMS)
                scene._warn(f"{where}.build.{k}", f'unknown body part "{k}"{_dym(close)} — ignored (parts: {", ".join(DIMS)})', "unknown-key")
                continue
            # far outside these the figure falls apart (negative or zero lengths draw garbage)
            x = v(None, _num, val, f"{where}.build.{k}", round(DIMS[k] * 0.3, 1), round(DIMS[k] * 3, 1))
            if x is not None:
                self.build[k] = x
        self.line = v(float(scene.style["line"]), _num, spec.get("line", scene.style["line"]), f"{where}.line", 0.5, 80)
        self.z = v(float(index), _num, spec.get("z", index), f"{where}.z")
        self.label = None if spec.get("label") is None else str(spec["label"])
        self.extras = self._extras(spec, where)
        self.phase = (index * 1.7) % 6.28
        self.raw: list[dict] = []
        self.keys: list[Key] = []
        self.times: list[float] = []
        self.user_times: list[float] = []     # keyframes the scene file gives a fixed time
        self.plans: list[dict] = []           # actions the scene file gives a fixed time (known before they run)
        self.spans: list[dict] = []           # this figure's own actions as resolved so far: t0, t1, do, where
        self.talk_spans: list[tuple] = []     # while it speaks (say) without a move of its own
        self._talk_t0: list[float] = []
        # talk: false — no automatic gestures while its say bubbles are up
        self.talk = v(True, _bool, spec["talk"], f"{where}.talk") if spec.get("talk") is not None else True
        self.held: list = []                  # (hand, from, to) of the props it holds (the talk gestures leave that arm alone)
        self.user_keys: list[tuple] = []      # (t, where) of the keyframes in user_times
        # knocked out (ko: true): from the impact until it lies on the floor — its own moves wait
        self.knocked: list[dict] = []
        x = v(scene.w / 2, _num, spec.get("x", scene.w / 2), f"{where}.x")
        face = v(1, _face, spec.get("face", "right"), f"{where}.face")
        first = {"t": 0.0, "pose": spec.get("pose", "stand"), "x": x, "face": face, "_in": 0.0, "_where": where, "_spec": True}
        if spec.get("y") is not None:
            first["y"] = v(0.0, _num, spec["y"], f"{where}.y")
        if spec.get("expr"):
            first["expr"] = spec["expr"]
        if spec.get("fx"):
            first["fx"] = spec["fx"]
        if spec.get("visible") is not None and v(True, _bool, spec["visible"], f"{where}.visible") is False:
            first["visible"] = False
        self.raw.append(first)
        self._where = [where]

    def _extras(self, spec: dict, where: str) -> dict:
        out = {}
        for k in EXTRAS:
            val = _bool_word(spec.get(k))
            if val in (None, False):
                continue
            w = f"{where}.{k}"
            try:
                if k == "hat":
                    val = self._hat(val, w)
                elif k in COLOR_EXTRAS and val is not True:
                    if isinstance(val, (int, float)):
                        raise SceneError(f"expected true or a color, got {val}", where=w, code="bad-color", got=val)
                    _col(val, w)
            except SceneError as e:
                self.scene._fail(e)
                continue
            out[k] = val
        return out

    def _hat(self, val, where: str):
        try:
            from .draw import HATS
        except Exception:  # noqa: BLE001  (drawing is optional for checking)
            HATS = _HATS
        if val is True:
            return val
        if isinstance(val, dict):
            bad = [k for k in val if k not in ("kind", "color")]
            if bad:
                close = _close(bad[0], ["kind", "color"])
                raise SceneError(f'a hat has no option "{bad[0]}"{_dym(close)} (options: kind, color)', where=where, code="unknown-option", got=bad[0], suggest=close)
            kind = str(val.get("kind", "cap"))
            if val.get("color") is not None:
                _col(val["color"], f"{where}.color")
        else:
            kind = str(val)
        if kind not in HATS:
            raise _unknown(where, "hat", kind, HATS, "hats: " + ", ".join(HATS), plugins=False)
        return val

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

    def x_at(self, t: float) -> float:
        """Where the figure is at time t according to the keys added so far — in between two keys
        too (a figure that is walking is somewhere on the way, not still at its start)."""
        blend = self.scene.blend
        x = None
        prev_t = None
        for k in sorted(self.raw, key=lambda k: k["t"]):
            kx = float(k["x"]) if "x" in k else x
            if prev_t is not None and t < k["t"]:
                if kx is None or x is None or kx == x:
                    return x if x is not None else self.scene.w / 2
                gap = k["t"] - prev_t
                d = k.get("_in", blend)
                d = gap if d is None else max(0.0, min(float(d), gap))
                t0 = k["t"] - d
                if t <= t0 or d <= 1e-9:
                    return x
                return lerp(x, kx, ease(str(k.get("ease", "io")), (t - t0) / d))
            x, prev_t = kx, k["t"]
        return x if x is not None else self.scene.w / 2

    def ground_at(self, t: float) -> float:
        """What the figure stands on at time t: its height above the floor that keys of actions are
        measured from (set by the figure's `y`, a keyframe's `y`, or an action key's `ground`)."""
        base = 0.0
        for k in sorted(self.raw, key=lambda k: k["t"]):
            if k["t"] > t + 1e-9:
                break
            if "ground" in k:
                base = float(k["ground"])
            elif "y" in k and "_do" not in k:
                base = float(k["y"])
        return base

    def knocked_at(self, t: float) -> dict | None:
        """The knock-out (ko: true) this figure is falling from at time t: after the impact, before it lies."""
        for kn in self.knocked:
            if kn["t0"] + 1e-6 < t < kn["t1"] - 1e-6:
                return kn
        return None

    def cut_move(self, where: str, t: float) -> int:
        """Stop the move written at `where` (timeline.b[0]) at time t: its keys after t are dropped and the
        figure stays where the move had taken it by then (a knock-out interrupts a walk or a wave).
        Returns how many keys were dropped."""
        late = [k for k in self.raw if k.get("_where") == where and k["t"] > t + 1e-6 and not k.get("_react")]
        if not late:
            return 0
        x = self.x_at(t)
        self.raw[:] = [k for k in self.raw if not any(k is d for d in late)]
        self.raw.append({"t": t, "x": round(float(x), 2), "_in": None, "ease": "lin", "_do": late[0].get("_do", ""),
                         "_by": self.name, "_where": where})
        for s in self.spans:
            if s["where"] == where:
                s["t1"] = min(s["t1"], t)
                s["keys"] = [kt for kt in s["keys"] if kt <= t + 1e-6]
        return len(late)

    def end_reaction(self, t: float, index: int | None = None) -> dict | None:
        """A move of its own starts at t: the automatic hit reaction still running then is cut short, and
        the figure is back in its stance by t (the move starts from there instead of mixing with the
        recoil). The settle key goes in before raw[index:] (the new move's keys, already added).
        Returns {"hit": where, "t_peak": …, "kept": bool} of the reaction it cut, or None."""
        raw = self.raw if index is None else self.raw[:index]
        late = [k for k in raw if k.get("_react") and not k.get("_ko") and k["t"] > t - 0.02]
        if not late:
            return None
        last = max(late, key=lambda k: k["t"])
        group = last.get("_react")
        early = [k["t"] for k in raw if k.get("_react") == group and not k.get("_ko") and k["t"] <= t - 0.02]
        keep = [k for k in raw if not any(k is d for d in late)]
        settle = None
        if early and "pose" in last:
            # back in the stance by t (shortly before, when there is room; never in less than ~0.1 s)
            ts = min(t, max(max(early) + 0.1, t - 0.08))
            if ts > max(early) + 1e-6:
                settle = {**last, "t": ts, "_in": ts - max(early)}
        self.raw[:] = keep + ([settle] if settle else []) + (self.raw[index:] if index is not None else [])
        return {"hit": last.get("_where"), "peak": min(early) if early else None, "kept": bool(early)}

    def held_arms(self, t: float) -> tuple:
        """Arm angles of the hands that hold a prop at time t (the talk gestures leave them alone)."""
        out: tuple = ()
        for hand, t0, t1 in self.held:
            if t0 <= t < t1:
                out += (hand + "S", hand + "E")
        return out

    def resolve(self) -> None:
        self._resolve(None)

    def _resolve(self, collect=None) -> None:
        raw = sorted(self.raw, key=lambda k: k["t"])  # stable: later items win at the same time
        blend = self.scene.blend
        keys: list[Key] = []
        prev: Key | None = None
        base = 0.0
        for k in raw:
            where = k.get("_where", f"figures.{self.name}")
            try:
                key, base = self._key(k, prev, base, where)
            except SceneError as e:
                if collect is None:
                    raise
                if not e.where:
                    e.where = where
                collect(e)
                continue
            # "be in this pose at t": hold the previous pose until shortly before (the transition time)
            if prev is not None:
                gap = key.t - prev.t
                d = k.get("_in", blend)
                try:
                    d = gap if d is None else max(0.0, min(float(d), gap))
                except (TypeError, ValueError):
                    d = min(blend, gap)
                if gap - d > 1e-6:
                    keys.append(Key(t=key.t - d, ang=prev.ang, x=prev.x, y=prev.y, rot=prev.rot, face=prev.face, ease="lin", expr=prev.expr, look=prev.look,
                                    fx=prev.fx, arc=0.0, visible=prev.visible, where=prev.where, nfx=prev.nfx))
            keys.append(key)
            prev = key
        if not keys:              # every key was broken (reported): stand still so the rest still works
            keys = [Key(0.0, dict(STAND), self.scene.w / 2, 0.0, 0.0, 1, "io", "calm", "fwd", [], 0.0, True, where=f"figures.{self.name}")]
        for a, b in zip(keys, keys[1:]):
            if b.t < a.t - 1e-9:     # a safety net: playback looks keys up by time
                raise SceneError(f"keyframes out of order at {b.t:.2f}s (internal: a negative transition time?)", where=b.where, code="internal")
            b.dang = {n: (_turn(a.ang[n], b.ang[n]) if n in WRAP else b.ang[n] - a.ang[n]) for n in ANGLES}
            # the key's angles continue from the key before (cheer 160 -> down -168 is stored as 192), so an
            # angle never jumps by 360 between two frames — the same pose, but smooth numbers for the fx
            b.ang = {n: a.ang[n] + b.dang[n] for n in ANGLES}
        self.keys = keys
        self.times = [k.t for k in keys]
        self._gait_runs()

    def _key(self, k: dict, prev: Key | None, base: float, where: str) -> tuple:
        """One raw key -> a Key (everything a raw key does not say comes from the key before)."""
        ang = dict(prev.ang) if prev else dict(STAND)
        rot = prev.rot if prev else 0.0
        fx = prev.fx if prev else []
        if "pose" in k:
            e = registry.POSES.get(str(k["pose"]))
            if not e:
                raise _unknown(where, "pose", k["pose"], registry.POSES, "studio-stickman list poses")
            ang = {a: float(e.data.get(a, STAND[a])) for a in ANGLES}
            rot = float(e.data.get("rot", 0.0))
            fx = []
        for a in ANGLES:
            if a in k:
                ang[a] = _num(k[a], where, what=f"an angle in degrees for {a}")
        if "rot" in k:
            rot = _num(k["rot"], where, what="a rotation in degrees")
        if "fx" in k:
            fx = _fx_list(k["fx"], where)
        ez = str(k.get("ease", "io"))
        if ez not in EASES:
            raise _unknown(where, "ease", ez, EASES, "one of: " + ", ".join(EASES), plugins=False)
        expr = str(k.get("expr", prev.expr if prev else "calm"))
        if expr not in EXPRESSIONS:
            raise _unknown(where, "expr", expr, EXPRESSIONS, "one of: " + ", ".join(EXPRESSIONS), plugins=False)
        look = str(k.get("look", prev.look if prev else "fwd"))
        if look not in LOOKS:
            raise _unknown(where, "look", look, LOOKS, "one of: " + ", ".join(LOOKS), plugins=False)
        # Height: what the figure stands on (its `y`, or a keyframe's `y`) stays until a key changes it,
        # like x does — a figure on a ledge stays up there when it waves. Keys written by actions measure
        # their `y` (a jump, a fall) from that height, so the same jump works on the floor and on a table.
        if "ground" in k:
            base = _num(k["ground"], where, what="a height")
        if "_do" in k:
            y = base + (_num(k["y"], where, what="a height") if "y" in k else 0.0)
        else:
            if "y" in k:
                base = _num(k["y"], where, what="a height")
            y = base
        rot_now = rot
        key = Key(
            t=k["t"], ang=ang, x=_num(k["x"], where, what="an x position") if "x" in k else (prev.x if prev else 0.0), y=y, rot=rot_now,
            face=_face(k["face"], where) if "face" in k else (prev.face if prev else 1), ease=ez, expr=expr, look=look, fx=fx,
            arc=_num(k.get("arc", 0.0), where, what="an arc height"),
            visible=_bool(k["visible"], where) if "visible" in k else (prev.visible if prev else True), where=where,
        )
        key.nfx = [x for x in fx if x[0] not in GAIT_FX] if fx else ([("idle", registry.MOTIONS["idle"].params)] if rot_now == 0 and "idle" in registry.MOTIONS else [])
        return key, base

    def _gait_runs(self) -> None:
        """Group the segments between keys that walk (run, sneak) in one direction into stretches;
        each key whose segment belongs to one gets the stretch's x range for footstep planning."""
        ks = self.keys
        i = 0
        while i < len(ks) - 1:
            g = _gait(ks[i].fx)
            if not g:
                i += 1
                continue
            j, dirn = i, 0
            while j < len(ks) - 1:
                gj = _gait(ks[j].fx)
                if not gj or gj[0] != g[0]:
                    break
                d = ks[j + 1].x - ks[j].x
                sd = (d > 1e-6) - (d < -1e-6)
                if sd and dirn and sd != dirn:
                    break                              # turned round: a new stretch starts here
                dirn = dirn or sd
                j += 1
            for k in ks[i:j]:
                k.run = (ks[i].x, ks[j].x)
            i = max(j, i + 1)

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
        if a is b:
            st = dict(a.ang)
        else:
            aa, d = a.ang, b.dang
            st = {n: aa[n] + d[n] * u for n in ANGLES}
        st["x"] = lerp(a.x, b.x, u)
        st["y"] = lerp(a.y, b.y, u) + (b.arc * 4 * u * (1 - u) if a is not b else 0.0)
        st["rot"] = lerp(a.rot, b.rot, u)
        st["face"] = a.face
        st["expr"] = b.expr if u > 0.5 else a.expr
        st["look"] = a.look
        st["visible"] = a.visible
        ctx = {"beat": self.scene.clock.beat, "phase": self.phase, "fps": self.scene.fps, "figure": self.name}
        cur = a if (a is b or u < 1.0) else b
        gait = self._gait_ctx(a, b, u, [x for x in cur.fx if x[0] in GAIT_FX], ctx)
        # Every other fx fades out over the transition to a key that does not have it and fades in over
        # the transition to a key that has it (the transition is the key's `in`), so a wave, a shiver or
        # the breathing never switch on or off in a single frame.
        if a is b or u >= 1.0:
            layers = [(n, p, 1.0) for n, p in cur.nfx]
        else:
            layers = [(n, p, 1.0 if (n, p) in b.nfx else 1.0 - u) for n, p in a.nfx]
            layers += [(n, p, u) for n, p in b.nfx if (n, p) not in a.nfx]
        names = []
        for n, p in gait:
            self._fx(n, p, 1.0, st, t, ctx)          # walk/run/sneak blend themselves (ctx gait_w)
            names.append(n)
        own = 1.0 if gait else 0.0
        for n, p, w in layers:
            if w > 1e-4:
                self._fx(n, p, w, st, t, ctx)
                names.append(n)
                if n != "idle":
                    own = max(own, w)
        # a figure that speaks (say) and does nothing else gestures while its bubble is up
        if self.talk_spans and own < 1.0 and st["rot"] == 0 and "talk" in registry.MOTIONS:
            w = self._speaking(t) * (1.0 - own)
            if w > 1e-3:
                keep = {n: st[n] for n in self.held_arms(t)} if self.held else None
                self._fx("talk", registry.MOTIONS["talk"].params, w, st, t, ctx)
                if keep:
                    st.update(keep)                    # the hand holding a mug keeps it where it is
                names.append("talk")
        st["fx"] = names
        return st

    def _fx(self, name: str, params: dict, w: float, st: dict, t: float, ctx: dict) -> None:
        """Run one fx on the state at weight w (0..1): the fx changes a copy, the change is scaled."""
        e = registry.MOTIONS.get(name)
        if e is None:
            return
        try:
            if w >= 0.999:
                e.fn(st, t, params, ctx)
                return
            before = dict(st)
            e.fn(st, t, params, ctx)
            for k, val in st.items():
                b0 = before.get(k)
                if b0 is None or val is b0 or val == b0:
                    continue
                if isinstance(val, (int, float)) and isinstance(b0, (int, float)) and not isinstance(val, bool):
                    st[k] = b0 + (val - b0) * w
                elif w < 0.5:
                    st[k] = b0
        except SceneError:
            raise
        except Exception as ex:  # noqa: BLE001  (a plugin fx with a bug: say which one, where and when)
            raise SceneError(f'fx "{name}" ({e.source}) failed at {t:.2f}s: {type(ex).__name__}: {ex}', where=f"figures.{self.name}",
                             code="fx-failed") from None

    def _speaking(self, t: float) -> float:
        """0..1: how much the figure is speaking at t (fades in and out at the ends of its bubbles)."""
        i = bisect.bisect_right(self._talk_t0, t) - 1
        if i < 0:
            return 0.0
        t0, t1 = self.talk_spans[i]
        if t >= t1:
            return 0.0
        fade = min(0.25, (t1 - t0) / 3)
        return max(0.0, min(1.0, (t - t0) / fade, (t1 - t) / fade))

    def _gait_ctx(self, a: Key, b: Key, u: float, fxs: list, ctx: dict) -> list:
        """Footstep planning data for walk/run/sneak; blends the gait in and out at its ends."""
        dims = {**DIMS, **self.build}
        ctx["thigh"], ctx["shin"] = dims["thigh"] * self.scale, dims["shin"] * self.scale
        ctx["run"], ctx["gait_w"] = a.run, 1.0
        if a is not b and u < 1.0:
            ga, gb = _gait(a.fx), _gait(b.fx)
            if ga and not gb:
                ctx["gait_w"] = 1.0 - u                 # the stretch ends: legs go over into the next pose
            elif gb and not ga:
                ctx["run"], ctx["gait_w"] = b.run, u    # it starts: legs go over into the first step
                fxs = list(fxs) + [gb]
        return fxs

    def joints(self, t: float) -> tuple[dict, dict]:
        st = self.state(t)
        return st, fk(st, self.scene.floor, self.scale, self.build)


class ActionCtx:
    """What an action function gets: where and when it starts, and how to add keyframes / events."""

    def __init__(self, scene: "Scene", fig: Figure, t: float, params: dict, where: str, explicit: bool = False, action: str | None = None):
        self.scene = scene
        # the scene gave this action a fixed time (strikes then LAND at t instead of starting at t)
        self.explicit = explicit
        self.figure = fig
        self.name = fig.name
        self.action = action or ""
        self.t = t
        self.p = params
        self.where = where
        self.dur: float | None = None
        self._last = 0.0
        self._first: float | None = None      # the earliest own key (dt); strikes wind up before t
        self._times: list[float] = []         # when its own keys are (for the overlap check)
        self.x = float(fig.x_at(t))
        self.face = _face(fig.last("face", t, 1), where)
        self.floor = scene.floor
        self.beat = scene.clock.beat or 0.5
        self.scale = fig.scale

    @property
    def ground(self) -> float:
        """The height the figure stands on when the action starts (its keys' `y` count from there)."""
        return self.figure.ground_at(self.t)

    def key(self, dt: float, pose=None, **kw) -> None:
        """A keyframe of this figure, dt seconds after the action starts. kw: x, y (above what the figure
        stands on), rot, face, ease, expr, look, fx, arc, in (transition seconds), ground (a new height
        to stand on, px above the floor), angle overrides (RS=120 …)."""
        self._key(self.figure, dt, pose, kw)

    def key_for(self, name: str, dt: float, pose=None, **kw) -> None:
        """A keyframe of another figure (reactions)."""
        self._key(self.other(name), dt, pose, kw)

    def _key(self, fig: Figure, dt: float, pose, kw: dict) -> None:
        if "in_" in kw:
            kw["in"] = kw.pop("in_")
        if "in" in kw:
            kw["_in"] = kw.pop("in")
        bad = [k for k in kw if k not in KEY_FIELDS and k not in ANGLES and k not in ("_in", "ground")]
        if bad:
            raise SceneError(f'action key has an unknown field "{bad[0]}"', where=self.where, code="bad-action-key", got=bad[0])
        dt = _num(dt, self.where, what="a time offset")
        for k in ("x", "y", "rot", "arc", "ground", *ANGLES):
            if k in kw:
                kw[k] = _num(kw[k], self.where, what=f"a number for {k}")
        if self.t + dt > MAX_SECONDS:
            raise SceneError(f"the action writes a keyframe at {self.t + dt:.0f}s — a scene ends after 30 minutes "
                             "(is a count like times or beats far too large?)", where=self.where, code="too-long")
        sc = self.scene
        sc._keys_left -= 1
        if sc._keys_left < 0:
            raise SceneError(f"more than {MAX_KEYS} keyframes — is a count like times or beats far too large?", where=self.where, code="too-many-keys")
        kw["_do"] = self.action
        kw["_by"] = self.name
        fig.add(self.t + dt, pose, kw, self.where)
        if fig is self.figure:
            self._last = max(self._last, dt)
            self._first = dt if self._first is None else min(self._first, dt)
            self._times.append(self.t + dt)

    def event(self, dt: float, **ev) -> None:
        """A timed event: sfx="punch", text="POW", hit=[x, y], shake=8, flash=True, burst="dust" …"""
        # a wind-up that starts before 0 may put its whoosh before the start: it is simply not heard
        try:
            self.scene.add_event({"t": max(0.0, self.t + dt), **ev}, self.where)
        except SceneError as e:
            w = str(e.where or "")
            if not w.startswith(self.where + ".") or w in self.scene.lines:
                raise
            # an option the action made itself (a camera shake from `power` …), not one written in the file
            opt = w[len(self.where) + 1:]
            raise SceneError(f'the {opt} of the event that {self.action or "this action"} makes is out of range ({e.message}) — '
                             f'check the parameters of the {self.action or "action"}', where=self.where, code=e.code, got=e.got) from None

    def other(self, name: str) -> Figure:
        f = self.scene.figures.get(str(name))
        if not f:
            raise _unknown(self.where, "figure", name, self.scene.figures, plugins=False)
        return f

    def x_of(self, name: str, dt: float = 0.0) -> float:
        """Where figure `name` is dt seconds after this action starts (also while it moves)."""
        return float(self.other(name).x_at(self.t + dt))

    def doing(self, name: str, dt: float = 0.0) -> str | None:
        """The `do:` action figure `name` is busy with dt seconds after this action starts (None: none).
        Actions are expanded in start-time order across all figures, so the moves of the other figures
        that start earlier are known; a later one written with a fixed time counts from its start."""
        f = self.other(name)
        t = self.t + dt
        best = None
        for s in f.spans:
            if s["t0"] - 1e-6 <= t <= s["t1"] + 1e-6 and (best is None or s["t0"] >= best["t0"]):
                best = s
        if best:
            return best["do"]
        for p in f.plans:
            if not p["done"] and p["t"] - 1e-6 <= t <= p["t"] + p["guess"]:
                return p["do"]
        return None

    def warn(self, msg: str) -> None:
        self.scene._warn(self.where, msg, "action")

    def free(self, name: str, t0: float, t1: float) -> bool:
        """True when `name` does nothing of its own between t0 and t1 (seconds after the action starts):
        no keyframe the scene file gives it and no move of its own (a block, a dodge, a walk) — then an
        automatic reaction does not fight the choreography."""
        f = self.other(name)
        lo, hi = self.t + t0 - 1e-6, self.t + t1 + 1e-6
        if any(lo <= t <= hi for t in f.user_times):
            return False
        if f is not self.figure and any(s["t0"] <= hi and s["t1"] >= lo for s in f.spans):
            return False
        return not any(not p["done"] and lo <= p["t"] <= hi for p in f.plans)

    def point(self, name: str, part: str = "chest", dt: float = 0.0) -> tuple[float, float]:
        """World position of a body part of a figure (head, chest, hip, hand, foot) as posed so far."""
        f = self.other(name)
        x = float(f.x_at(self.t + dt))
        s = f.scale
        h = {"head": 190, "chest": 135, "hip": 100, "hand": 120, "knee": 55, "foot": 10}.get(part, 135) * s
        # on a table / ledge the body is that much higher (ground: px above the floor, not scaled)
        return (x, self.floor - h - f.ground_at(self.t + dt))

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
TEXT_KINDS = ("text", "say", "caption", "title")
HIT_PARTS = ["head", "chest", "hip", "hand", "foot", "knee", "neck"]
# option -> (lowest, highest) for the numbers events take
EVENT_NUMBERS = {"x": (None, None), "y": (None, None), "rot": (None, None), "speed": (0, 20000), "spread": (0, 50), "life": (0.01, 60),
                 "gravity": (None, None), "gain": (0, 16), "pan": (-1, 1), "alpha": (0, 1), "shade": (0, 1), "zoom": (0, 3), "shake": (0, 300)}
_FONTS = ["bold", "regular", "italic", "mono"]
SCENE_KEYS = ["title", "size", "fps", "background", "bpm", "time", "audio", "audio_gain", "audio_offset", "sfx_gain", "floor", "world",
              "blend", "duration", "style", "seed", "footsteps"]
TOP_KEYS = ["scene", "figures", "props", "timeline", "camera", "events", "use"]
# smear: fast limbs leave a short motion trail (render.py)
STYLE_DEFAULTS = {"line": 9.0, "outline": True, "shadow": True, "vignette": 0.25, "grain": 0.0, "faces": True, "highlight": True, "smear": True}
STYLE_NUMBERS = {"line": (0.5, 80), "vignette": (0, 1), "grain": (0, 1)}
STANDABLE = ("platform", "table", "desk", "crate", "chair", "rock", "rect")    # props a figure may stand on (the airborne check)
CAMERA_FIELDS = ["t", "x", "y", "zoom", "ease", "follow", "dx", "dy", "cut"]


def _event_len(ev: dict) -> float:
    """How long an event stays on screen (bubbles and captions: by the length of their text)."""
    if ev.get("dur"):
        return float(ev["dur"])
    if ev["kind"] == "say":
        return 0.9 + 0.055 * len(str(ev["value"]))
    if ev["kind"] == "caption":
        return 1.0 + 0.06 * len(str(ev["value"]))
    return 0.5


def _posed_spans(f: "Figure") -> list[tuple]:
    """When a figure holds a pose of its own: from a key with a pose other than TALK_POSES, or with arm
    angles written in the file (a hand raised to hold a mug), or arm angles alone (a hit reaction),
    until the next key that sets a pose to talk in."""
    out: list = []
    start = None
    for k in sorted(f.raw, key=lambda k: k["t"]):
        if "pose" in k:
            held = str(k["pose"]) not in TALK_POSES or ("_do" not in k and any(a in k for a in ARM_ANGLES))
        elif any(a in k for a in ARM_ANGLES):
            held = True
        else:
            continue
        if held and start is None:
            start = k["t"]
        elif not held and start is not None:
            out.append((start, k["t"]))
            start = None
    if start is not None:
        out.append((start, MAX_SECONDS + 1.0))
    return out


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------
class Scene:
    def __init__(self, data: dict, path: Path, lines: dict | None = None):
        self.path = Path(path)
        self.lines: dict = lines or {}      # YAML path -> (line, column)
        self.warnings: list[str] = []
        self._wmeta: dict[str, dict] = {}
        self.errors: list[SceneError] = []
        self._seen: set[str] = set()
        self._keys_left = MAX_KEYS
        for k in data:
            ks = str(k)
            if ks in TOP_KEYS or ks.startswith(("_", ".", "x-")):     # _name / x-name: room for YAML anchors
                continue
            close = _close(ks, TOP_KEYS)
            self._warn(ks, f"ignored — unknown top-level key{_dym(close)} (known: {' '.join(TOP_KEYS)}; "
                           "keys starting with _ are ignored silently, e.g. for YAML anchors)", "unknown-key")
        registry.load_builtins()
        use = data.get("use") or []
        if isinstance(use, str):
            use = [use]
        if not isinstance(use, list):
            self._fail(SceneError(f"expected a list of pack ids, got {_show(use)}", where="use", code="bad-value", got=use))
            use = []
        for i, pack_id in enumerate(use):
            try:
                registry.load_pack(str(pack_id))
            except ImportError as e:
                self._fail(SceneError(str(e), where=f"use[{i}]", code="pack-failed", got=str(pack_id)))
        registry.load_project_plugins()
        for err in registry.PLUGIN_ERRORS:
            self._warn(err["file"], f'plugin failed to load: {err["error"]}', "plugin-error")

        self._settings(data.get("scene"))

        # figures
        figs = data.get("figures")
        self.figures: dict[str, Figure] = {}
        if not isinstance(figs, dict) or not figs:
            got = "" if figs is None else f", got {'a list' if isinstance(figs, list) else _show(figs)}"
            self._fail(SceneError(f"define at least one figure as a mapping, e.g.  figures: {{ hero: {{ color: black, x: 400 }} }}{got}",
                                  where="figures", code="no-figures"))
            figs = {}
        for i, (name, spec) in enumerate(figs.items()):
            where = f"figures.{name}"
            if not isinstance(spec, dict):
                spec = {} if spec is None else {"color": spec}
            for k in spec:
                if k not in FIGURE_KEYS:
                    close = _close(k, FIGURE_KEYS)
                    self._warn(f"{where}.{k}", f'unknown option "{k}"{_dym(close)} — ignored', "unknown-key")
            with self._guard(where):
                self.figures[str(name)] = Figure(str(name), spec, self, i)

        self.events: list[dict] = []
        self.script: list[dict] = []          # the timeline as written: who does what from when to when (for `info`)
        with self._guard("timeline"):
            self._timeline(data.get("timeline"))
        evs = data.get("events")
        if evs is None:
            evs = []
        if not isinstance(evs, list):
            self._fail(SceneError("must be a list of events like  - { t: 2, text: \"Hi\" }", where="events", code="bad-value"))
            evs = []
        for i, ev in enumerate(evs):
            where = f"events[{i}]"
            with self._guard(where):
                if not isinstance(ev, dict):
                    raise SceneError('must be a mapping like {t: 2, text: "Hi"}', where=where, code="bad-value", got=ev)
                ev = dict(ev)
                ev["t"] = self.clock.at(ev.get("t", 0), 0.0, f"{where}.t")
                if ev["t"] < 0:
                    raise SceneError(f"time is negative ({ev['t']:g}s) — the scene starts at 0", where=f"{where}.t", code="negative-time", got=ev["t"])
                self.add_event(ev, where)
        self._talk_spans()
        for f in self.figures.values():
            with self._guard(f"figures.{f.name}"):
                f._resolve(self._fail)
        self._check_fx()
        self.props = self._props(data.get("props"))
        for p in self.props:
            if p.held_by in self.figures:
                self.figures[p.held_by].held.append((p.hand, p.t_from, p.t_to))
        self.camera = self._camera(data.get("camera"))
        self._raise()
        self.events.sort(key=lambda e: e["t"])

        last = max([f.keys[-1].t for f in self.figures.values()] + [e["t"] + _event_len(e) for e in self.events] + [k.t for k in self.camera] + [0.0])
        if self._duration is not None:
            self.duration = self._duration
            if self.duration < last - 0.5:
                self._warn("scene.duration", f"is {self.duration:g}s but things still happen at {last:.2f}s — they are cut off", "cut-off")
        else:
            self.duration = round(last + 1.0, 3)
        if not 0.1 <= self.duration <= MAX_SECONDS:
            self._fail(SceneError(f"the scene must be between 0.1 seconds and 30 minutes long (it is {self.duration:g}s)",
                                  where="scene.duration" if self._duration is not None else None, code="out-of-range"))
            self._raise()
        self._lint()

    # -- problems -------------------------------------------------------------------
    _WHERE = re.compile(r"^((?:scene|figures|timeline|events|props|camera|use)\b[^\s:]*): (.*)$", re.S)

    def line_of(self, where: str | None) -> int | None:
        """The line of the scene file a YAML path (timeline.red[2].dur) is written on."""
        lc = self._line_col(where)
        return lc[0] if lc else None

    def _line_col(self, where: str | None) -> tuple | None:
        if not where or not self.lines:
            return None
        p = str(where)
        while p:
            if p in self.lines:
                return self.lines[p]
            # not written itself (a default): the line of what contains it
            m = re.match(r"^(.+?)(?:\.[^.\[\]]+|\[\d+\])$", p)
            if not m:
                break
            p = m.group(1)
        return None

    def _locate(self, e: SceneError) -> None:
        if e.where is None:
            # an older style message from a plugin: "timeline.red[2]: …" — take the place from its text
            m = self._WHERE.match(e.message)
            if m:
                e.where, e.message = m.group(1), m.group(2)
        if e.where and e.line is None:
            lc = self._line_col(e.where)
            if lc:
                e.line, e.col = lc

    def _fail(self, e: SceneError) -> None:
        """Note a problem and go on, so that one check reports every independent problem."""
        if isinstance(e, SceneErrors):
            for x in e.errors:
                self._fail(x)
            return
        self._locate(e)
        key = str(e)
        if key not in self._seen:
            self._seen.add(key)
            self.errors.append(e)

    @contextmanager
    def _guard(self, where: str):
        try:
            yield
        except SceneError as e:
            self._fail(e)
        except Exception as e:  # noqa: BLE001  (a safety net: an unexpected problem still names its place)
            self._fail(SceneError(f"{type(e).__name__}: {e} (while loading the scene)", where=where, code="internal"))

    def _v(self, default, fn, *args, **kw):
        """fn(*args): a checked value — or, when it is bad, the problem is noted and default used."""
        try:
            return fn(*args, **kw)
        except SceneError as e:
            self._fail(e)
            return default

    def _raise(self) -> None:
        if not self.errors:
            return
        errs = sorted(self.errors, key=lambda e: e.line or 0)       # file order; problems without a line first
        if len(errs) > MAX_ERRORS:
            errs = errs[:MAX_ERRORS] + [SceneError(f"… and {len(errs) - MAX_ERRORS} more problems", code="more")]
        raise errs[0] if len(errs) == 1 else SceneErrors(errs)

    def _warn(self, where: str | None, msg: str, code: str | None = None) -> None:
        line = self.line_of(where)
        text = (f"{where}{f' (line {line})' if line else ''}: {msg}") if where else msg
        if text in self._wmeta:          # the same warning twice (a repeated move) is said once
            return
        self.warnings.append(text)
        self._wmeta[text] = {"where": where, "line": line, "code": code, "message": msg}

    @property
    def warning_items(self) -> list[dict]:
        """The warnings with their place: [{where, line, code, message}] in the order of `warnings`."""
        out = []
        for w in self.warnings:
            meta = self._wmeta.get(w)
            if meta is None:          # appended directly (an older plugin): take the place from the text
                m = re.match(r"^([^\s:]+)(?: \(line (\d+)\))?: (.*)$", w, re.S)
                meta = {"where": m.group(1), "line": int(m.group(2)) if m.group(2) else self.line_of(m.group(1)), "code": None, "message": m.group(3)} if m \
                    else {"where": None, "line": None, "code": None, "message": w}
            out.append(dict(meta))
        return out

    # -- scene settings ---------------------------------------------------------------
    def _settings(self, s) -> None:
        if s is None:
            s = {}
        if not isinstance(s, dict):
            self._fail(SceneError("must be a mapping (title, size, fps, bpm …)", where="scene", code="bad-value"))
            s = {}
        for k in s:
            if k not in SCENE_KEYS:
                close = _close(k, SCENE_KEYS)
                self._warn(f"scene.{k}", f'unknown option "{k}"{_dym(close)} — ignored (options: {", ".join(SCENE_KEYS)})', "unknown-key")
        v = self._v
        self.title = str(s.get("title") or self.path.name.split(".")[0])
        self.w, self.h = v((1280, 720), self._size, s.get("size", [1280, 720]))
        self.world_w, self.world_h = v((self.w, self.h), self._world, s.get("world", [self.w, self.h]))
        fps = v(30.0, _num, s.get("fps", 30), "scene.fps", 5, 60)
        if fps != int(fps):
            self._warn("scene.fps", f"{fps:g} is not a whole number — {round(fps)} is used", "rounded")
        self.fps = int(round(fps))
        bpm = s.get("bpm")
        if bpm is None and str(s.get("audio") or "").endswith((".song.yaml", ".song.yml")):
            # the soundtrack is a studio-daw song: its tempo is the tempo of the scene
            try:
                song = yaml.safe_load((registry.project_dir() / str(s["audio"])).read_text("utf-8")) or {}
                bpm = (song.get("song") or {}).get("bpm")
            except (OSError, yaml.YAMLError, AttributeError, TypeError, ValueError):
                bpm = None
        bpm = v(None, _num, bpm, "scene.bpm", 20, 400) if bpm is not None else None
        meter = s.get("time", "4/4")
        beats_per_bar = v(4.0, self._meter, meter)
        self.clock = Clock(bpm or None, beats_per_bar)
        self.floor = v(self.world_h - 80.0, _num, s.get("floor", self.world_h - 80), "scene.floor")
        if not 0 <= self.floor <= self.world_h:
            self._warn("scene.floor", f"{self.floor:g} is outside the picture (0–{self.world_h}): the figures stand where nobody sees them", "out-of-range")
        self.blend = v(0.22, self.clock.span, s.get("blend", 0.22), "scene.blend")
        self.seed = v(1, _int, s.get("seed", 1), "scene.seed")
        # automatic footstep sounds of walking, running and sneaking figures (sfx.py)
        self.footsteps = v(True, _bool, s.get("footsteps", True), "scene.footsteps")
        style = dict(STYLE_DEFAULTS)
        st_in = s.get("style") or {}
        if not isinstance(st_in, dict):
            self._fail(SceneError(f"expected a mapping like {{ vignette: 0, grain: 0.1 }}, got {_show(st_in)}", where="scene.style", code="bad-value", got=st_in))
            st_in = {}
        for k, val in st_in.items():
            w = f"scene.style.{k}"
            if k not in style:
                close = _close(k, style)
                self._fail(SceneError(f'unknown option "{k}"{_dym(close)} (options: {", ".join(style)})', where=w, code="unknown-option", got=k, suggest=close))
            elif isinstance(STYLE_DEFAULTS[k], bool):
                style[k] = v(STYLE_DEFAULTS[k], _bool, val, w)
            else:
                style[k] = v(STYLE_DEFAULTS[k], _num, val, w, *STYLE_NUMBERS[k])
        self.style = style
        self.audio = s.get("audio")
        if self.audio is not None and not isinstance(self.audio, str):
            self.audio = str(self.audio)
        self.audio_gain = v(0.0, _num, s.get("audio_gain", 0.0), "scene.audio_gain", -60, 24)       # dB
        # negative: the music starts that far into the song
        self.audio_offset = v(0.0, self.clock.span, s.get("audio_offset", 0), "scene.audio_offset", True)
        self.sfx_gain = v(0.0, _num, s.get("sfx_gain", 0.0), "scene.sfx_gain", -60, 24)             # dB
        self.background = v(("plain", dict(registry.BACKDROPS["plain"].params)) if "plain" in registry.BACKDROPS else ("plain", {}),
                            self._backdrop, s.get("background", "room"))
        self._duration = None
        if s.get("duration") is not None:
            d = v(None, self.clock.span, s["duration"], "scene.duration")
            if d is not None and d <= 0:
                self._fail(SceneError("must be more than 0 seconds", where="scene.duration", code="out-of-range", got=s["duration"]))
            elif d is not None:
                self._duration = d

    @staticmethod
    def _size(size) -> tuple[int, int]:
        w, h = _pair(size, "scene.size", "[1280, 720]")
        if w != int(w) or h != int(h) or not (64 <= w <= 3840 and 64 <= h <= 2160) or w % 2 or h % 2:
            raise SceneError(f"width and height must be even whole numbers between 64×64 and 3840×2160, got {w:g}×{h:g}", where="scene.size",
                             code="out-of-range", got=str(size))
        return int(w), int(h)

    def _world(self, world) -> tuple[int, int]:
        w, h = _pair(world, "scene.world", "[2560, 720]")
        if w < self.w or h < self.h:
            raise SceneError(f"must be at least as large as scene.size ({self.w}×{self.h}) — it is the scenery the camera moves over", where="scene.world",
                             code="out-of-range", got=str(world))
        # the scenery is painted once as one picture: keep it to what fits in memory (4 × a 4K frame)
        if w * h > 4 * 3840 * 2160 or max(w, h) > 20000:
            raise SceneError(f"{w:g}×{h:g} is too large (at most 4 × the area of 3840×2160, and 20000 px on a side)", where="scene.world",
                             code="out-of-range", got=str(world))
        return int(w), int(h)

    @staticmethod
    def _meter(meter) -> float:
        m = re.fullmatch(r"\s*([0-9]+)\s*/\s*([0-9]+)\s*", str(meter))
        if not m:
            raise SceneError(f'must look like "4/4" or "6/8", got {_show(meter)}', where="scene.time", code="bad-value", got=meter)
        num, den = int(m.group(1)), int(m.group(2))
        if not 1 <= num <= 32 or den not in (1, 2, 4, 8, 16):
            raise SceneError(f'"{meter}": the beats per bar must be 1–32 and the note value 1, 2, 4, 8 or 16', where="scene.time", code="bad-value", got=meter)
        return num * 4 / den

    def _backdrop(self, val) -> tuple:
        where = "scene.background"
        val = _bool_word(val)
        if val is None or val is False or val == "none":
            val = "plain"
        if isinstance(val, (list, tuple)):          # an RGB list is a color, as everywhere else
            val = {"use": "plain", "color": list(val)}
        if isinstance(val, (str, int, float)) and not isinstance(val, bool):
            spec = {"use": str(val)}
        elif isinstance(val, dict):
            spec = dict(val)
        else:
            raise SceneError(f"expected a backdrop name, a color or {{ use: name, … }}, got {_show(val)}", where=where, code="bad-value", got=val)
        name = str(spec.pop("use", "plain"))
        if name not in registry.BACKDROPS:
            try:
                col = color(name)
            except (TypeError, ValueError):
                raise _unknown(where, "backdrop", name, registry.BACKDROPS, "studio-stickman list backdrops; or a color") from None
            name, spec = "plain", {"color": list(col), **spec}
        e = registry.BACKDROPS[name]
        return (name, _check_params(e, spec, where, "backdrop"))

    # -- events ---------------------------------------------------------------------
    def add_event(self, ev: dict, where: str) -> None:
        kinds = [k for k in EVENT_KINDS if k in ev]
        if len(kinds) != 1:
            if "hit" in kinds and len(kinds) > 1:
                kinds = ["hit"]
            else:
                raise SceneError(f"an event needs exactly one of: {', '.join(EVENT_KINDS)} — got {', '.join(kinds) or 'none'}", where=where, code="bad-event")
        kind = kinds[0]
        t = _num(ev["t"], f"{where}.t", what="a time")
        out = {"kind": kind, "t": t, "value": ev[kind], "_where": where}
        defaults = EVENT_DEFAULTS[kind]
        extra = {}
        for k, val in ev.items():
            if k in ("t", kind, "_where"):
                continue
            if k in defaults:
                out[k] = val
            elif kind in ("sfx", "burst"):
                extra[k] = val                  # parameters of the sound / particle
            else:
                close = _close(k, defaults)
                raise SceneError(f'a "{kind}" event has no option "{k}"{_dym(close)} (options: {", ".join(defaults)})', where=where,
                                 code="unknown-option", got=k, suggest=close)
        for k, val in defaults.items():
            out.setdefault(k, val)
        self._event_value(out, kind, where)
        for k in list(out):
            if k not in ("kind", "t", "value", "_where") and out[k] is not None:
                out[k] = self._event_option(kind, k, out[k], f"{where}.{k}")
        if kind == "sfx":
            out.update(self._sound_params(str(out["value"]), extra, where))
        elif kind == "burst":
            e = registry.PARTICLES[str(out["value"])]
            for k, val in extra.items():
                if k not in e.params:
                    close = _close(k, [*e.params, *defaults])
                    self._warn(where, f'particle "{e.name}" has no option "{k}"{_dym(close)} — ignored (has: {", ".join([*defaults, *e.params])})', "unknown-option")
                    continue
                out[k] = _param(e.params[k], val, f"{where}.{k}")
        self.events.append(out)

    def _event_value(self, out: dict, kind: str, where: str) -> None:
        val = out["value"]
        w = f"{where}.{kind}"
        if kind in TEXT_KINDS:
            if val is None or val == "" or isinstance(val, (list, dict)):
                raise SceneError(f'needs words to show, e.g. {kind}: "Hello" — got {_show(val)}', where=w, code="missing-value", got=val)
            out["value"] = val if isinstance(val, str) else str(val)
        elif kind == "shake":
            out["value"] = _num(val, w, 0, 300)
        elif kind == "flash":
            val = _bool_word(val)
            if val is False or val is None:
                raise SceneError("flash: true (white) or a color — false shows nothing, leave the event out", where=w, code="bad-value", got=val)
            if val is not True:
                _col(val, w)
            out["value"] = val
        elif kind == "fade":
            if str(val) not in ("in", "out"):
                raise SceneError(f'fade must be "in" or "out", got {_show(val)}', where=w, code="bad-value", got=val)
        elif kind == "sfx":
            self._sound_name(val, w)
        elif kind == "burst":
            if str(val) not in registry.PARTICLES:
                raise _unknown(w, "particle", val, registry.PARTICLES, "studio-stickman list particles")
        elif kind == "hit":
            if isinstance(val, dict):
                val = dict(val)
                if True in val and "on" not in val:      # `on:` read as true by a YAML 1.1 reader
                    val["on"] = val.pop(True)
                bad = [k for k in val if k not in ("on", "part")]
                if bad:
                    close = _close(bad[0], ["on", "part"])
                    raise SceneError(f'hit has no option "{bad[0]}"{_dym(close)} (hit: {{ on: figure, part: head }})', where=w, code="unknown-option",
                                     got=bad[0], suggest=close)
                if str(val.get("on")) not in self.figures:
                    close = _close(val.get("on"), self.figures)
                    raise SceneError(f'hit.on must name a figure, got {_show(val.get("on"))}{_dym(close)} (figures: {", ".join(self.figures)})',
                                     where=f"{w}.on", code="unknown-figure", got=val.get("on"), suggest=close)
                val["on"] = str(val["on"])
                part = str(val.get("part", "chest"))
                if part not in HIT_PARTS:
                    raise _unknown(f"{w}.part", "part", part, HIT_PARTS, "one of: " + ", ".join(HIT_PARTS), plugins=False)
                out["value"] = val
            elif isinstance(val, (list, tuple)) and len(val) == 2:
                out["value"] = list(_pair(val, w))
            else:
                raise SceneError(f"hit must be [x, y] or {{ on: figure, part: head }}, got {_show(val)}", where=w, code="bad-value", got=val)

    def _event_option(self, kind: str, k: str, val, w: str):
        """One option of an event, checked against what the renderer will do with it."""
        if k == "dur":
            d = self.clock.span(val, w)
            if d <= 0:
                raise SceneError("must be more than 0 seconds", where=w, code="out-of-range", got=val)
            return d
        if k in ("color", "bubble"):
            _col(val, w)
            return val
        if k in ("ui", "pop", "outline", "sparks"):
            return _bool(val, w)
        if k == "flash":                       # hit: true or a color
            val = _bool_word(val)
            if not isinstance(val, bool):
                _col(val, w)
            return val
        if k == "size":
            # text sizes beyond a few hundred px make one letter bigger than the picture
            return _num(val, w, 0.5, 200) if kind == "burst" else _num(val, w, 4, 400)
        if k == "n":
            return int(round(_num(val, w, 1, 2000)))
        if k == "dir":
            return list(_pair(val, w, "[0, -1]"))
        if k == "font":
            try:
                from .draw import FONT_FILES
                fonts = list(FONT_FILES)
            except Exception:  # noqa: BLE001
                fonts = _FONTS
            if str(val) not in fonts and "/" not in str(val) and "\\" not in str(val):
                raise _unknown(w, "font", val, fonts, "fonts: " + ", ".join(fonts), plugins=False)
            return val
        if k == "who":
            if str(val) not in self.figures:
                raise _unknown(w, "figure", val, self.figures, plugins=False)
            return str(val)
        if k == "sfx":                          # say / hit: the sound that goes with it
            if _bool_word(val) is False or str(val).lower() in ("none", ""):
                return None
            self._sound_name(val, w)
            return val
        if k in ("word", "sub"):
            return str(val)
        if k in ("shake", "zoom") and _bool_word(val) is False:
            return 0
        if k in EVENT_NUMBERS:
            return _num(val, w, *EVENT_NUMBERS[k])
        return val

    def _sound_name(self, name, where: str) -> None:
        n = str(name)
        if n in registry.SOUNDS or "/" in n or n.lower().endswith((".wav", ".mp3", ".ogg", ".flac", ".m4a")):
            return
        raise _unknown(where, "sound", n, registry.SOUNDS, "studio-stickman list sounds; or an audio file / pack item")

    def _sound_params(self, name: str, extra: dict, where: str) -> dict:
        e = registry.SOUNDS.get(name)
        out = {}
        for k, val in extra.items():
            if e is None:
                self._warn(where, f'"{k}" is ignored — an audio file or pack item has no parameters (only gain, pan)', "unknown-option")
            elif k not in e.params:
                close = _close(k, [*e.params, "gain", "pan"])
                self._warn(where, f'sound "{name}" has no option "{k}"{_dym(close)} — ignored (has: {", ".join(["gain", "pan", *e.params])})', "unknown-option")
            else:
                out[k] = _param(e.params[k], val, f"{where}.{k}")
        return out

    def _talk_spans(self) -> None:
        """When each figure speaks (its say bubbles), minus the time it is busy with a move of its own or
        holds a pose of its own (think, a hand over the face, arm angles set in the file …)."""
        said: dict[str, list] = {}
        for ev in self.events:
            if ev["kind"] == "say" and ev.get("who") in self.figures:
                said.setdefault(ev["who"], []).append((ev["t"], ev["t"] + _event_len(ev)))
        for name, spans in said.items():
            f = self.figures[name]
            if not f.talk:
                continue
            busy = sorted([(s["t0"], s["t1"]) for s in f.spans if s["do"] not in ("talk", "wait")] + _posed_spans(f))
            out = []
            for t0, t1 in sorted(spans):
                parts = [(t0, t1)]
                for b0, b1 in busy:
                    parts = [p for q in parts for p in ((q[0], min(q[1], b0)), (max(q[0], b1), q[1])) if p[1] - p[0] > 0.15]
                out += parts
            merged: list = []
            for t0, t1 in sorted(out):
                if merged and t0 <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], t1))
                else:
                    merged.append((t0, t1))
            f.talk_spans = merged
            f._talk_t0 = [s[0] for s in merged]

    # -- timeline -------------------------------------------------------------------
    def _timeline(self, tl) -> None:
        if tl is None:
            return
        if not isinstance(tl, dict):
            raise SceneError("must map figure names to lists of keyframes / actions", where="timeline", code="bad-value")
        queues = []
        for order, (name, items) in enumerate(tl.items()):
            where = f"timeline.{name}"
            if str(name) not in self.figures:
                self._fail(_unknown(where, "figure", name, self.figures, plugins=False))
                continue
            if items is None:
                items = []
            if isinstance(items, dict):         # one item written without the list around it
                items = [items]
            if not isinstance(items, list):
                self._fail(SceneError("must be a list of keyframes / actions like  - { t: 1, do: wave }", where=where, code="bad-value"))
                continue
            queues.append((order, self.figures[str(name)], list(enumerate(items))))
        # what the scene file itself fixes in time, known before any action runs: automatic reactions
        # must not fight these (keyframes), and a strike can see a block that starts at its impact
        for _, f, items in queues:
            for i, it in items:
                if not isinstance(it, dict) or it.get("t") is None or str(it["t"]).strip().startswith("+"):
                    continue
                try:
                    t = self.clock.at(it["t"], 0.0, "t")
                except SceneError:
                    continue
                if "do" in it:
                    guess = it.get("dur") if isinstance(it.get("dur"), (int, float)) and not isinstance(it.get("dur"), bool) else 0.6
                    f.plans.append({"t": t, "do": str(it["do"]), "where": f"timeline.{f.name}[{i}]", "done": False, "guess": float(guess)})
                elif any(k in it for k in BODY_FIELDS):
                    # only keys that move the body: a line of `say` or an `expr` does not stop a hit reaction
                    f.user_times.append(t)
                    f.user_keys.append((t, f"timeline.{f.name}[{i}]"))
        # Expand the items of all figures in the order they start (not figure by figure): an action
        # that looks at another figure (a strike at its target, walk to: figure) then sees where that
        # figure really is at that moment, whichever block comes first in the file.
        cur = {f.name: {"q": list(items), "prev_end": 0.0, "prev_t": None, "busy": None, "order": order} for order, f, items in queues}
        heads = {name: self._head(self.figures[name], c) for name, c in cur.items()}
        while True:
            live = [(h[0], h[1], h[2], h[3], name) for name, h in heads.items() if h]
            if not live:
                break
            name = min(live)[4]
            t, _, _, i, it, explicit = heads[name]
            c = cur[name]
            c["q"].pop(0)
            where = f"timeline.{name}[{i}]"
            with self._guard(where):
                self._item(self.figures[name], i, it, t, explicit, c)
            heads[name] = self._head(self.figures[name], c)

    def _head(self, f: Figure, c: dict) -> tuple | None:
        """The start time of the figure's next item (sort key); items that cannot be timed are reported and skipped."""
        while c["q"]:
            i, it = c["q"][0]
            where = f"timeline.{f.name}[{i}]"
            try:
                if not isinstance(it, dict):
                    raise SceneError("must be a mapping like {t: 2, pose: guard} or {do: punch, target: other}", where=where, code="bad-value", got=it)
                explicit = it.get("t") is not None and not str(it.get("t")).strip().startswith("+")
                t = self.clock.at(it.get("t"), c["prev_end"], f"{where}.t")
                if t < -1e-9:
                    raise SceneError(f"time is negative ({t:g}s) — the scene starts at 0", where=f"{where}.t", code="negative-time", got=t)
                if t > MAX_SECONDS:
                    raise SceneError(f"{t:g}s is after the 30 minute limit", where=f"{where}.t", code="out-of-range", got=t)
            except SceneError as e:
                self._fail(e)
                c["q"].pop(0)
                continue
            # at the same moment: moves that do not aim at another figure first (a block before the strike it stops)
            return (t, 1 if "target" in it else 0, c["order"], i, it, explicit)
        return None

    def _item(self, f: Figure, i: int, it: dict, t: float, explicit: bool, c: dict) -> None:
        where = f"timeline.{f.name}[{i}]"
        it = dict(it)
        it.pop("t", None)
        if explicit and c["prev_t"] is not None and t < c["prev_t"] - 1e-6:
            self._warn(where, f"out of order: starts at {t:.2f}s, before the item above it ({c['prev_t']:.2f}s) — list the items of a figure in time order",
                       "out-of-order")
        c["prev_t"] = t
        # events written next to a key ("say", "sfx", "text" …) belong to this figure
        for kind in EVENT_KINDS:
            if kind in it and kind != "hit":
                ev = {"t": t, kind: it.pop(kind)}
                if kind == "say":
                    ev["who"] = f.name
                    if "say_dur" in it:
                        ev["dur"] = it.pop("say_dur")
                with self._guard(where):
                    self.add_event(ev, where)
        end = t
        what = ""
        moves = ("do" in it and str(it["do"]) not in KO_ALLOWED) or any(k in it for k in BODY_FIELDS)
        kn = f.knocked_at(t) if f.knocked and moves else None
        if kn:
            # ko: true wins over what the figure would do while it falls — say so instead of mixing the two
            self._warn(where, f'skipped — {f.name} is knocked out at {kn["t0"]:.2f}s by {kn["by"]}\'s {kn["do"]} ({kn["where"]}) and falls until '
                              f'{kn["t1"]:.2f}s; start this after that (it lies on the floor then: do: getup brings it back up)', "ko-skip")
            it = {}
        if "do" in it:
            end, what = self._action(f, it, t, explicit, where, c)
        elif it:
            bad = [k for k in it if k not in KEY_FIELDS and k not in ANGLES]
            if bad:
                close = _close(bad[0], [*KEY_FIELDS, *ANGLES])
                raise SceneError(f'unknown field "{bad[0]}"{_dym(close)}', where=where, code="unknown-field", got=bad[0], suggest=close)
            kw = dict(it)
            what = (f"pose {kw['pose']}" if "pose" in kw else "key") + "".join(f" {k}={v}" for k, v in kw.items() if k != "pose")
            hold = self.clock.span(kw.pop("hold", 0), f"{where}.hold")
            if "in" in kw:
                v = kw.pop("in")
                kw["_in"] = None if str(v) in ("full", "all") else self.clock.span(v, f"{where}.in")
            _check_key_fields(kw, where)
            self._warn_limits(kw, where)
            if any(k in kw for k in BODY_FIELDS):
                # a hit reaction still running then ends where this key's transition begins
                d = kw.get("_in", self.blend)
                self._cut_reaction(f, t - (self.blend if d is None else float(d)), where)
            pose = kw.pop("pose", None)
            f.add(t, pose, kw, where)
            if hold > 0:
                f.add(t + hold, None, {"_in": 0.0}, where)
            end = t + hold
        if what:
            self.script.append({"t": t, "end": max(end, t), "who": f.name, "what": what, "where": where, "line": self.line_of(where)})
        c["prev_end"] = max(end, t)

    def _cut_reaction(self, f: Figure, t: float, where: str, index: int | None = None) -> None:
        """A move or key of f's own starts at t: an automatic hit reaction still running then ends there."""
        res = f.end_reaction(t, index)
        if res and not res["kept"]:
            self._warn(where, f"starts at {t:.2f}s, before {f.name}'s reaction to the hit ({res['hit']}) shows — {f.name} does not react to it; "
                              "start this a little later, or give the strike react: false", "no-reaction")

    def _warn_limits(self, kw: dict, where: str) -> None:
        """Angles a keyframe sets outside what the joint can do are clamped when drawn: say so."""
        try:
            from .skeleton import LIMITS
        except ImportError:
            return
        for n, (lo, hi) in LIMITS.items():
            if n in kw and not lo - 1e-6 <= float(kw[n]) <= hi + 1e-6:
                v = float(kw[n])
                self._warn(f"{where}.{n}", f"{n} {v:g} is outside what the {JOINT_NAMES.get(n, 'joint')} can do ({lo:g}..{hi:g}) — "
                                           f"it is drawn as {min(hi, max(lo, v)):g}", "out-of-range")

    def _action(self, f: Figure, it: dict, t: float, explicit: bool, where: str, c: dict) -> tuple[float, str]:
        aname = str(it.pop("do"))
        what = "do " + aname + "".join(f" {k}={v}" for k, v in it.items())
        e = registry.ACTIONS.get(aname)
        if not e:
            raise _unknown(f"{where}", "action", aname, registry.ACTIONS, "studio-stickman list actions")
        params = _check_params(e, it, where, "action", self.clock)
        for k in ("dur", "hold"):
            if params.get(k) is not None and k in e.params:
                params[k] = self.clock.span(params[k], f"{where}.{k}")
                if k == "dur" and params[k] <= 0:
                    raise SceneError("must be more than 0 seconds", where=f"{where}.dur", code="out-of-range", got=params[k])
        ctx = ActionCtx(self, f, t, params, where, explicit, action=aname)
        n0 = len(f.raw)
        try:
            e.fn(ctx)
        except SceneError:
            raise
        except Exception as ex:  # noqa: BLE001
            raise SceneError(f'action "{aname}" ({e.source}) failed: {type(ex).__name__}: {ex}', where=where, code="action-failed") from None
        end = t + ctx.end
        for p in f.plans:
            if p["where"] == where:
                p["done"] = True
        if ctx._first is not None:
            start = t + min(0.0, ctx._first)
            # a hit reaction still running when this move starts ends there (the move starts from the stance)
            self._cut_reaction(f, start, where, n0)
            # knocked out (ko: true) while this move runs: the knock-out wins, the rest of the move is cut
            last = t + ctx._last
            for kn in (f.knocked if aname not in KO_ALLOWED else []):
                if start < kn["t0"] < last - 1e-6 and f.cut_move(where, kn["t0"]):
                    self._warn(where, f'{f.name} is knocked out at {kn["t0"]:.2f}s by {kn["by"]}\'s {kn["do"]} ({kn["where"]}) — the rest of this {aname} is cut',
                               "ko-cut")
                    end = last = min(end, kn["t0"])
                    ctx._times = [x for x in ctx._times if x <= last + 1e-6]
            span = {"t0": start, "t1": max(end, last), "do": aname, "where": where, "keys": sorted(ctx._times)}
            f.spans.append(span)
            # Two moves of one figure at the same time get mixed key by key (a walk loses its steps, the
            # figure skates): say so. Running into the last key of the move before (its settle into
            # `then`) is the normal flow from move to move, and a plain keyframe inside a move is an
            # intended override — neither is reported.
            busy = c["busy"]
            if busy and sum(1 for k in busy["keys"] if k > start + 1e-6) >= 2:
                self._warn(where, f'{aname} starts at {start:.2f}s while {busy["do"]} ({busy["where"]}) runs until {busy["t1"]:.2f}s — the two moves get mixed; '
                                  f'start it after that (leave out t, or t: "+0") or make the {busy["do"]} shorter', "overlap")
            if busy is None or span["t1"] > busy["t1"]:
                c["busy"] = span
        return end, what

    # -- props, camera ----------------------------------------------------------------
    def _props(self, spec) -> list[Prop]:
        if spec is None:
            return []
        if not isinstance(spec, dict):
            self._fail(SceneError("must map names to props, e.g.  props: { box: { kind: crate, x: 600 } }", where="props", code="bad-value"))
            return []
        out = []
        for name, p in spec.items():
            where = f"props.{name}"
            with self._guard(where):
                out.append(self._prop(str(name), p, where))
        return out

    def _prop(self, name: str, p, where: str) -> Prop:
        if not isinstance(p, dict):
            raise SceneError("must be a mapping like {kind: crate, x: 600}", where=where, code="bad-value", got=p)
        p = dict(p)
        kind = str(p.pop("kind", name))
        e = registry.PROPS.get(kind)
        if not e:
            raise _unknown(f"{where}.kind" if f"{where}.kind" in self.lines else where, "prop kind", kind, registry.PROPS, "studio-stickman list props")
        layer = str(p.pop("layer", "back"))
        if layer not in ("back", "front"):
            raise SceneError(f"layer must be back (behind the figures) or front, got {_show(layer)}", where=f"{where}.layer", code="bad-value", got=layer)
        x = _num(p.pop("x", self.w / 2), f"{where}.x")
        y = _num(p.pop("y", self.floor), f"{where}.y")
        rot = _num(p.pop("rot", 0), f"{where}.rot")
        scale = _num(p.pop("scale", 1), f"{where}.scale", 0.05, 20)
        flip = -1 if _bool(p.pop("flip", False), f"{where}.flip") else 1
        has_to = "to" in p
        t_from = self.clock.at(p.pop("from", 0), 0.0, f"{where}.from")
        t_to = self.clock.at(p.pop("to", 1e9), 0.0, f"{where}.to")
        if t_from < 0:
            raise SceneError(f"time is negative ({t_from:g}s)", where=f"{where}.from", code="negative-time", got=t_from)
        if has_to and t_to <= t_from:
            raise SceneError(f"to ({t_to:g}s) must be after from ({t_from:g}s) — the prop would never be seen", where=f"{where}.to", code="out-of-range", got=t_to)
        held_by = p.pop("held_by", None)
        if held_by is not None and str(held_by) not in self.figures:
            raise _unknown(f"{where}.held_by", "figure", held_by, self.figures, plugins=False)
        hand = str(p.pop("hand", "R")).upper()[:1]
        if hand not in ("R", "L"):
            raise SceneError("hand must be R (near hand) or L (far hand)", where=f"{where}.hand", code="bad-value", got=hand)
        angle = _num(p.pop("angle", 0), f"{where}.angle")
        keys = []
        cx, cy, cr = x, y, rot
        raw_keys = p.pop("keys", []) or []
        if not isinstance(raw_keys, list):
            raise SceneError("keys must be a list like [ { t: 1, x: 300 }, { t: 2, x: 900 } ]", where=f"{where}.keys", code="bad-value")
        if raw_keys and held_by is not None:
            self._warn(f"{where}.keys", f"ignored — the prop is held by {held_by} and moves with the hand", "ignored")
        for i, k in enumerate(raw_keys):
            kw = f"{where}.keys[{i}]"
            if not isinstance(k, dict) or "t" not in k:
                raise SceneError("needs t and x / y / rot", where=kw, code="bad-value")
            bad = [f for f in k if f not in ("t", "x", "y", "rot", "arc", "ease")]
            if bad:
                close = _close(bad[0], ["t", "x", "y", "rot", "arc", "ease"])
                raise SceneError(f'unknown field "{bad[0]}"{_dym(close)} (fields: t x y rot arc ease)', where=kw, code="unknown-field", got=bad[0], suggest=close)
            cx = _num(k.get("x", cx), f"{kw}.x")
            cy = _num(k.get("y", cy), f"{kw}.y")
            cr = _num(k.get("rot", cr), f"{kw}.rot")
            ez = str(k.get("ease", "io"))
            if ez not in EASES:
                raise _unknown(f"{kw}.ease", "ease", ez, EASES, "one of: " + ", ".join(EASES), plugins=False)
            kt = self.clock.at(k["t"], 0.0, f"{kw}.t")
            if kt < 0:
                raise SceneError(f"time is negative ({kt:g}s)", where=f"{kw}.t", code="negative-time", got=kt)
            keys.append((kt, cx, cy, cr, _num(k.get("arc", 0), f"{kw}.arc"), ez))
        if keys:
            keys.sort(key=lambda k: k[0])
            if keys[0][0] > 0:
                keys.insert(0, (0.0, x, y, rot, 0.0, "io"))
        params = _check_params(e, p, where, "prop")
        if kind == "label" and params.get("font") is not None:
            self._event_option("text", "font", params["font"], f"{where}.font")
        return Prop(name, kind, params, layer, x, y, rot, scale, flip, t_from, t_to, keys, str(held_by) if held_by is not None else None, hand, angle)

    def _camera(self, keys) -> list[CamKey]:
        if keys is None:
            return []
        if isinstance(keys, dict):
            keys = [keys]
        if not isinstance(keys, list):
            self._fail(SceneError("must be a list of keyframes like  - { t: 0, x: 640, y: 360, zoom: 1 }", where="camera", code="bad-value"))
            return []
        out = []
        zoom = 1.0
        for i, k in enumerate(keys):
            where = f"camera[{i}]"
            with self._guard(where):
                if not isinstance(k, dict):
                    raise SceneError("must be a mapping like {t: 0, x: 640, y: 360, zoom: 1.2}", where=where, code="bad-value", got=k)
                bad = [f for f in k if f not in CAMERA_FIELDS]
                if bad:
                    close = _close(bad[0], CAMERA_FIELDS)
                    raise SceneError(f'unknown field "{bad[0]}"{_dym(close)} (fields: {" ".join(CAMERA_FIELDS)})', where=where, code="unknown-field",
                                     got=bad[0], suggest=close)
                t = self.clock.at(k.get("t", 0), 0.0, f"{where}.t")
                if t < 0:
                    raise SceneError(f"time is negative ({t:g}s) — the scene starts at 0", where=f"{where}.t", code="negative-time", got=t)
                zoom = _num(k.get("zoom", zoom), f"{where}.zoom", 0.2, 8)
                x = _num(k["x"], f"{where}.x") if k.get("x") is not None else None
                y = _num(k["y"], f"{where}.y") if k.get("y") is not None else None
                follow = k.get("follow")
                if follow is not None and str(follow) not in self.figures:
                    raise _unknown(f"{where}.follow", "figure", follow, self.figures, plugins=False)
                ez = "hold" if _bool(k.get("cut", False), f"{where}.cut") else str(k.get("ease", "io"))
                if ez not in EASES:
                    raise _unknown(f"{where}.ease", "ease", ez, EASES, "one of: " + ", ".join(EASES), plugins=False)
                out.append(CamKey(t, x, y, zoom, ez, str(follow) if follow is not None else None,
                                  _num(k.get("dx", 0), f"{where}.dx"), _num(k.get("dy", 0), f"{where}.dy")))
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

    # -- checks after loading -------------------------------------------------------------
    def _check_fx(self) -> None:
        """Run every fx a figure uses once, so a plugin fx with a bug shows up in `check` (with the
        key that uses it) instead of in the middle of a render."""
        done = set()
        for f in self.figures.values():
            for k in f.keys:
                for name, params in k.fx + k.nfx:
                    if (f.name, name) in done:
                        continue
                    done.add((f.name, name))
                    e = registry.MOTIONS.get(name)
                    if e is None:
                        continue
                    st = {**k.ang, "x": k.x, "y": k.y, "rot": k.rot, "face": k.face, "expr": k.expr, "look": k.look, "visible": True}
                    ctx = {"beat": self.clock.beat, "phase": f.phase, "fps": self.fps, "figure": f.name, "thigh": 50.0 * f.scale,
                           "shin": 50.0 * f.scale, "run": None, "gait_w": 1.0}
                    try:
                        e.fn(st, k.t + 0.37, dict(params), ctx)
                    except Exception as ex:  # noqa: BLE001
                        self._fail(SceneError(f'fx "{name}" ({e.source}) failed: {type(ex).__name__}: {ex}', where=k.where, code="fx-failed"))

    def _lint(self) -> None:
        for f in self.figures.values():
            xs = [k.x for k in f.keys]
            if max(xs) < -50 or min(xs) > self.world_w + 50:
                self._warn(f"figures.{f.name}", f'"{f.name}" is never inside the scene (x {min(xs):g}…{max(xs):g}, scene width {self.world_w})', "outside")
            elif min(xs) < -200 or max(xs) > self.world_w + 200:
                self._warn(f"figures.{f.name}", f'"{f.name}" moves far outside the scene (x {min(xs):g}…{max(xs):g}, scene width {self.world_w})', "outside")
            if len(f.raw) == 1 and not any(ev["kind"] == "say" and ev.get("who") == f.name for ev in self.events):
                self._warn(f"figures.{f.name}", f'"{f.name}" has no timeline — it just stands there', "no-timeline")
            self._lint_airborne(f)
        for ev in self.events:
            if ev["t"] > self.duration + 1e-6:
                self._warn(ev["_where"], f'happens at {ev["t"]:.2f}s, after the end ({self.duration:g}s)', "after-end")
        for k in self.camera:
            if k.zoom < 0.999 and (self.world_w, self.world_h) == (self.w, self.h):
                self._warn("camera", "zoom below 1 shows the area around the scenery — set scene.world larger than scene.size for wide shots", "zoom-out")
                break
        if self.audio and not self.clock.bpm:
            self._warn("scene.audio", 'is set but scene.bpm is not — with the bpm of the music you can place moves on beats ("5:1")', "no-bpm")

    def _lint_airborne(self, f: Figure) -> None:
        """A keyframe that lifts a figure (y) keeps it up there until a key brings it down again — say so
        when nothing seems to hold it up (scenes written when y fell back to the floor at every key)."""
        keys = sorted(f.raw, key=lambda k: k["t"])
        # a keyframe's y, or the height an action leaves the figure at (climb: `ground`)
        lifts = [k for k in keys if ("_do" not in k and "y" in k) or "ground" in k]
        if not lifts or lifts[-1].get("_spec"):
            return
        k = lifts[-1]
        y = float(k["ground"] if "ground" in k else k.get("y", 0.0))
        if y <= 0.5:
            return
        st = f.state(k["t"])
        if "float" in st["fx"]:
            return
        for p in self.props:
            if p.kind in STANDABLE and p.held_by is None:
                half = float(p.params.get("w") or p.params.get("size") or 100) * p.scale / 2 + 40
                if abs(p.x - st["x"]) <= half:
                    return
        if "ground" in k and k.get("_do"):
            # up there after a climb: hanging on (then: hang) holds it up by the hands — until it lets go
            go = next((kk for kk in keys if kk["t"] >= k["t"] - 1e-9 and "pose" in kk and str(kk["pose"]) not in ("hang", "climb")), None)
            if go is None:
                return
            self._warn(k.get("_where"), f'"{f.name}" stays {y:g} px above the floor after its {k["_do"]} and from {go["t"]:.2f}s on (pose {go["pose"]}) '
                                        "nothing holds it up there — later moves happen in mid-air; put a prop to stand on under it "
                                        "(table, platform …) or come down again (climb with a negative height, or a key with y: 0)", "airborne")
            return
        self._warn(k.get("_where"), f'"{f.name}" stays {y:g} px above the floor from {k["t"]:.2f}s on — a height is kept until a key sets it again '
                                    "(y: 0 brings it down; ignore this when it stands on something)", "airborne")

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
        data, lines = _parse(text)
    except yaml.YAMLError as e:
        raise _yaml_error(e, path) from None
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise SceneError("a scene file must be a mapping with scene / figures / timeline", where=path.name, line=1, code="not-a-mapping")
    return Scene(data, path, lines)


def load_scene(path: str | Path) -> Scene:
    path = Path(path)
    if path.is_dir():
        found = sorted([*path.glob("*.stick.y*ml"), *path.glob("*/*.stick.y*ml")])[:8]     # not deeper: a project folder can be big
        hint = f" — did you mean one of: {', '.join(p.as_posix() for p in found)}" if found else " (scene files end in .stick.yaml)"
        raise SceneError(f"{path} is a folder, not a scene file{hint}", code="is-folder", got=str(path))
    try:
        text = path.read_text("utf-8-sig")
    except FileNotFoundError:
        near = [p.as_posix() for p in (path.parent.glob("*.stick.y*ml") if path.parent.is_dir() else [])]
        if not path.name.endswith((".yaml", ".yml")):
            near = [str(p) for p in (path.with_name(path.name + ".stick.yaml"),) if p.exists()] + near
        close = difflib.get_close_matches(path.as_posix(), near, n=3, cutoff=0.6)
        raise SceneError(f"file not found: {path}{_dym(close)}", code="file-not-found", got=str(path), suggest=close) from None
    except UnicodeDecodeError:
        raise SceneError(f"{path} is not UTF-8 text — is it a scene file?", code="bad-encoding", got=str(path)) from None
    except OSError as e:
        raise SceneError(f"cannot read {path}: {e.strerror or e}", code="unreadable", got=str(path)) from None
    return load_scene_text(text, path)
