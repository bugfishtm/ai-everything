"""Built-in actions: `do: walk`, `do: punch` … — small choreographies that expand into keyframes
(and sounds / hit effects / the other figure's reaction).

Timing: a strike written with a fixed time (`t: 4.5` or `t: "5:1"`) LANDS at that time — the
wind-up happens just before, so hits sit on the beat. Without a time (or with "+0.5") an action
starts when the previous item of the figure ended.

Bodies are placed with the real skeleton (skeleton.fk): a fist is aimed at the surface of the head
it hits (two-bone IK), a falling body turns about its feet until it lies on the floor, a figure that
sits down or gets up keeps its feet where they are.
"""
from __future__ import annotations

import math

from . import registry
from .api import action
from .skeleton import ANGLES, DIMS, STAND, fk, hash01, ik_limb

# a strike freezes both figures for this many frames at the moment of impact (it sells the hit)
HIT_STOP_FRAMES = 2


def _error(msg: str) -> Exception:
    from .scene import SceneError

    return SceneError(msg)


def _parse_face(v, where: str) -> int:
    from .scene import _face

    return _face(v, where)


# ---------------------------------------------------------------------------
# Reading the figures: the state a figure is keyed to at some time, and its joints there
# ---------------------------------------------------------------------------
def _pose_data(name) -> dict:
    e = registry.POSES.get(str(name))
    d = dict(STAND)
    d["rot"] = 0.0
    if e:
        for k in ANGLES:
            d[k] = float(e.data.get(k, STAND[k]))
        d["rot"] = float(e.data.get("rot", 0.0))
    return d


def _posed(a, fig, t: float) -> dict:
    """What `fig` is keyed to at scene time t (from the keys added so far): the last pose with the angle,
    rot and y overrides of later keys, plus x and face. Good enough to aim at, not a rendered frame."""
    raw = sorted((k for k in getattr(fig, "raw", []) if k.get("t", 0.0) <= t + 1e-9), key=lambda k: k["t"])
    st = _pose_data("stand")
    pose_name = "stand"
    y = 0.0
    for k in raw:
        if "pose" in k:
            pose_name = str(k["pose"])
            st = _pose_data(pose_name)
        for n in ANGLES:
            if n in k:
                try:
                    st[n] = float(k[n])
                except (TypeError, ValueError):
                    pass
        if "rot" in k:
            st["rot"] = float(k["rot"])
        y = float(k.get("y", 0.0) or 0.0) if "_do" in k else 0.0
    # what the figure stands on (a table, a ledge) lifts it as a whole
    ground_at = getattr(fig, "ground_at", None)
    if callable(ground_at):
        y += float(ground_at(t))
    x_at = getattr(fig, "x_at", None)
    st["x"] = float(x_at(t)) if callable(x_at) else float(fig.last("x", t, a.scene.w / 2))
    try:
        st["face"] = _parse_face(fig.last("face", t, 1), a.where)
    except Exception:  # noqa: BLE001
        st["face"] = 1
    st["y"] = y
    st["_pose"] = pose_name
    return st


def _joints(a, fig, st: dict) -> dict:
    s = {k: v for k, v in st.items() if not k.startswith("_")}
    return fk(s, a.floor, fig.scale, fig.build)


def _lengths(fig, limb: str) -> tuple[float, float]:
    d = {**DIMS, **(fig.build or {})}
    if limb == "arm":
        return d["upper_arm"] * fig.scale, d["forearm"] * fig.scale
    return d["thigh"] * fig.scale, d["shin"] * fig.scale


def _wrap(d: float) -> float:
    """An angle difference the short way round (-180..180)."""
    return (d + 180.0) % 360.0 - 180.0


def _angles(st: dict) -> dict:
    return {n: float(st[n]) for n in ANGLES}


def _x_keeping(a, fig, st_from: dict, st_to: dict, joint: str) -> float:
    """x for st_to so that `joint` (e.g. "Rfoot") stays where it is in st_from: the body moves over a
    planted foot / hand / knee instead of sliding it along the floor."""
    p_from = _joints(a, fig, st_from)
    p_to = _joints(a, fig, {**st_to, "x": 0.0})
    if joint == "feet":
        return (p_from["Rfoot"][0] + p_from["Lfoot"][0]) / 2 - (p_to["Rfoot"][0] + p_to["Lfoot"][0]) / 2
    return p_from[joint][0] - p_to[joint][0]


def _planted(a, t0: float, cur: dict, pose: str, dur: float, anchor: str, n: int = 3, **kw) -> dict:
    """Move from state `cur` into `pose` over dur seconds (starting t0 after the action start) while
    `anchor` (a foot, the feet, a knee, a hand, the hip) stays where it is on the floor: n in-between
    keys with blended angles, each placed so the anchor has not moved (one key would let the feet
    slide, because x and the angles change at different rates). Returns the new state."""
    fig = a.figure
    to = {**_pose_data(pose), "face": cur.get("face", a.face), "y": 0.0}
    A, B = _angles(cur), _angles(to)
    delta = {k: _wrap(B[k] - A[k]) for k in ANGLES}
    r0, r1 = float(cur.get("rot", 0.0)), float(to.get("rot", 0.0))
    prev = 0.0
    x = float(cur["x"])
    # both feet planted (standing up, sitting down …): each leg is solved to keep its own foot, not
    # just the middle of the feet — the stances of the two poses may be wider or narrower
    feet = None
    if anchor == "feet" and not r0 and not r1:
        P0 = _joints(a, fig, cur)
        feet = (P0["Rfoot"][0], P0["Lfoot"][0])
        l1, l2 = _lengths(fig, "leg")
    legs: dict = {}
    for i in range(1, n + 1):
        u = i / n
        e = u * u * (3 - 2 * u)
        st = {**{k: A[k] + delta[k] * e for k in ANGLES}, "rot": r0 + (r1 - r0) * e, "face": to["face"], "y": 0.0}
        x = _x_keeping(a, fig, cur, st, anchor)
        if feet:
            f = to["face"]
            depth = max(l1 * math.cos(math.radians(st[s + "H"])) + l2 * math.cos(math.radians(st[s + "H"] + st[s + "K"])) for s in "RL")
            for s, fx in zip("RL", feet):
                legs[s + "H"], legs[s + "K"] = ik_limb((fx - x) * f, depth, l1, l2, -1)
            st.update(legs)
        t = t0 + dur * u
        if i < n:
            a.key(t, None, x=round(x, 2), rot=round(st["rot"], 2), in_=t - (t0 + prev), ease="lin", **{k: round(v, 2) for k, v in st.items() if k in ANGLES})
        else:
            a.key(t, pose, x=round(x, 2), in_=t - (t0 + prev), ease="lin", **{k: round(v, 2) for k, v in legs.items()}, **kw)
        prev = dur * u
    return {**to, **legs, "x": x}


def _cur_fx(fig, t: float) -> list:
    """The fx of `fig` at time t in key form (a pose key without fx switches fx off)."""
    best, best_t = [], -1.0
    for k in getattr(fig, "raw", []):
        if ("pose" in k or "fx" in k) and best_t <= k["t"] <= t + 1e-9:
            best_t = k["t"]
            v = k.get("fx") if "fx" in k else None
            best = [] if v in (None, False, "", "none") else (list(v) if isinstance(v, list) else [v])
    return best


def _expr_at(fig, t: float) -> str:
    return str(fig.last("expr", t, "calm"))


def _emitter(a, name: str | None):
    """a.key for the acting figure (name None) or a.key_for for another one."""
    if name is None or name == a.name:
        return lambda dt, pose=None, **kw: a.key(dt, pose, **kw)
    return lambda dt, pose=None, **kw: a.key_for(name, dt, pose, **kw)


def _turn_keys(a, dt: float, old: int, new: int, dur: float = 0.22, fx: list | None = None) -> None:
    """Turn round instead of mirroring in one frame: face flips at dt, and the turn fx narrows the body
    through a front view over `dur` seconds (skeleton.fk squeezes it while |face| < 1)."""
    if old == new or "turn" not in registry.MOTIONS:
        a.key(dt, None, face=new, in_=0)
        return
    base = list(fx) if fx is not None else _cur_fx(a.figure, a.t + dt)
    a.key(dt, None, face=new, fx=base + [{"use": "turn", "t0": round(a.t + dt, 4), "dur": dur, "from": old}], in_=0)
    if fx is None:
        a.key(dt + dur, None, fx=base or "none", in_=0)


def _dir_to(a, to) -> tuple[float, int]:
    """Target x and the facing direction for `to`: a number, or a figure name (stops next to it)."""
    if to is None:
        return a.x, a.face
    if isinstance(to, (int, float)):
        x = float(to)
    elif str(to) in a.scene.figures:
        ox = a.x_of(str(to))
        gap = float(a.p.get("gap", 90)) * a.scale
        x = ox - gap if a.x <= ox else ox + gap
    else:
        try:
            x = float(to)
        except (TypeError, ValueError):
            from .scene import _close, _dym

            raise _error(f'{a.where}: "to" must be an x position or a figure name, got "{to}"{_dym(_close(to, a.scene.figures))}') from None
    return x, (1 if x >= a.x else -1)


