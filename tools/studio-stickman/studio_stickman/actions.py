"""Built-in actions: `do: walk`, `do: punch` … — small choreographies that expand into keyframes
(and sounds / hit effects / the other figure's reaction).

Timing: a strike written with a fixed time (`t: 4.5` or `t: "5:1"`) LANDS at that time — the
wind-up happens just before, so hits sit on the beat. Without a time (or with "+0.5") an action
starts when the previous item of the figure ended.
"""
from __future__ import annotations

from .api import action


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
            from .scene import SceneError

            raise SceneError(f'{a.where}: "to" must be an x position or a figure name, got "{to}"') from None
    return x, (1 if x >= a.x else -1)


def _travel(a, pose: str, fx: str, speed: float) -> None:
    by = a.p.get("by")
    to = a.p.get("to")
    if to is None and by is not None:
        to = a.x + float(by)
    x, face = _dir_to(a, to)
    dist = abs(x - a.x)
    dur = a.p["dur"] if a.p.get("dur") else max(0.25, dist / (speed * a.scale))
    if a.p.get("backwards"):
        face = -face
    a.key(0.1, pose, face=face, fx=fx, in_=0.1)
    a.key(dur, None, x=x, in_=max(dur - 0.1, 0.01), ease="lin")
    a.key(dur + 0.14, a.p["then"], in_=0.14)
    a.dur = dur + 0.14


@action("walk", params={"to": None, "by": None, "dur": None, "speed": 190, "gap": 90, "backwards": False, "then": "stand"},
        doc="walk to an x position or up to a figure (to: 600 | to: cop), or by a distance (by: -200)")
def walk(a):
    _travel(a, "stand", "walk", float(a.p["speed"]))


@action("run", params={"to": None, "by": None, "dur": None, "speed": 430, "gap": 100, "backwards": False, "then": "stand"},
        doc="run to an x position or up to a figure")
def run(a):
    _travel(a, "run", "run", float(a.p["speed"]))


@action("sneak", params={"to": None, "by": None, "dur": None, "speed": 90, "gap": 90, "backwards": False, "then": "sneak"},
        doc="creep to an x position or up to a figure")
def sneak(a):
    _travel(a, "sneak", "sneak", float(a.p["speed"]))


@action("enter", params={"side": "left", "to": None, "run": False, "then": "stand"}, doc="come in from outside the picture (side: left|right) to x")
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


@action("exit", params={"side": "right", "run": False}, doc="leave the picture (side: left|right)")
def exit_(a):
    side = str(a.p["side"])
    to = -110.0 if side == "left" else a.scene.world_w + 110.0
    speed = (430 if a.p["run"] else 190) * a.scale
    dur = max(0.3, abs(to - a.x) / speed)
    a.key(0.1, "run" if a.p["run"] else "stand", face=-1 if side == "left" else 1, fx="run" if a.p["run"] else "walk", in_=0.1)
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
    d = float(a.p["dur"])
    h = float(a.p["height"])
    a.key(0.12, "land", face=face, in_=0.12, ease="out")
    a.key(0.12 + d / 2, "jump", x=(a.x + x) / 2, y=h, in_=d / 2, ease="out")
    a.key(0.12 + d, "land", x=x, y=0, in_=d / 2, ease="in")
    a.key(0.34 + d, a.p["then"], in_=0.2)
    a.event(0.1, sfx="jump", gain=0.5)
    a.event(0.12 + d, sfx="land", gain=0.55)
    a.event(0.12 + d, burst="dust", x=x, y=a.floor, n=8, speed=120, life=0.45)


