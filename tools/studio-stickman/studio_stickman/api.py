"""Public plugin API of studio-stickman.

A plugin is a .py file in <project>/plugins/stickman/ (or a pack item of kind "plugin" with
meta.target = "studio-stickman"). It registers new things scenes can name:

    from studio_stickman.api import pose, action, motion, prop, backdrop, sound, particle, np

    pose("victory", RS=170, RE=-10, LS=165, LE=-10, H=-12, doc="both arms up")

    @action("backflip", params={"height": 150, "dur": 0.7, "dir": "back"}, doc="jump, turn once, land",
            choices={"dir": ("back", "front")}, ranges={"height": (20, 600)})
    def backflip(a):                                   # a: the action's context
        d = a.p["dur"]
        a.key(0, "crouch", ease="out")                 # keyframes relative to the action's start
        a.key(0.12, "jump", ease="out")
        turn = -360 if a.p["dir"] == "back" else 360   # choices: a scene gets an error for any other word
        a.key(0.12 + d / 2, "jump", y=a.p["height"], rot=turn / 2, ease="lin")
        a.key(0.12 + d, "land", rot=turn, ease="in")
        a.key(0.3 + d, "stand", rot=0)
        a.event(0.12 + d, sfx="thud", gain=0.6)        # sounds, hit words, shakes …

    @motion("tremble", params={"amp": 4})              # continuous: `fx: tremble`
    def tremble(st, t, p, ctx):
        st["H"] += math.sin(t * 40) * p["amp"]

    @prop("saber", params={"length": 90, "color": "#cfd6e4"})
    def saber(c, p, t):                                # local coords: (0, 0) = the hand, +x = forward
        c.line((0, 0), (p["length"], 0), 5, p["color"])
        c.line((8, -9), (8, 9), 4, "#8a6a3a")

    @backdrop("alley", params={"wall": "#2a2f3a"})
    def alley(c, w, h, floor, p):                      # world coords, drawn once
        c.rect(0, 0, w, floor, fill=p["wall"])

    @sound("laser", params={"freq": 1400})
    def laser(sr, p, rng):                             # -> numpy array (mono or stereo), any length
        t = np.arange(int(0.25 * sr)) / sr
        return np.sin(2 * np.pi * (p["freq"] * np.exp(-t * 9)) * t) * np.exp(-t * 12) * 0.5

    @particle("heart", params={"size": 10})
    def heart(c, x, y, age, u, seed, p):               # u: 0 (born) .. 1 (gone)
        c.circle((x, y), p["size"] * (1 - u), fill="#ff5a8a")

Angles of a pose: T H RS RE LS LE RH RK LH LK (see `studio-stickman docs`), optional rot and y.
Hinge joints are clamped while drawing (LIMITS: elbows -10..160, knees -165..5, head -70..70; a pose
with an angle outside them gets a warning in `check`), and the
body always rests on the floor by its lowest part (feet, knees, buttocks, back or head) — a lying or
sitting pose needs no y. Action parameters are checked against the type of their default; `choices`
names the words a parameter takes (case does not matter; forward/backward mean front/back) and
`ranges` the (lowest, highest) number — anything else is an error with the line of the scene.
Helpers for actions: ik_limb(fwd, down, l1, l2, bend) solves an arm (bend=1)
or a leg (bend=-1) so its end reaches a point; fk(state, floor, scale, build) gives joint positions.
Canvas methods (c): line, polyline, circle, ellipse, rect, poly, text, arc, at(origin, angle, flip, scale).
"""
from __future__ import annotations

import math  # noqa: F401  (re-exported for plugins)
from typing import Callable

import numpy as np  # noqa: F401  (re-exported for plugins)

from .registry import register
from .skeleton import ANGLES, DIMS, LIMITS, STAND, color, ease, fk, hash01, ik_limb, lerp, limit, mix, shade  # noqa: F401


def pose(name: str, doc: str = "", base: str | None = None, **angles) -> None:
    """Register a pose. Angles that are not given come from `base` (default: "stand"). An angle outside
    LIMITS is clamped when drawn; `check` and `list` warn about it (registry)."""
    from .registry import POSES

    start = dict(POSES[base].data) if base and base in POSES else dict(STAND)
    for k, v in angles.items():
        if k not in ANGLES and k not in ("rot", "y"):
            raise ValueError(f'pose "{name}": unknown angle "{k}" (angles: {" ".join(ANGLES)}, rot, y)')
        start[k] = float(v)
    register("pose", name, None, None, doc, start)


def _deco(kind: str, name: str, params: dict | None, doc: str, choices: dict | None = None, ranges: dict | None = None) -> Callable:
    def deco(fn: Callable) -> Callable:
        from .registry import TABLES

        register(kind, name, fn, params, doc)
        entry = TABLES[kind][str(name)]
        # read by the scene when it checks a parameter (scene._check_params)
        if choices:
            entry.choices = {str(k): tuple(str(c).lower() for c in v) for k, v in choices.items()}
        if ranges:
            entry.ranges = {str(k): (lo, hi) for k, (lo, hi) in ranges.items()}
        return fn

    return deco


def action(name: str, params: dict | None = None, doc: str = "", choices: dict | None = None, ranges: dict | None = None) -> Callable:
    """fn(a): add keyframes with a.key(dt, pose, **kw) and events with a.event(dt, **kw).
    choices={"dir": ("front", "back")}: the words a parameter takes; ranges={"power": (0, 5)}: the
    lowest / highest number (None: no limit). A scene with anything else gets an error at its line."""
    return _deco("action", name, params, doc, choices, ranges)


def motion(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(st, t, p, ctx): change the state (angles, x, y, rot) in place — continuous movement."""
    return _deco("motion", name, params, doc)


def prop(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(c, p, t): draw in local coordinates (origin = where the prop stands / the hand)."""
    return _deco("prop", name, params, doc)


def backdrop(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(c, w, h, floor, p): draw the scenery once, in world coordinates."""
    return _deco("backdrop", name, params, doc)


def sound(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(sr, p, rng) -> numpy array: one sound effect (mono or (n, 2) stereo, peak around 0.5)."""
    return _deco("sound", name, params, doc)


def particle(name: str, params: dict | None = None, doc: str = "") -> Callable:
    """fn(c, x, y, age, u, seed, p): draw one particle (u runs from 0 to 1 over its life)."""
    return _deco("particle", name, params, doc)