# ---------------------------------------------------------------------------
# Travelling
# ---------------------------------------------------------------------------
# what a figure keeps doing after walking with it (a carried box is not dropped on arrival)
_HOLD = {"carry", "push", "pull", "guard", "block", "zombie", "hang", "sneak"}
# upper: a gesture for the arms while the legs walk. name: (pose, fx)
_UPPER = {"wave": ("wave", "wave"), "talk": ("stand", "talk"), "cheer": ("cheer", None), "type": ("type", "type")}


def _upper(a, upper) -> tuple[str | None, list]:
    if upper in (None, False, "", "none"):
        return None, []
    u = str(upper)
    if u in _UPPER:
        pose, fx = _UPPER[u]
        return pose, ([fx] if fx else [])
    if u not in registry.POSES:
        raise _error(f'{a.where}: upper — unknown pose or gesture "{u}"{registry.suggest(u, registry.POSES)} (a pose name, or: {", ".join(_UPPER)})')
    return u, []


def _travel(a, pose: str, fx: str, speed: float, fx_params: dict | None = None) -> None:
    by = a.p.get("by")
    to = a.p.get("to")
    if to is None and by is not None:
        to = a.x + float(by)
    x, face = _dir_to(a, to)
    dist = abs(x - a.x)
    dur = a.p["dur"] if a.p.get("dur") else max(0.25, dist / (speed * a.scale))
    if a.p.get("backwards"):
        face = -face
    up_pose, up_fx = _upper(a, a.p.get("upper"))
    gait = {"use": fx, **(fx_params or {})}
    if up_pose:
        gait["arms"] = 0.0          # the arms keep the gesture, the legs walk
    fxl = [gait] + up_fx
    then = a.p.get("then") or (up_pose if up_pose in _HOLD else None) or ("stand" if up_pose else pose if pose in _HOLD else "stand")
    if face != a.face:
        # turn round on the first step instead of mirroring
        _turn_keys(a, 0.0, a.face, face, 0.24, fx=_cur_fx(a.figure, a.t))
        fxl = fxl + [{"use": "turn", "t0": round(a.t, 4), "dur": 0.24, "from": a.face}]
    a.key(0.1, up_pose or pose, face=face, fx=fxl, in_=0.1)
    a.key(dur, None, x=x, in_=max(dur - 0.1, 0.01), ease="lin")
    a.key(dur + 0.14, then, in_=0.14)
    a.dur = dur + 0.14


_TRAVEL = {"to": None, "by": None, "dur": None, "gap": 90, "backwards": False, "upper": None}


@action("walk", params={**_TRAVEL, "speed": 190, "then": None},
        doc="walk to an x position or up to a figure (to: 600 | to: cop), or by a distance (by: -200); upper: carry|point|guard|wave|talk … keeps that gesture while walking")
def walk(a):
    _travel(a, "stand", "walk", float(a.p["speed"]))


@action("run", params={**_TRAVEL, "speed": 430, "gap": 100, "then": None}, doc="run to an x position or up to a figure (upper: a gesture for the arms)")
def run(a):
    _travel(a, "run", "run", float(a.p["speed"]))


@action("sneak", params={**_TRAVEL, "speed": 90, "then": "sneak"}, doc="creep to an x position or up to a figure")
def sneak(a):
    _travel(a, "sneak", "sneak", float(a.p["speed"]))


@action("crouch", params={**_TRAVEL, "speed": 80, "then": None},
        doc="crouch down; with to/by: walk there crouched low (crouch-walk), then: crouch stays down")
def crouch(a):
    if a.p.get("to") is None and a.p.get("by") is None:
        cur = _planted(a, 0.0, _posed(a, a.figure, a.t), "crouch", 0.32, "feet")
        if a.p.get("then"):
            _planted(a, 0.36, cur, str(a.p["then"]), 0.34, "feet")
        return
    if not a.p.get("then"):
        a.p["then"] = "crouch"
    # the sneak gait with the hips much lower and short steps (gait kind "crouch", see poses.py)
    _travel(a, "sneak", "sneak", float(a.p["speed"]), {"low": True})


@action("carry", params={**_TRAVEL, "speed": 150, "then": "carry"}, doc="walk while holding something in both arms (to / by like walk)")
def carry(a):
    a.p["upper"] = a.p.get("upper") or "carry"
    _travel(a, "carry", "walk", float(a.p["speed"]))


@action("push", params={**_TRAVEL, "speed": 110, "then": "push"},
        doc="lean into something and push it along (to / by; move the pushed prop with its own keys)")
def push(a):
    a.p["upper"] = a.p.get("upper") or "push"
    _travel(a, "push", "walk", float(a.p["speed"]))


@action("pull", params={**_TRAVEL, "speed": 90, "backwards": True, "then": "pull"},
        doc="lean back and drag something along, walking backwards (to / by)")
def pull(a):
    a.p["upper"] = a.p.get("upper") or "pull"
    _travel(a, "pull", "walk", float(a.p["speed"]))


@action("crawl", params={"to": None, "by": None, "dur": None, "speed": 60, "gap": 90, "then": "crawl"},
        doc="get down on hands and knees and crawl to x / by a distance (then: stand gets up again)")
def crawl(a):
    by, to = a.p.get("by"), a.p.get("to")
    if to is None and by is not None:
        to = a.x + float(by)
    x, face = _dir_to(a, to)
    dur = a.p["dur"] if a.p.get("dur") else max(0.3, abs(x - a.x) / (float(a.p["speed"]) * a.scale))
    st0 = _posed(a, a.figure, a.t)
    t0 = 0.0
    if st0["_pose"] != "crawl":
        if face != a.face:
            _turn_keys(a, 0.0, a.face, face)
        # down onto one knee, then forward onto the hands
        cur = _planted(a, 0.0, {**st0, "face": face}, "kneel", 0.32, "Rfoot")
        cur = _planted(a, 0.32, cur, "crawl", 0.3, "Lknee", fx="crawl")
        a.x = cur["x"]
        t0 = 0.62
    else:
        a.key(0.02, None, face=face, fx="crawl", in_=0.02)
        t0 = 0.02
    a.key(t0 + dur, None, x=x, in_=dur, ease="lin")
    end = t0 + dur
    then = str(a.p.get("then") or "crawl")
    if then != "crawl":
        cur = _planted(a, end, {**_pose_data("crawl"), "face": face, "y": 0.0, "x": x}, "kneel", 0.32, "Lknee")
        _planted(a, end + 0.32, cur, then, 0.36, "Rfoot")
        end += 0.68
    a.dur = end


@action("enter", params={"side": "left", "to": None, "run": False, "then": "stand"}, doc="come in from outside the picture (side: left|right) to x", choices={"side": ("left", "right")})
def enter(a):
    side = str(a.p["side"])
    start = -90.0 if side == "left" else a.scene.world_w + 90.0
    to = float(a.p["to"]) if a.p["to"] is not None else (a.scene.world_w * (0.3 if side == "left" else 0.7))
    speed = (430 if a.p["run"] else 190) * a.scale
    dur = max(0.3, abs(to - start) / speed)
    face = 1 if to >= start else -1
    a.key(0, "run" if a.p["run"] else "stand", x=start, face=face, fx="run" if a.p["run"] else "walk", visible=True, in_=0)
    a.key(dur, None, x=to, in_=dur, ease="lin")
    a.key(dur + 0.14, a.p["then"], in_=0.14)


@action("exit", params={"side": "right", "run": False}, doc="leave the picture (side: left|right)", choices={"side": ("left", "right")})
def exit_(a):
    side = str(a.p["side"])
    to = -110.0 if side == "left" else a.scene.world_w + 110.0
    speed = (430 if a.p["run"] else 190) * a.scale
    dur = max(0.3, abs(to - a.x) / speed)
    face = -1 if side == "left" else 1
    fxl = ["run" if a.p["run"] else "walk"]
    if face != a.face:
        _turn_keys(a, 0.0, a.face, face, 0.24, fx=_cur_fx(a.figure, a.t))
        fxl.append({"use": "turn", "t0": round(a.t, 4), "dur": 0.24, "from": a.face})
    a.key(0.1, "run" if a.p["run"] else "stand", face=face, fx=fxl, in_=0.1)
    a.key(dur, None, x=to, in_=dur - 0.1, ease="lin")
    a.key(dur + 0.02, None, visible=False, in_=0)