# ---------------------------------------------------------------------------
# Fighting
# ---------------------------------------------------------------------------
_STRIKES = {
    # kind: (wind-up pose, strike pose, wind-up seconds, hit height, default sound, push px)
    "punch": ("punch_windup", "punch", 0.16, "head", "punch", 34),
    "jab": ("guard", "jab", 0.09, "head", "jab", 16),
    "uppercut": ("crouch", "uppercut", 0.2, "head", "punch", 30),
    "body": ("punch_windup", "punch", 0.16, "chest", "thud", 30),
    "kick": ("kick_windup", "kick", 0.2, "chest", "kick", 46),
    "highkick": ("kick_windup", "highkick", 0.22, "head", "kick", 50),
    "lowkick": ("kick_windup", "lowkick", 0.16, "knee", "kick", 14),
    "strike": ("overhead", "strike", 0.24, "head", "crash", 40),
    "swing": ("throw_windup", "swing", 0.22, "chest", "whoosh", 44),
}


# how far in front of the attacker the fist / foot ends up (px at scale 1): where to stand to hit
_REACH = {"punch": 106, "jab": 94, "uppercut": 52, "body": 104, "kick": 98, "highkick": 82, "lowkick": 90, "strike": 95, "swing": 82}


def _strike(a, start: float, kind: str, last: bool = True) -> float:
    """One strike beginning at `start` seconds into the action; returns the time of its impact."""
    wind_pose, hit_pose, wind, part, snd, push = _STRIKES[kind]
    p = a.p
    target = str(p["target"]) if p.get("target") else None
    power = float(p.get("power", 1.0))
    face = a.face
    move = {}
    if target:
        a.other(target)
        tx = a.x_of(target, start)
        face = 1 if tx >= a.x else -1
        # step into range (or back out of a clinch) so the strike really lands
        reach = _REACH[kind] * a.scale
        want = tx - face * reach
        if p.get("lunge", True) and abs(want - a.x) > 10:
            if abs(want - a.x) <= 190 * a.scale:
                move = {"x": want}
                a.x = want
            else:
                a.warn(f'{a.name} is {abs(tx - a.x):.0f} px away from {target} — the {kind} cannot reach (walk there first: {{do: walk, to: {target}}})')
    imp = start + wind
    a.key(start, wind_pose, face=face, in_=min(0.12, wind), ease="out", expr="angry")
    a.key(imp, hit_pose, in_=min(0.1, wind), ease="snap", **move)
    if last:
        a.key(imp + 0.36, p.get("then") or "guard", expr="focus")
        a.dur = imp + 0.36
    snd = p.get("sfx") or snd
    if not target:
        a.event(imp - 0.05, sfx="whoosh", gain=0.5)
        if p.get("word"):
            a.event(imp, text=str(p["word"]), x=a.x + face * 110 * a.scale, y=a.floor - 200 * a.scale)
        return imp
    hit = {"hit": {"on": target, "part": p.get("part") or part}, "sfx": snd, "shake": 6 + 6 * power, "gain": min(1.4, 0.7 + 0.3 * power)}
    if p.get("word"):
        hit["word"] = str(p["word"])
    if power >= 1.5 or p.get("ko"):
        hit["flash"] = True
    a.event(imp, **hit)
    if p.get("react", True) and a.free(target, start, imp + 0.6):
        tx = a.x_of(target, imp)
        t_face = a.other(target).last("face", a.t + imp, 1)
        t_face = 1 if str(t_face) in ("1", "right", "r") else -1
        facing_me = t_face == -face
        pose = ("recoil_fwd" if part == "chest" else "recoil") if facing_me else "recoil_fwd"
        nx = tx + face * push * power
        if p.get("ko"):
            a.key_for(target, imp + 0.07, pose, x=nx, in_=0.07, ease="snap", expr="hurt")
            a.key_for(target, imp + 0.4, "fall", x=nx + face * 50, y=30, in_=0.3, ease="out", expr="hurt")
            a.key_for(target, imp + 0.7, "down" if facing_me else "down_front", x=nx + face * 100, in_=0.3, ease="in", expr="ko")
            a.event(imp + 0.7, sfx="thud", gain=0.9)
            a.event(imp + 0.7, shake=8)
            a.event(imp + 0.7, burst="dust", x=nx + face * 100, y=a.floor, n=12, speed=160, life=0.5)
        else:
            a.key_for(target, imp + 0.07, pose, x=nx, in_=0.07, ease="snap", expr="hurt")
            a.key_for(target, imp + 0.6, "guard" if facing_me else "stagger", x=nx + face * 8, expr="angry")
    return imp