@action("jump", params={"to": None, "by": None, "height": 130, "dur": 0.55, "then": "stand"}, doc="jump on the spot or to an x position (height in px)")
def jump(a):
    to = a.p["to"]
    if to is None and a.p["by"] is not None:
        to = a.x + float(a.p["by"])
    x, face = _dir_to(a, to)
    if to is None:
        face = a.face
    d = max(0.15, float(a.p["dur"]))
    h = float(a.p["height"])
    x0 = a.x
    # crouch (anticipation) -> legs and arms extend while the feet are still on the floor (push-off)
    # -> flight: x at constant speed, y a parabola (keys at take-off, top and touch-down, linear
    # ease + arc h/4 on both halves gives exactly h * 4u(1-u)) -> touch down with the legs reaching
    # for the floor -> the knees give AFTER contact (landing absorbed) -> stand up
    a.key(0.14, "land", face=face, in_=0.14, ease="out")
    a.key(0.21, "stand", x=x0, in_=0.07, ease="in", T=-4, H=-8, RS=150, RE=10, LS=140, LE=12, RH=4, RK=0, LH=-4, LK=0)
    a.key(0.21 + d / 2, "jump", x=(x0 + x) / 2, y=h, in_=d / 2, ease="lin", arc=h / 4)
    a.key(0.21 + d, "stand", x=x, y=0, in_=d / 2, ease="lin", arc=h / 4, T=6, RS=60, RE=30, LS=50, LE=34, RH=18, RK=-14, LH=-6, LK=-10)
    a.key(0.21 + d + 0.09, "land", in_=0.09, ease="out")
    a.key(0.21 + d + 0.36, a.p["then"], in_=0.27)
    a.event(0.19, sfx="jump", gain=0.5)
    a.event(0.21 + d, sfx="land", gain=0.55)
    a.event(0.21 + d, burst="dust", x=x, y=a.floor - _ground(a), n=8, speed=120, life=0.45)


@action("climb", params={"height": 160, "dur": None, "speed": 70, "then": "hang", "over": 0},
        doc="climb up (a ladder, a wall) by height px; then: hang stays up there, stand / crouch with over: 40 steps onto the ledge")
def climb(a):
    h = float(a.p["height"])
    dur = a.p["dur"] if a.p.get("dur") else max(0.5, abs(h) / (float(a.p["speed"]) * a.scale))
    a.key(0.3, "climb", fx="climb", in_=0.3, ease="out")
    a.key(0.3 + dur, None, y=h, in_=dur, ease="lin")
    then = a.p.get("then") or "hang"
    end = 0.3 + dur
    top = {"y": h}
    if hasattr(type(a), "ground"):
        # what the figure now stands / hangs on: later keys stay up here instead of dropping to the floor
        top = {"ground": float(a.ground) + h}
    if str(then) != "climb":
        over = float(a.p.get("over") or 0) * a.face
        a.key(end + 0.35, then, x=a.x + over, in_=0.35, **top)
        end += 0.35
    else:
        a.key(end + 0.01, None, in_=0.01, **top)
    a.dur = end


@action("roll", params={"by": None, "to": None, "dir": "front", "dur": 0.8, "then": "stand"},
        doc="roll over on the floor (dir: front = forward roll, back = backward roll); by / to: where it ends",
        choices={"dir": ("front", "back")})
def roll(a):
    front = str(a.p["dir"]) != "back"
    d = max(0.3, float(a.p["dur"]))
    if a.p.get("to") is not None:
        x1 = float(a.p["to"])
    else:
        x1 = a.x + (float(a.p["by"]) if a.p.get("by") is not None else a.face * (150 if front else -110) * a.scale)
    sgn = 1 if front else -1
    x0 = a.x
    a.key(0.16, "crouch", in_=0.16, ease="out")
    # the tucked body turns once about its own middle while it travels; the lowest point of the ball
    # rests on the floor in every frame (skeleton.fk), so it rolls along the floor
    for i in range(1, 5):
        u = i / 4
        a.key(0.16 + d * u, "tuck" if i < 4 else "crouch", x=x0 + (x1 - x0) * u, rot=sgn * 90 * i, in_=d / 4, ease="lin" if 1 < i < 4 else ("in" if i == 1 else "out"))
    a.key(0.16 + d + 0.001, None, rot=0, in_=0)
    a.key(0.16 + d + 0.3, a.p["then"], in_=0.3)
    a.event(0.16 + d * 0.3, sfx="thud", gain=0.35)
    a.event(0.16 + d, burst="dust", x=x1, y=a.floor - _ground(a), n=6, speed=90, life=0.4)


# speed is px per second: 0 or less never gets anywhere (an error at the scene's line, not a crash)
for _n in ("walk", "run", "sneak", "crouch", "carry", "push", "pull", "crawl", "climb"):
    registry.ACTIONS[_n].ranges = {"speed": (1, None)}


# ---------------------------------------------------------------------------
# Fighting
# ---------------------------------------------------------------------------
_STRIKES = {
    # kind: (wind-up pose, strike pose, wind-up seconds, hit height, default sound, push px,
    #        striking limb ("arm" / "leg" / None = weapon: no IK), stretch at contact, reaction weight)
    "punch": ("punch_windup", "punch", 0.16, "head", "punch", 34, "arm", 0.94, 0.7),
    "jab": ("guard", "jab", 0.09, "head", "jab", 16, "arm", 0.93, 0.35),
    "uppercut": ("crouch", "uppercut", 0.2, "head", "punch", 30, "arm", 0.74, 0.9),
    "body": ("punch_windup", "punch", 0.16, "chest", "thud", 30, "arm", 0.92, 0.6),
    "kick": ("kick_windup", "kick", 0.2, "chest", "kick", 46, "leg", 0.92, 0.9),
    "highkick": ("kick_windup", "highkick", 0.22, "head", "kick", 50, "leg", 0.96, 1.0),
    "lowkick": ("kick_windup", "lowkick", 0.16, "knee", "kick", 14, "leg", 0.9, 0.5),
    "strike": ("overhead", "strike", 0.24, "head", "crash", 40, None, 0.0, 1.0),
    "swing": ("throw_windup", "swing", 0.22, "chest", "whoosh", 44, None, 0.0, 0.8),
}

# weapon strikes (no IK): how far in front of the attacker the weapon lands (px at scale 1)
_REACH = {"punch": 106, "jab": 94, "uppercut": 52, "body": 104, "kick": 98, "highkick": 82, "lowkick": 90, "strike": 95, "swing": 82}
# farther than this the attacker does not step in: the strike misses (px at scale 1)
_MAX_LUNGE = 190
# stances a hit figure returns to (anything else: guard)
_STANCES = {"stand", "guard", "hero", "block", "sneak", "zombie", "carry", "think", "point", "shrug"}


def _defense(a, target: str, dt: float) -> str | None:
    """"block" / "dodge" when the target is busy with one of these at dt (seconds after the action
    start). Uses ActionCtx.doing when the scene offers it, else the timeline resolved so far."""
    doing = getattr(a, "doing", None)
    act = None
    if callable(doing):
        try:
            act = doing(target, dt)
        except Exception:  # noqa: BLE001
            act = None
    else:
        t = a.t + dt
        for it in getattr(a.scene, "script", []):
            what = str(it.get("what", ""))
            if it.get("who") == target and what.startswith("do ") and it["t"] - 1e-6 <= t <= it["end"] + 1e-6:
                act = what.split()[1]
    return act if act in ("block", "dodge") else None


def _contact(tP: dict, part: str, face: int, kind: str) -> tuple[float, float]:
    """The point on the target's body the strike touches (its side towards the attacker)."""
    r = tP["_head_r"]
    if part == "head":
        hx, hy = tP["head"]
        if kind == "uppercut":
            return hx - face * r * 0.3, hy + r * 0.85         # under the chin
        if kind == "highkick":
            return hx - face * r * 0.75, hy + r * 0.45        # side of the jaw
        return hx - face * r * 0.8, hy
    if part == "knee":
        k = min((tP["Rknee"], tP["Lknee"]), key=lambda p: p[0] * face)
        return k[0] - face * 5 * tP["_scale"], k[1]
    if part == "hip":
        return tP["hip"][0] - face * 8 * tP["_scale"], tP["hip"][1]
    hip, neck = tP["hip"], tP["neck"]
    u = 0.4 if kind == "kick" else 0.62                   # a front kick goes into the belly, a punch the chest
    return hip[0] + (neck[0] - hip[0]) * u - face * 7 * tP["_scale"], hip[1] + (neck[1] - hip[1]) * u


def _root(limb: str) -> tuple[str, int]:
    return ("sho", 1) if limb == "arm" else ("hip", -1)


def _stand_off(a, hit: dict, limb: str, stretch: float, contact: tuple) -> float:
    """x at which the striking limb, rooted where the strike pose puts it, reaches `contact` stretched
    to `stretch` of its length (a punch lands with the arm almost straight)."""
    P = _joints(a, a.figure, {**hit, "x": 0.0})
    rx, ry = P[_root(limb)[0]]
    l1, l2 = _lengths(a.figure, limb)
    reach = stretch * (l1 + l2)
    dy = contact[1] - ry
    horiz = math.sqrt(max(0.0, reach * reach - dy * dy))
    return contact[0] - rx - hit["face"] * horiz


def _aim(a, hit: dict, limb: str, contact: tuple) -> tuple[dict, float]:
    """Angles that put the fist / foot of the strike pose on `contact` (two-bone IK), and the gap that
    is left (0 = it touches; > 0 = out of reach by that many px)."""
    P = _joints(a, a.figure, hit)
    root, bend = _root(limb)
    rx, ry = P[root]
    f = hit["face"]
    l1, l2 = _lengths(a.figure, limb)
    fwd, down = (contact[0] - rx) * f, contact[1] - ry
    ang, hinge = ik_limb(fwd, down, l1, l2, bend)
    gap = max(0.0, math.hypot(fwd, down) - (l1 + l2) * 0.999)
    if limb == "arm":
        return {"RS": ang - hit["T"], "RE": max(-10.0, hinge)}, gap
    return {"RH": ang, "RK": min(5.0, hinge)}, gap


def _plant_back_foot(a, hit: dict, x_from: float, st_from: dict) -> dict:
    """The far (back / supporting) leg of the strike pose re-solved so its foot stays where it stood
    before the step: the attacker steps in with the front foot instead of sliding on both."""
    P0 = _joints(a, a.figure, {**st_from, "x": x_from})
    P1 = _joints(a, a.figure, hit)
    l1, l2 = _lengths(a.figure, "leg")
    f = hit["face"]
    hip = P1["hip"]
    low = max(P1["Rfoot"][1], P1["Lfoot"][1])        # the floor level of the feet in the hit pose
    fwd, down = (P0["Lfoot"][0] - hip[0]) * f, low - hip[1]
    # a long step: the back foot stays as far back as the leg reaches and drags the rest of the way
    most = math.sqrt(max(0.0, (0.97 * (l1 + l2)) ** 2 - down * down))
    fwd = max(-most, min(most, fwd))
    lh, lk = ik_limb(fwd, down, l1, l2, -1)
    return {"LH": lh, "LK": min(5.0, lk)}


def _clear_reactions(fig, t_from: float) -> None:
    """Drop automatic reaction keys of an earlier hit that would play after a new hit lands (not those of
    a knock-out: a figure that is falling over stays falling)."""
    raw = getattr(fig, "raw", None)
    if raw is not None:
        raw[:] = [k for k in raw if not (k.get("_react") and not k.get("_ko") and k["t"] > t_from + 1e-6)]


def _mark_reaction(fig, n_before: int, group: str = "hit", ko: bool = False) -> None:
    """Mark the keys added since n_before as one automatic reaction (scene.Figure.end_reaction cuts it
    short when a move of the figure's own starts while it runs)."""
    for k in getattr(fig, "raw", [])[n_before:]:
        k["_react"] = group
        if ko:
            k["_ko"] = True


# moves that are not "doing something" while a hit lands: the defense ones are handled as defense
_DEFENSE = ("block", "dodge")


def _lead(do: str) -> float:
    """How long before its written time a move with a fixed time starts (a strike lands at its t)."""
    s = _STRIKES.get(do)
    return s[2] if s else 0.0


def _busy(a, tgt, target: str, imp: float, t_peak: float) -> str | None:
    """Why `target` cannot take an automatic reaction to a hit at imp (seconds after the action start):
    a text naming what it does then, or None when it is free. A move of its own still running at the
    impact, one that starts before the recoil would show, or a keyframe of its own right there. Moves
    that start later only cut the reaction short (scene: Figure.end_reaction)."""
    T, Tp = a.t + imp, a.t + t_peak + 0.15
    for s in getattr(tgt, "spans", []):
        if s["do"] in _DEFENSE:
            continue
        # still has keys to come once the recoil starts (its transition begins 0.07 s before the peak)
        if s["t0"] - 1e-6 <= T and any(kt > a.t + t_peak - 0.07 + 1e-6 for kt in s.get("keys", [])):
            return f'it is busy with its {s["do"]} ({s["where"]}, {s["t0"]:.2f}–{s["t1"]:.2f}s)'
    for p in getattr(tgt, "plans", []):
        if p["done"] or p["do"] in _DEFENSE:
            continue
        p0 = p["t"] - _lead(p["do"])
        if p0 <= Tp and p0 + max(p["guess"], 0.2) > T:
            return f'its {p["do"]} ({p["where"]}) starts at {p0:.2f}s, {"before" if p0 < T else "right after"} the impact'
    blend = float(getattr(a.scene, "blend", 0.22))
    for t, w in getattr(tgt, "user_keys", []):
        if t > T - 0.02 and t - blend <= Tp:
            return f"its own keyframe at {t:.2f}s ({w}) comes right after the impact"
    return None


def _spring(tau: float, zeta: float = 0.5, omega: float = 9.0) -> float:
    """A damped spring let go at 1 with no speed: 1 at tau = 0, back through 0 at ~0.2 s, a small
    overshoot below 0 and settled after ~0.6 s."""
    wd = omega * math.sqrt(1 - zeta * zeta)
    return math.exp(-zeta * omega * tau) * (math.cos(wd * tau) + zeta / math.sqrt(1 - zeta * zeta) * math.sin(wd * tau))


def _react(a, target: str, imp: float, kind: str, part: str, power: float, face: int, weight: float, push: float, ko: bool) -> None:
    """The target's reaction to a hit: a recoil added on top of what it was doing, scaled by the power
    of the hit, that springs back with a little overshoot (or a knock-out fall)."""
    tgt = a.other(target)
    _clear_reactions(tgt, a.t + imp)
    hs = HIT_STOP_FRAMES / max(a.scene.fps, 1)
    base = _posed(a, tgt, a.t + imp)
    if ko:
        # ko: true wins over the move the target is busy with: the rest of it is cut (a walk stops where
        # the figure got to, a wave or a talk breaks off) and it topples from there
        cut = getattr(tgt, "cut_move", None)
        for s in list(getattr(tgt, "spans", [])):
            if s["do"] not in (*_DEFENSE, "vanish", "wait") and s["t0"] - 1e-6 <= a.t + imp and callable(cut) and cut(s["where"], a.t + imp):
                a.warn(f'{target} is knocked out at {a.t + imp:.2f}s — the rest of its {s["do"]} ({s["where"]}) is cut')
    n0 = len(getattr(tgt, "raw", []))
    try:
        t_face = _parse_face(tgt.last("face", a.t + imp, 1), a.where)
    except Exception:  # noqa: BLE001
        t_face = -face
    facing_me = t_face == -face
    if facing_me:
        rpose = "recoil_fwd" if part in ("chest", "hip") else "stagger" if part == "knee" else "recoil"
    else:
        rpose = "recoil_fwd"
    R = _pose_data(rpose)
    B = _angles(base)
    w = min(1.4, power * weight)
    if ko:
        w = max(w, 1.15)
    delta = {n: _wrap(R[n] - B[n]) for n in ANGLES}
    tx = base["x"]
    shove = face * push * min(power, 2.0)
    emit = _emitter(a, target)
    t_peak = imp + hs + 0.07
    peak = {n: B[n] + delta[n] * w for n in ANGLES}
    if ko:
        # knocked out: whatever fx it had (a talk, a wave, a shiver) stops with the hit
        emit(t_peak, None, x=tx + shove * 0.75, in_=0.07, ease="snap", expr="hurt", fx="none", **peak)
        st = {**peak, "x": tx + shove * 0.75, "y": 0.0, "rot": 0.0, "face": t_face}
        t_hit = _topple(a, target, tgt, t_peak, st, back=facing_me, spin=1.2 + 0.5 * power)
        _mark_reaction(tgt, n0, f"{a.where}@{a.t + imp:.3f}", ko=True)
        kn = getattr(tgt, "knocked", None)
        if kn is not None:
            # until it lies on the floor its own moves wait (scene: they are skipped with a warning)
            kn.append({"t0": a.t + imp, "t1": a.t + t_hit + 0.14, "by": a.name, "do": kind, "where": a.where})
        return
    emit(t_peak, None, x=tx + shove * 0.75, in_=0.07, ease="snap", expr="hurt", **peak)
    # the recoil springs back: samples of a damped spring, linear in between (keys every ~0.1 s)
    prev = t_peak
    for tau in (0.1, 0.2, 0.31, 0.44):
        k = _spring(tau)
        ang = {n: B[n] + delta[n] * w * k for n in ANGLES}
        emit(t_peak + tau, None, x=tx + shove * (0.75 + 0.25 * min(1.0, tau / 0.2)), in_=t_peak + tau - prev, ease="io", **ang)
        prev = t_peak + tau
    back = base["_pose"] if base["_pose"] in _STANCES else "guard"
    emit(t_peak + 0.6, back, x=tx + shove + face * 4, in_=0.16, expr="angry" if facing_me else "surprised")
    _mark_reaction(tgt, n0, f"{a.where}@{a.t + imp:.3f}")