def _start(a, kind: str) -> float:
    # a fixed time is the moment of impact: begin the wind-up before it
    return -_STRIKES[kind][2] if a.explicit else 0.0


_STRIKE_PARAMS = {"target": None, "power": 1.0, "word": None, "sfx": None, "part": None, "react": True, "ko": False, "lunge": True, "then": None}


def _strike_action(kind: str, doc: str):
    @action(kind, params=dict(_STRIKE_PARAMS), doc=doc)
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


@action("combo", params={**_STRIKE_PARAMS, "moves": ["jab", "jab", "punch"], "gap": 0.32}, doc="several strikes in a row: moves: [jab, jab, kick], gap = seconds between hits (or 1b)")
def combo(a):
    from .scene import SceneError

    moves = a.p["moves"] if isinstance(a.p["moves"], list) else [m.strip() for m in str(a.p["moves"]).split(",")]
    for m in moves:
        if m not in _STRIKES:
            raise SceneError(f'{a.where}: combo move "{m}" — one of: {", ".join(_STRIKES)}')
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


@action("block", params={"dur": 0.5, "then": "guard"}, doc="raise the arms for dur seconds")
def block(a):
    a.key(0.1, "block", in_=0.1, ease="snap", expr="focus")
    a.key(0.1 + a.p["dur"], None, in_=0)
    a.key(0.3 + a.p["dur"], a.p["then"])


@action("dodge", params={"style": "back", "dur": 0.35, "then": "guard"}, doc="evade: style back (lean away) or duck")
def dodge(a):
    if str(a.p["style"]) == "duck":
        a.key(0.1, "crouch", in_=0.1, ease="snap")
    else:
        a.key(0.1, "stagger", x=a.x - a.face * 40, in_=0.1, ease="snap", T=-28)
    a.key(0.1 + a.p["dur"], None, in_=0)
    a.key(0.32 + a.p["dur"], a.p["then"])
    a.event(0.02, sfx="whoosh", gain=0.35)


@action("hurt", params={"from": "front", "power": 1.0, "word": None, "sfx": "punch", "then": "guard"}, doc="take a hit without an attacker (from: front|back)")
def hurt(a):
    front = str(a.p["from"]) != "back"
    power = float(a.p["power"])
    a.key(0.07, "recoil" if front else "recoil_fwd", x=a.x - a.face * 30 * power * (1 if front else -1), in_=0.07, ease="snap", expr="hurt")
    a.key(0.6, a.p["then"])
    ev = {"hit": {"on": a.name, "part": "head"}, "sfx": a.p["sfx"], "shake": 5 + 5 * power}
    if a.p["word"]:
        ev["word"] = str(a.p["word"])
    a.event(0, **ev)


@action("fall", params={"dir": "back", "slide": 110}, doc="fall over and stay down (dir: back|front)")
def fall(a):
    back = str(a.p["dir"]) != "front"
    s = float(a.p["slide"]) * (-a.face if back else a.face)
    a.key(0.16, "stagger" if back else "recoil_fwd", in_=0.16, expr="surprised")
    a.key(0.46, "fall" if back else "pickup", x=a.x + s * 0.5, y=24, in_=0.3, ease="out", expr="hurt")
    a.key(0.74, "down" if back else "down_front", x=a.x + s, in_=0.28, ease="in", expr="ko")
    a.event(0.74, sfx="thud", gain=0.9)
    a.event(0.74, shake=7)
    a.event(0.74, burst="dust", x=a.x + s, y=a.floor, n=12, speed=160, life=0.5)