def _warned(a, start: str) -> bool:
    """This action already has a warning that begins with `start` (with or without "(line N)" after the path)."""
    items = getattr(a.scene, "warning_items", None)
    if items is not None:
        return any(i.get("where") == a.where and str(i.get("message", "")).startswith(start) for i in items)
    return any(w.startswith(f"{a.where}: {start}") for w in a.scene.warnings)


def _strike(a, start: float, kind: str, last: bool = True) -> float:
    """One strike beginning at `start` seconds into the action; returns the time of its impact."""
    wind_pose, hit_pose, wind, part0, snd, push, limb, stretch, weight = _STRIKES[kind]
    p = a.p
    target = str(p["target"]) if p.get("target") else None
    power = float(p.get("power", 1.0))
    part = str(p.get("part") or part0)
    face = a.face
    imp = start + wind
    hs = HIT_STOP_FRAMES / max(a.scene.fps, 1)
    x0 = a.x
    st_from = _posed(a, a.figure, a.t + start)
    move: dict = {}
    over: dict = {}
    wind_move: dict = {}
    reach = True
    defense = None
    if target:
        if target == a.name:
            raise _error(f'{a.where}: target is {a.name} itself — name the figure that gets hit')
        tgt = a.other(target)
        defense = _defense(a, target, imp)
        # a dodging target is aimed at where it stood: the blow goes into the empty air
        tst = _posed(a, tgt, a.t + (start if defense == "dodge" else imp))
        tx = tst["x"]
        face = 1 if tx >= a.x else -1
        tP = _joints(a, tgt, tst)
        contact = _contact(tP, part, face, kind)
        if defense == "block" and part == "head":
            # the blow stops on the forearms in front of the face, not on the face
            hand = min((tP["Rhand"], tP["Lhand"]), key=lambda q: q[0] * face)
            contact = (hand[0] - face * 6 * tgt.scale, hand[1] + 6 * tgt.scale)
        hit = {**_pose_data(hit_pose), "face": face, "y": 0.0, "x": a.x}
        if limb:
            want = _stand_off(a, hit, limb, stretch, contact)
        else:
            want = tx - face * _REACH[kind] * a.scale
        # step into range (or back out of a clinch) so the strike really lands
        if p.get("lunge", True) and abs(want - a.x) > 10 * a.scale:
            if abs(want - a.x) <= _MAX_LUNGE * a.scale:
                move = {"x": want}
                a.x = want
            else:
                reach = False
        hit["x"] = a.x
        if limb and reach:
            if move and limb == "arm":
                over.update(_plant_back_foot(a, {**hit}, x0, {**st_from, "face": face}))
                hit.update(over)
            elif move:
                # a kick skips forward on the standing foot while the knee comes up
                wind_move = {"x": x0 + (a.x - x0) * 0.7}
            aim, gap = _aim(a, hit, limb, contact)
            over.update(aim)
            if gap > 12 * a.scale:
                reach = False
                a.warn(f"the {kind} cannot reach {target}'s {part} ({gap:.0f} px short), so it misses and {target} does not react")
        elif not limb and not move and abs(want - a.x) > 40 * a.scale:
            reach = False
        if not reach and not _warned(a, f"the {kind} cannot reach"):
            a.warn(f'{a.name} is {abs(tx - x0):.0f} px away from {target} — the {kind} cannot reach, so it misses and {target} '
                   f'does not react (walk there first: {{do: walk, to: {target}}})')
    a.key(start, wind_pose, face=face, in_=min(0.12, wind), ease="out", expr="angry", **wind_move)
    a.key(imp, hit_pose, in_=min(0.1, wind), ease="snap", **move, **{k: round(v, 2) for k, v in over.items()})
    blocked = bool(target and reach and defense == "block")
    hits = bool(target and reach and defense is None)
    ko = bool(p.get("ko"))
    t_peak = imp + hs + 0.07
    # why the target takes no automatic reaction to this hit (None: it reacts)
    why = _no_reaction(a, tgt, imp, t_peak, ko) if hits and p.get("react", True) else None
    if why:
        a.warn(f"{target} does not react to the {kind} at {a.t + imp:.2f}s{' and is not knocked out' if ko else ''}: {why} "
               f"({'it has to get up first' if why.startswith(('it lies', 'it is already')) else 'move one of them'}, or react: false to silence this)")
    if target and reach:
        # hit-stop: the blow stays on the target for a moment
        a.key(imp + hs, None, in_=hs)
        if blocked:
            # bounce off the guard
            back = {**_pose_data(hit_pose), "face": face}
            a.key(imp + hs + 0.08, None, x=a.x - face * 7 * a.scale, in_=0.08, ease="out",
                  **{n: round(back[n] + (_pose_data(wind_pose)[n] - back[n]) * 0.35, 2) for n in ("RS", "RE", "RH", "RK", "T")})
        else:
            # follow through: the limb carries on a little where the target was
            a.key(imp + hs + 0.06, hit_pose, in_=0.06, ease="out", **{k: round(v, 2) for k, v in over.items() if k in ("LH", "LK")})
    if last:
        a.key(imp + 0.36, p.get("then") or "guard", expr="focus")
        a.dur = imp + 0.36
        if why and move and abs(a.x - tx) < abs(x0 - tx) - 1:
            # no recoil carries the target away: step back out of its body (no further than it came from)
            a.key(imp + 0.62, None, x=round(tx - face * min(abs(x0 - tx), 100 * a.scale), 2), in_=0.26)
            a.dur = imp + 0.62
    snd = p.get("sfx") or snd
    if not hits and not blocked:
        a.event(imp - 0.05, sfx="whoosh", gain=0.5)
        if p.get("word") and not target:
            a.event(imp, text=str(p["word"]), x=a.x + face * 110 * a.scale, y=a.floor - 200 * a.scale - _ground(a))
        return imp
    if blocked:
        bsnd = p.get("sfx") or ("block" if "block" in registry.SOUNDS else "knock")
        a.event(imp, hit={"on": target, "part": "hand" if part == "head" else part}, sfx=bsnd, shake=_shake(2 + 2 * power), gain=0.7, zoom=0.02,
                color="#e8f4ff", size=40)
        # only keys of the scene file itself stop the shove
        if p.get("react", True) and not any(a.t + start - 1e-6 <= t <= a.t + imp + 0.3 for t in getattr(tgt, "user_times", [])):
            ttx = a.x_of(target, imp)
            a.key_for(target, imp + hs + 0.08, None, x=ttx + face * (6 + 4 * power) * a.scale, in_=0.08, ease="out")
        return imp
    hit_ev = {"hit": {"on": target, "part": part}, "sfx": snd, "shake": _shake(6 + 6 * power), "gain": min(1.4, 0.7 + 0.3 * power)}
    if p.get("word"):
        hit_ev["word"] = str(p["word"])
    if power >= 1.5 or ko:
        hit_ev["flash"] = True
    a.event(imp, **hit_ev)
    # a strike that lands just outside the target's block or dodge: say so, with the real gap (it is easy
    # to miss by a frame)
    near = _near_defense(tgt, a.t + imp)
    if near:
        gap, side, do = near
        a.warn(f"the {kind} lands {gap:.2f}s {side} {target}'s {do} — it gets through (move the {do} or the strike)")
    if p.get("react", True) and not why:
        _react(a, target, imp, kind, part, power, face, weight, push * a.scale, ko)
    return imp


def _shake(v: float) -> float:
    """A camera shake the action makes, kept to what an event takes (0..300)."""
    return round(min(300.0, max(0.0, v)), 2)


def _ground(a) -> float:
    """What the acting figure stands on (px above the floor) when the action starts."""
    try:
        return float(getattr(a, "ground", 0.0) or 0.0)
    except Exception:  # noqa: BLE001  (an older scene without ground)
        return 0.0


def _no_reaction(a, tgt, imp: float, t_peak: float, ko: bool) -> str | None:
    """Why the target of a hit at imp takes no automatic reaction (a text), or None when it reacts.
    ko: true wins over the target's own moves (scene and _react cut or skip them, with a warning)."""
    T = a.t + imp
    knocked = getattr(tgt, "knocked_at", None)
    if callable(knocked) and knocked(T):
        return "it is already falling, knocked out"
    if _lying(_posed(a, tgt, T)) in ("back", "front"):
        return "it lies on the floor"
    if ko:
        return None
    return _busy(a, tgt, tgt.name, imp, t_peak)


def _near_defense(tgt, T: float) -> tuple | None:
    """(gap, "after" | "before", "block" | "dodge") when a hit at scene time T lands within 0.15 s of one
    of the target's blocks or dodges (the nearest one), else None."""
    best = None
    for s in getattr(tgt, "spans", []):
        if s["do"] in _DEFENSE and s["t1"] < T <= s["t1"] + 0.15 + 1e-6:
            c = (T - s["t1"], "after", s["do"])
            best = c if best is None or c[0] < best[0] else best
    for p in getattr(tgt, "plans", []):
        if not p["done"] and p["do"] in _DEFENSE and T < p["t"] <= T + 0.15 + 1e-6:
            c = (p["t"] - T, "before", p["do"])
            best = c if best is None or c[0] < best[0] else best
    return best


def _start(a, kind: str) -> float:
    # a fixed time is the moment of impact: begin the wind-up before it
    return -_STRIKES[kind][2] if a.explicit else 0.0


# power scales the hit: 0 (a touch) .. 5 (beyond that the shove and the camera shake fly off the scale)
_STRIKE_RANGES = {"power": (0, 5)}
_STRIKE_PARAMS = {"target": None, "power": 1.0, "word": None, "sfx": None, "part": None, "react": True, "ko": False, "lunge": True, "then": None}


def _strike_action(kind: str, doc: str):
    @action(kind, params=dict(_STRIKE_PARAMS), doc=doc, ranges=_STRIKE_RANGES)
    def fn(a, _kind=kind):
        _strike(a, _start(a, _kind), _kind)

    return fn


_strike_action("punch", "straight punch (target: figure → hit effect, sound and the target's reaction; ko: true knocks it down)")
_strike_action("jab", "quick punch from the guard")
_strike_action("uppercut", "punch from below")
_strike_action("kick", "front kick at the body")
_strike_action("highkick", "kick at the head")
_strike_action("lowkick", "kick at the legs")
_strike_action("strike", "overhead strike (good with a bat / sword in the hand)")
_strike_action("swing", "wide horizontal swing")


@action("combo", params={**_STRIKE_PARAMS, "moves": ["jab", "jab", "punch"], "gap": 0.32}, doc="several strikes in a row: moves: [jab, jab, kick], gap = seconds between hits (or 1b)", ranges=_STRIKE_RANGES)
def combo(a):
    moves = a.p["moves"] if isinstance(a.p["moves"], list) else [m.strip() for m in str(a.p["moves"]).split(",")]
    for m in moves:
        if m not in _STRIKES:
            raise _error(f'{a.where}: combo move "{m}" — one of: {", ".join(_STRIKES)}')
    if not moves:
        return
    gap = a.scene.clock.span(a.p["gap"], f"{a.where}.gap")
    ko = a.p.get("ko")
    start = _start(a, moves[0])
    first_imp = start + _STRIKES[moves[0]][2]
    for i, m in enumerate(moves):
        a.p["ko"] = bool(ko) and i == len(moves) - 1
        imp_time = first_imp + i * gap
        _strike(a, imp_time - _STRIKES[m][2], m, last=i == len(moves) - 1)


@action("block", params={"dur": 0.5, "then": "guard"}, doc="raise the forearms in front of the face for dur seconds (strikes that land meanwhile are stopped)")
def block(a):
    a.key(0.1, "block", in_=0.1, ease="snap", expr="focus")
    a.key(0.1 + a.p["dur"], None, in_=0)
    a.key(0.3 + a.p["dur"], a.p["then"])


@action("dodge", params={"style": "back", "dur": 0.35, "then": "guard"}, doc="evade (strikes that land meanwhile miss): style back (lean away) or duck",
        choices={"style": ("back", "duck")})
def dodge(a):
    if str(a.p["style"]) == "duck":
        a.key(0.1, "crouch", in_=0.1, ease="snap")
    else:
        a.key(0.1, "stagger", x=a.x - a.face * 40 * a.scale, in_=0.1, ease="snap", T=-28)
    a.key(0.1 + a.p["dur"], None, in_=0)
    a.key(0.32 + a.p["dur"], a.p["then"])
    a.event(0.02, sfx="whoosh", gain=0.35)


@action("hurt", params={"from": "front", "power": 1.0, "word": None, "sfx": "punch", "then": "guard"}, doc="take a hit without an attacker (from: front|back)",
        choices={"from": ("front", "back")}, ranges=_STRIKE_RANGES)
def hurt(a):
    front = str(a.p["from"]) != "back"
    power = float(a.p["power"])
    base = _posed(a, a.figure, a.t)
    B = _angles(base)
    R = _pose_data("recoil" if front else "recoil_fwd")
    w = min(1.4, 0.75 * power)
    push = -a.face * 30 * min(power, 2.0) * a.scale * (1 if front else -1)
    a.key(0.07, None, x=a.x + push * 0.75, in_=0.07, ease="snap", expr="hurt", **{n: B[n] + _wrap(R[n] - B[n]) * w for n in ANGLES})
    prev = 0.07
    for tau in (0.1, 0.2, 0.31, 0.44):
        k = _spring(tau)
        a.key(0.07 + tau, None, x=a.x + push, in_=0.07 + tau - prev, **{n: B[n] + _wrap(R[n] - B[n]) * w * k for n in ANGLES})
        prev = 0.07 + tau
    a.key(0.66, a.p["then"], in_=0.15)
    ev = {"hit": {"on": a.name, "part": "head"}, "sfx": a.p["sfx"], "shake": _shake(5 + 5 * power)}
    if a.p["word"]:
        ev["word"] = str(a.p["word"])
    a.event(0, **ev)


# ---------------------------------------------------------------------------
# Falling down and getting up
# ---------------------------------------------------------------------------
# limb positions half way through a fall: arms flung back over the head, knees giving way (backwards);
# arms reaching out to catch the fall (forwards)
_AIR_BACK = {"T": 18.0, "H": 24.0, "RS": -128.0, "RE": 30.0, "LS": -146.0, "LE": 34.0, "RH": 24.0, "RK": -34.0, "LH": -2.0, "LK": -22.0}
_AIR_FRONT = {"T": -8.0, "H": -36.0, "RS": 118.0, "RE": 12.0, "LS": 104.0, "LE": 16.0, "RH": 8.0, "RK": -14.0, "LH": -12.0, "LK": -26.0}


def _topple(a, name: str | None, fig, t0: float, st0: dict, back: bool = True, spin: float = 1.0) -> float:
    """Keys of `fig` falling over from st0 at t0 (seconds after the action start): the body turns
    about its planted feet faster and faster (theta'' = g/L sin theta), the hips hit the floor first,
    then the back and the head, with a small bounce. No y offset: the floor contact keeps the lowest
    part of the body on the floor all the way down. Returns the time of the impact."""
    emit = _emitter(a, name)
    face = int(st0.get("face", 1))
    sgn = -1.0 if back else 1.0
    end = "down" if back else "down_front"
    E = _pose_data(end)
    M = _AIR_BACK if back else _AIR_FRONT
    S = _angles(st0)
    # pivot: the middle of the feet stays where it is while the body turns over it
    P0 = _joints(a, fig, st0)
    pivot = (P0["Rfoot"][0] + P0["Lfoot"][0]) / 2
    # the fall itself: theta'' = k sin(theta), starting slightly tipped and pushed (spin, rad/s)
    k = 11.0
    th, om, t, dt = math.radians(5.0), max(0.3, spin), 0.0, 1 / 240
    marks = [18.0, 34.0, 50.0, 64.0, 77.0, 90.0]
    times = []
    while marks and t < 2.0:
        om += k * math.sin(th) * dt
        th += om * dt
        t += dt
        while marks and math.degrees(th) >= marks[0]:
            times.append((t, marks.pop(0)))
    prev = 0.0
    x_last = float(st0["x"])
    impact = {n: E[n] for n in ANGLES}
    impact["T"] = E["T"] + (16.0 if back else -12.0)      # the hips land first, the back a moment later
    for ti, deg in times:
        u = deg / 90.0
        if u <= 0.5:
            ang = {n: S[n] + _wrap(M[n] - S[n]) * (u / 0.5) for n in ANGLES}
        else:
            ang = {n: M[n] + _wrap(impact[n] - M[n]) * ((u - 0.5) / 0.5) for n in ANGLES}
        rot = sgn * deg
        Pl = _joints(a, fig, {**ang, "rot": rot, "face": face, "y": 0.0, "x": 0.0})
        x_last = pivot - (Pl["Rfoot"][0] + Pl["Lfoot"][0]) / 2
        emit(t0 + ti, None, x=round(x_last, 2), rot=round(rot, 2), y=0, in_=ti - prev, ease="lin",
             expr="hurt" if deg < 60 else "ko", **{n: round(v, 2) for n, v in ang.items()})
        prev = ti
    t_hit = t0 + prev
    # the back and head slap down, the body bounces a few px and settles
    emit(t_hit + 0.06, None, y=5 * fig.scale, in_=0.06, ease="out", T=E["T"])
    emit(t_hit + 0.14, end, x=round(x_last, 2), y=0, in_=0.08, ease="in", expr="ko")
    a.event(t_hit, sfx="thud", gain=0.9)
    a.event(t_hit, shake=8)
    # the dust flies where the body lands: on the table / ledge the falling figure stands on
    ground_at = getattr(fig, "ground_at", None)
    g = float(ground_at(a.t + t_hit)) if callable(ground_at) else 0.0
    a.event(t_hit, burst="dust", x=x_last, y=a.floor - g, n=12, speed=160, life=0.5)
    if name is None or name == a.name:
        a.dur = t_hit + 0.14
        a.x = x_last
    return t_hit