@action("getup", params={"then": "stand"}, doc="get back on the feet after lying down")
def getup(a):
    a.key(0.45, "crouch", in_=0.45, expr="hurt")
    a.key(0.9, a.p["then"], in_=0.4, expr="calm")


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
        a.key(0.22, pose_name, in_=0.22, **kw)
        a.key(0.22 + a.p["dur"], None, in_=0)
        a.key(0.46 + a.p["dur"], a.p["then"])

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
_gesture("talk", "stand", 1.5, "gesture while speaking", fx="talk")


@action("point", params={"at": None, "dur": 0.9, "then": "stand"}, doc="point forward, or at a figure (at: name)")
def point(a):
    kw = {}
    if a.p["at"] is not None and str(a.p["at"]) in a.scene.figures:
        kw["face"] = 1 if a.x_of(str(a.p["at"])) >= a.x else -1
    a.key(0.2, "point", in_=0.2, ease="snap", **kw)
    a.key(0.2 + a.p["dur"], None, in_=0)
    a.key(0.44 + a.p["dur"], a.p["then"])


@action("nod", params={"times": 2}, doc="nod the head")
def nod(a):
    n = max(1, int(a.p["times"]))
    for i in range(n):
        a.key(0.14 + i * 0.3, None, H=14, in_=0.14)
        a.key(0.3 + i * 0.3, None, H=0, in_=0.14)


@action("turn", params={"to": None}, doc="turn around (or to: left | right | a figure)")
def turn(a):
    to = a.p["to"]
    if to is None:
        face = -a.face
    elif str(to) in a.scene.figures:
        face = 1 if a.x_of(str(to)) >= a.x else -1
    else:
        face = -1 if str(to).lower().startswith("l") else 1
    a.key(0.08, None, face=face, in_=0)
    a.dur = 0.1


@action("sit", params={}, doc="sit down (chair height)")
def sit(a):
    a.key(0.35, "sit", in_=0.35)


@action("stand", params={}, doc="stand up / return to the neutral pose")
def stand(a):
    a.key(0.35, "stand", in_=0.35)


@action("dance", params={"dur": None, "beats": 8}, doc="dance on the beat (beats: how many; or dur seconds)")
def dance(a):
    beat = a.beat
    n = int(a.p["dur"] / beat) if a.p["dur"] else int(a.p["beats"])
    for i in range(max(1, n)):
        a.key(i * beat + beat * 0.5, "dance1" if i % 2 == 0 else "dance2", in_=beat * 0.45, fx="bounce", expr="happy", face=a.face if (i // 4) % 2 == 0 else -a.face)
    a.key(max(1, n) * beat + 0.25, "stand", face=a.face)


@action("throw", params={"dur": 0.3, "then": "stand"}, doc="throwing movement (move the thrown prop with its own keys)")
def throw(a):
    a.key(0.18, "throw_windup", in_=0.18, ease="out")
    a.key(0.18 + a.p["dur"], "throw", in_=0.1, ease="snap")
    a.key(0.6 + a.p["dur"], a.p["then"])
    a.event(0.16 + a.p["dur"], sfx="whoosh", gain=0.5)


@action("appear", params={"x": None, "pose": "stand"}, doc="pop into the scene with a puff of smoke")
def appear(a):
    x = float(a.p["x"]) if a.p["x"] is not None else a.x
    a.key(0, a.p["pose"], x=x, visible=True, in_=0)
    a.event(0, burst="smoke", x=x, y=a.floor - 100 * a.scale, n=16, speed=140, life=0.6)
    a.event(0, sfx="pop", gain=0.7)
    a.dur = 0.2


@action("vanish", params={}, doc="disappear in a puff of smoke")
def vanish(a):
    a.key(0.02, None, visible=False, in_=0)
    a.event(0, burst="smoke", x=a.x, y=a.floor - 100 * a.scale, n=16, speed=140, life=0.6)
    a.event(0, sfx="pop", gain=0.7)
    a.dur = 0.2


@action("wait", params={"dur": 1.0}, doc="do nothing for dur seconds (keeps the current pose)")
def wait(a):
    a.dur = float(a.p["dur"])