@action("fall", params={"dir": "back", "slide": 110}, doc="fall over and stay down (dir: back|front); slide: how far the body ends up from where it stood",
        choices={"dir": ("back", "front")})
def fall(a):
    back = str(a.p["dir"]) != "front"
    st0 = _posed(a, a.figure, a.t)
    # a stumble first: off balance, the feet shuffle on so that the body ends about `slide` away
    stumble = max(0.0, abs(float(a.p["slide"])) - 100.0 * a.scale) * (-a.face if back else a.face)
    pose = "stagger" if back else "recoil_fwd"
    a.key(0.16, pose, x=a.x + stumble, in_=0.16, expr="surprised")
    st = {**_pose_data(pose), "x": a.x + stumble, "face": a.face, "y": 0.0}
    _topple(a, None, a.figure, 0.16, st, back=back, spin=1.6)


def _lying(st: dict) -> str | None:
    r = float(st.get("rot", 0.0))
    if r <= -45:
        return "back"
    if r >= 45:
        return "front"
    return "sit" if st.get("_pose") in ("sit_floor", "slump", "lean_back") else None


@action("getup", params={"then": "stand"}, doc="get back on the feet after lying or sitting on the floor (rolls up, kneels, stands)")
def getup(a):
    st = _posed(a, a.figure, a.t)
    then = str(a.p["then"])
    face = st["face"]
    how = _lying(st)
    stages: list = []
    if how == "back":
        # sit up with a hand behind, rock forward over the feet into a squat, stand up
        stages = [("lean_back", 0.4, "hip"), ("crouch", 0.42, "feet"), (then, 0.42, "feet")]
    elif how == "front":
        # push the chest up, knees under, onto one knee, up
        stages = [("prone_push", 0.35, "Lfoot"), ("crawl", 0.3, "Rhand"), ("kneel", 0.35, "Lknee"), (then, 0.4, "Rfoot")]
    elif how == "sit":
        stages = [("lean_back", 0.25, "hip"), ("crouch", 0.42, "feet"), (then, 0.42, "feet")]
    elif st["_pose"] in ("crawl", "kneel", "crouch"):
        stages = [(then, 0.4, "Rfoot")]
    else:
        stages = [(then, 0.35, "feet")]
    t = 0.0
    cur = st
    for i, (pose, dur, anchor) in enumerate(stages):
        cur = _planted(a, t, {**cur, "face": face}, pose, dur, anchor, expr="hurt" if i < len(stages) - 1 else "calm")
        t += dur
    a.x = cur["x"]
    a.dur = t


def _legs_to(a, st: dict, x: float, feet: tuple, lift: tuple = (0.0, 0.0)) -> dict:
    """Leg angles that put the feet at world x feet[0] (near) / feet[1] (far) for a body at x, at the
    depth the legs of st reach now (lift: px the foot is off the floor, for a step)."""
    l1, l2 = _lengths(a.figure, "leg")
    f = st["face"]
    depth = max(l1 * math.cos(math.radians(st[s + "H"])) + l2 * math.cos(math.radians(st[s + "H"] + st[s + "K"])) for s in "RL")
    out = {}
    for s, fx, up in zip("RL", feet, lift):
        out[s + "H"], out[s + "K"] = ik_limb((fx - x) * f, depth - up, l1, l2, -1)
    return out


@action("sit", params={"at": None, "then": None},
        doc="sit down on a chair: the hips land at the figure's x (or at: x of the seat) — a step towards the seat, then the hips go back and down with the feet planted")
def sit(a):
    st = _posed(a, a.figure, a.t)
    if st["_pose"] in ("sit", "type", "sip"):
        return
    seat = float(a.p["at"]) if a.p.get("at") is not None else a.x
    fin = {**_pose_data("sit"), "face": a.face, "y": 0.0, "x": seat}
    Pf, P0 = _joints(a, a.figure, fin), _joints(a, a.figure, st)
    goal = (Pf["Rfoot"][0], Pf["Lfoot"][0])
    start = (P0["Rfoot"][0], P0["Lfoot"][0])
    lean = _pose_data("sit_lean")
    t = 0.0
    if max(abs(goal[0] - start[0]), abs(goal[1] - start[1])) > 6 * a.scale:
        # step to where the feet will be when seated: near foot, then far foot, each lifted on the way,
        # the hips following half way and the chest starting to lean
        mid_x = seat + (sum(goal) / 2 - seat) * 0.45
        steps = [((goal[0] + start[0]) / 2, start[1], 9.0, 0.0), (goal[0], start[1], 0.0, 0.0),
                 (goal[0], (goal[1] + start[1]) / 2, 0.0, 9.0), (goal[0], goal[1], 0.0, 0.0)]
        A = _angles(st)
        for i, (fr, fl, ur, ul) in enumerate(steps, 1):
            u = i / len(steps)
            x = a.x + (mid_x - a.x) * u
            ang = {k: A[k] + _wrap(lean[k] - A[k]) * 0.5 * u for k in ANGLES}
            body = {**ang, "face": a.face}
            ang.update(_legs_to(a, body, x, (fr, fl), (ur, ul)))
            a.key(0.08 * i, None, x=round(x, 2), in_=0.08, ease="io", **{k: round(v, 2) for k, v in ang.items()})
        t = 0.08 * len(steps)
        st = {**st, **ang, "x": mid_x}
    # hips back and down on an arc onto the seat (the chest leans forward on the way), feet planted
    cur = _planted(a, t, st, "sit_lean", 0.18, "feet", n=2)
    cur = _planted(a, t + 0.18, cur, "sit", 0.22, "feet", n=2)
    if a.p.get("then"):
        a.key(t + 0.8, a.p["then"])
    a.x = cur["x"]


@action("stand", params={}, doc="stand up / return to the neutral pose (from a chair: feet stay put; from the floor: gets up)")
def stand(a):
    st = _posed(a, a.figure, a.t)
    if _lying(st):
        a.p.setdefault("then", "stand")
        getup(a)
        return
    if st["_pose"] in ("sit", "type", "sip", "crouch", "kneel", "sit_lean", "pickup"):
        # lean forward over the feet, then push up — the feet stay where they are
        cur = _planted(a, 0.0, st, "sit_lean", 0.2, "Rfoot" if st["_pose"] == "kneel" else "feet", n=2)
        cur = _planted(a, 0.2, cur, "stand", 0.26, "feet", n=2)
        a.x = cur["x"]
        return
    a.key(0.35, "stand", in_=0.35)


# ---------------------------------------------------------------------------
# Gestures
# ---------------------------------------------------------------------------
def _gesture(name: str, pose_name: str, default_dur: float, doc: str, fx: str | None = None, expr: str | None = None):
    @action(name, params={"dur": default_dur, "then": "stand"}, doc=doc)
    def fn(a):
        kw = {}
        if fx:
            kw["fx"] = fx
        if expr:
            kw["expr"] = expr
        before = _expr_at(a.figure, a.t)
        a.key(0.22, pose_name, in_=0.22, **kw)
        a.key(0.22 + a.p["dur"], None, in_=0)
        # the expression of the gesture ends with it (a wave smiles while it waves, not forever)
        a.key(0.46 + a.p["dur"], a.p["then"], **({"expr": before} if expr else {}))

    return fn


_gesture("wave", "wave", 1.2, "wave with one arm", fx="wave", expr="happy")
_gesture("cheer", "cheer", 1.2, "both arms up, bouncing", fx="bounce", expr="happy")
_gesture("shrug", "shrug", 0.7, "shrug the shoulders")
_gesture("think", "think", 1.5, "hand at the chin", expr="focus")
_gesture("facepalm", "facepalm", 1.2, "hand over the face", expr="sad")
_gesture("bow", "bow", 0.8, "bow")
_gesture("salute", "salute", 0.9, "salute")
_gesture("laugh", "hero", 1.4, "shake with laughter", fx="laugh", expr="happy")
_gesture("type", "type", 2.0, "type on a keyboard (sitting)", fx="type", expr="focus")
_gesture("talk", "stand", 1.5, "gesture while speaking (beat gestures with the hands, head nods)", fx="talk")
_gesture("clap", "clap", 1.0, "clap the hands", fx={"use": "nod", "amount": 0.5}, expr="happy")


def _facing(a, v, param: str) -> int:
    """The facing that `v` asks for: towards a figure (its name) or left / right (any case). Anything else
    is an error with a did-you-mean — a misspelled name must not turn the figure the wrong way."""
    if str(v) in a.scene.figures:
        return 1 if a.x_of(str(v)) >= a.x else -1
    s = str(v).strip().lower()
    if s in ("left", "l"):
        return -1
    if s in ("right", "r"):
        return 1
    from .scene import SceneError, _close, _dym

    options = ["left", "right", *a.scene.figures]
    close = _close(v, options)
    raise SceneError(f'{param} must be left, right or a figure name, got "{v}"{_dym(close)} (figures: {", ".join(a.scene.figures)})',
                     where=f"{a.where}.{param}", code="unknown-figure", got=v, suggest=close)


@action("point", params={"at": None, "dur": 0.9, "then": "stand"}, doc="point forward, or at a figure (at: name | left | right)")
def point(a):
    face = a.face if a.p["at"] is None else _facing(a, a.p["at"], "at")
    if face != a.face:
        _turn_keys(a, 0.0, a.face, face, 0.18)
    a.key(0.2, "point", face=face, in_=0.2, ease="snap")
    a.key(0.2 + a.p["dur"], None, in_=0)
    a.key(0.44 + a.p["dur"], a.p["then"])


@action("nod", params={"times": 2}, doc="nod the head", ranges={"times": (1, None)})
def nod(a):
    n = max(1, int(a.p["times"]))  # a scene with times: 0 or -3 gets an error (ranges)
    for i in range(n):
        a.key(0.14 + i * 0.3, None, H=14, in_=0.14)
        a.key(0.3 + i * 0.3, None, H=0, in_=0.14)


@action("turn", params={"to": None, "dur": 0.22}, doc="turn around (or to: left | right | a figure); the body turns through a front view over dur seconds")
def turn(a):
    to = a.p["to"]
    face = -a.face if to is None else _facing(a, to, "to")
    dur = max(0.05, float(a.p["dur"]))
    _turn_keys(a, 0.0, a.face, face, dur)
    a.dur = dur


# ---------------------------------------------------------------------------
# Dance
# ---------------------------------------------------------------------------
# A dance move is two beats. Per beat: the upper body (T H RS RE LS LE), where the hips are (dx,
# sideways in the facing direction, px) and where the feet stand (fR, fL, px from the dance spot).
# The legs are solved so the feet are really there (steps), the pose is hit ON the beat.
_STAND_FEET = (11.0, -11.0)
_MOVES = {
    "step": [((-4, -6, 30, 60, -20, 50), 14, (40, -11)), ((4, 6, -20, 50, 30, 60), 0, (11, -11)),
             ((4, 6, -20, 50, 30, 60), -14, (11, -40)), ((-4, -6, 30, 60, -20, 50), 0, (11, -11))],
    "sway": [((-10, 12, 40, 90, -30, 40), 8, _STAND_FEET), ((10, -12, -30, 40, 40, 90), -8, _STAND_FEET)],
    "arms": [((-6, -10, 160, 10, 150, 14), 0, (20, -20)), ((0, 4, 100, 20, 95, 24), 0, (20, -20))],
    "clap": [((4, -6, 70, 80, 64, 86), 0, _STAND_FEET), ((-2, -10, 40, 70, 34, 74), 0, _STAND_FEET)],
    "point": [((-6, -14, 160, 5, -20, 60), 6, (24, -11)), ((10, 14, 60, 0, 0, 40), -6, (11, -24))],
    "roll": [((22, 10, 40, 40, 30, 40), -6, _STAND_FEET), ((-14, -12, -10, 30, -20, 30), 6, _STAND_FEET)],
    "turn": [((0, -6, 60, 80, 60, 80), 0, _STAND_FEET), ((0, -6, 140, 10, 135, 12), 0, _STAND_FEET)],
}


def _legs_for(a, upper: tuple, dx: float, feet: tuple, face: int, depth: float) -> dict:
    l1, l2 = _lengths(a.figure, "leg")
    out = {}
    for s, fx in zip("RL", feet):
        out[s + "H"], out[s + "K"] = ik_limb((fx - dx) * a.scale, depth, l1, l2, -1)
    return out


@action("dance", params={"dur": None, "beats": 8, "moves": None},
        doc="dance on the beat (beats: how many, or dur seconds); moves: [step, sway, arms, clap, point, roll, turn] (default: a mix)")
def dance(a):
    beat = a.beat
    n = int(a.p["dur"] / beat) if a.p["dur"] else int(a.p["beats"])
    n = max(1, n)
    moves = a.p.get("moves")
    if moves is not None:
        moves = moves if isinstance(moves, list) else [m.strip() for m in str(moves).split(",") if m.strip()]
        for m in moves:
            if m not in _MOVES:
                raise _error(f'{a.where}: dance move "{m}" — one of: {", ".join(_MOVES)}')
    else:
        # a seeded mix: the same scene always dances the same, two figures dance differently
        names = list(_MOVES)
        seed = sum(ord(c) for c in a.name)
        moves, beats, i = [], 0, 0
        while beats < n:
            m = names[int(hash01(i, seed, a.t) * len(names))]
            if not (m == "turn" and not moves) and not (moves and m == moves[-1]):
                moves.append(m)
                beats += len(_MOVES[m])
            i += 1
    if not moves:
        moves = ["sway"]
    # beats are counted from the bar grid when the scene has a bpm, so the hits land on the music
    off = (-a.t) % beat if a.scene.clock.beat else 0.0
    if off > beat * 0.6:
        off -= beat
    off = max(0.0, off)
    face = a.face
    x0 = a.x
    depth = 0.9 * sum(_lengths(a.figure, "leg"))
    fxl = [{"use": "bounce", "amount": 0.7, "hop": 0.0}]
    seq = [(m, j, st) for m in moves for j, st in enumerate(_MOVES[m])]
    a.key(0.02, None, fx=fxl, in_=0.02)
    for i in range(n):
        mv, j, (upper, dx, feet) = seq[i % len(seq)]
        t = off + i * beat
        kw = dict(zip(("T", "H", "RS", "RE", "LS", "LE"), (float(v) for v in upper)))
        kw.update(_legs_for(a, upper, dx, feet, face, depth))
        if mv == "turn" and j == 1:
            # a full turn on the spot over this beat
            _turn_keys(a, t - beat * 0.45, face, -face, beat * 0.4, fx=fxl)
            face = -face
            fxl = list(fxl)
        a.key(max(t, 0.06), None, x=x0 + dx * face * a.scale, in_=beat * 0.35, ease="snap", expr="happy", fx=fxl, **{k: round(v, 2) for k, v in kw.items()})
    if face != a.face:
        _turn_keys(a, off + n * beat - beat * 0.3, face, a.face, beat * 0.4, fx=fxl)
    a.key(off + n * beat + 0.25, "stand", x=x0, face=a.face, expr=_expr_at(a.figure, a.t))


@action("throw", params={"dur": 0.3, "then": "stand"}, doc="throwing movement (move the thrown prop with its own keys)")
def throw(a):
    a.key(0.18, "throw_windup", in_=0.18, ease="out")
    a.key(0.18 + a.p["dur"], "throw", in_=0.1, ease="snap")
    a.key(0.6 + a.p["dur"], a.p["then"])
    a.event(0.16 + a.p["dur"], sfx="whoosh", gain=0.5)


@action("pickup", params={"dur": 0.4, "then": "stand"}, doc="bend down and reach the floor (hands at the floor in front of the feet), then come up")
def pickup(a):
    cur = _planted(a, 0.0, _posed(a, a.figure, a.t), "pickup", 0.36, "feet")
    a.key(0.36 + float(a.p["dur"]), None, in_=0)
    if a.p.get("then"):
        _planted(a, 0.36 + float(a.p["dur"]), cur, str(a.p["then"]), 0.36, "feet")


@action("appear", params={"x": None, "pose": "stand"}, doc="pop into the scene with a puff of smoke")
def appear(a):
    x = float(a.p["x"]) if a.p["x"] is not None else a.x
    a.key(0, a.p["pose"], x=x, visible=True, in_=0)
    a.event(0, burst="smoke", x=x, y=a.floor - 100 * a.scale - _ground(a), n=16, speed=140, life=0.6)
    a.event(0, sfx="pop", gain=0.7)
    a.dur = 0.2


@action("vanish", params={}, doc="disappear in a puff of smoke")
def vanish(a):
    a.key(0.02, None, visible=False, in_=0)
    a.event(0, burst="smoke", x=a.x, y=a.floor - 100 * a.scale - _ground(a), n=16, speed=140, life=0.6)
    a.event(0, sfx="pop", gain=0.7)
    a.dur = 0.2


@action("wait", params={"dur": 1.0}, doc="do nothing for dur seconds (keeps the current pose)")
def wait(a):
    a.dur = float(a.p["dur"])
