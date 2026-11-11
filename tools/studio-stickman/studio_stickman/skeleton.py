"""The stick figure: joint angles -> joint positions, easing, colors.

A pose is ten angles in degrees (0 = the limb hangs straight down / the body is upright;
positive = towards the side the figure faces):

  T   torso lean                    H   head tilt (relative to the torso)
  RS  near arm at the shoulder      RE  near elbow bend
  LS  far arm at the shoulder       LE  far elbow bend
  RH  near leg at the hip           RK  near knee bend (negative = bent like a real knee)
  LH  far leg at the hip            LK  far knee bend

"near" (R…) limbs are drawn in front, "far" (L…) limbs behind the body. Besides the angles a
figure has a position: x (feet on the floor), y (height above the floor), rot (the whole body
turned, 90 = lying), face (1 = looks right, -1 = looks left).
"""
from __future__ import annotations

import math

ANGLES = ["T", "H", "RS", "RE", "LS", "LE", "RH", "RK", "LH", "LK"]
# body dimensions in world pixels for scale 1 (a figure is ~215 px tall)
DIMS = {"torso": 78.0, "neck": 8.0, "head": 19.0, "upper_arm": 42.0, "forearm": 40.0, "thigh": 50.0, "shin": 50.0}
STAND = {"T": 0, "H": 0, "RS": 8, "RE": 14, "LS": -8, "LE": 14, "RH": 6, "RK": -4, "LH": -6, "LK": -4}

EASES = {
    "io": lambda u: u * u * (3 - 2 * u),          # smooth start and stop (default)
    "lin": lambda u: u,
    "in": lambda u: u * u,                         # slow start
    "out": lambda u: 1 - (1 - u) ** 2,             # slow stop
    "snap": lambda u: 1 - (1 - u) ** 4,            # hits the pose fast, then settles
    "hold": lambda u: 1.0 if u >= 1 else 0.0,      # jump cut at the end
    "bounce": lambda u: 1 - abs(math.cos(u * math.pi * 1.5)) * (1 - u),
    "back": lambda u: 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2,   # overshoots a little
}


def ease(name: str, u: float) -> float:
    u = 0.0 if u < 0 else 1.0 if u > 1 else u
    return EASES.get(name, EASES["io"])(u)


def _down(a: float, f: int) -> tuple[float, float]:
    r = math.radians(a)
    return (math.sin(r) * f, math.cos(r))


def _up(a: float, f: int) -> tuple[float, float]:
    r = math.radians(a)
    return (math.sin(r) * f, -math.cos(r))


def fk(st: dict, floor: float, scale: float = 1.0, build: dict | None = None) -> dict:
    """Joint positions (world px) for a state: the ten angles + x, y, rot, face."""
    d = {k: v * scale for k, v in {**DIMS, **(build or {})}.items()}
    f = 1 if st.get("face", 1) >= 0 else -1
    P: dict = {"hip": (0.0, 0.0)}
    u = _up(st["T"], f)
    P["sho"] = (u[0] * d["torso"] * 0.9, u[1] * d["torso"] * 0.9)
    P["neck"] = (u[0] * d["torso"], u[1] * d["torso"])
    hu = _up(st["T"] + st["H"], f)
    P["head"] = (P["neck"][0] + hu[0] * (d["neck"] + d["head"]), P["neck"][1] + hu[1] * (d["neck"] + d["head"]))
    for s in "RL":
        a1 = st["T"] + st[s + "S"]
        e = _down(a1, f)
        P[s + "elb"] = (P["sho"][0] + e[0] * d["upper_arm"], P["sho"][1] + e[1] * d["upper_arm"])
        h = _down(a1 + st[s + "E"], f)
        P[s + "hand"] = (P[s + "elb"][0] + h[0] * d["forearm"], P[s + "elb"][1] + h[1] * d["forearm"])
        k = _down(st[s + "H"], f)
        P[s + "knee"] = (k[0] * d["thigh"], k[1] * d["thigh"])
        fo = _down(st[s + "H"] + st[s + "K"], f)
        P[s + "foot"] = (P[s + "knee"][0] + fo[0] * d["shin"], P[s + "knee"][1] + fo[1] * d["shin"])
    rot = math.radians(st.get("rot", 0) * f)
    if rot:
        c, s_ = math.cos(rot), math.sin(rot)
        for n in list(P):
            x, y = P[n]
            P[n] = (x * c - y * s_, x * s_ + y * c)
    # the lowest point of the body rests on the floor (so any pose "stands" by itself)
    low = max(P[n][1] for n in P if not n.endswith("hand") and n != "head")
    low = max(low, P["head"][1] + d["head"] - 3 * scale)
    y0 = floor - 5 * scale - low - st.get("y", 0)
    for n in P:
        P[n] = (P[n][0] + st["x"], P[n][1] + y0)
    P["_head_r"] = d["head"]
    P["_head_ang"] = (st["T"] + st["H"]) * f + st.get("rot", 0) * f
    P["_face"] = f
    P["_scale"] = scale
    # forearm / shin directions (for props in the hand, shoes)
    for s in "RL":
        P[s + "arm_ang"] = math.degrees(math.atan2(P[s + "hand"][1] - P[s + "elb"][1], P[s + "hand"][0] - P[s + "elb"][0]))
    return P


def lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def hash01(*a: float) -> float:
    """Deterministic pseudo random number in [0, 1) from numbers (same input, same output)."""
    x = 0
    for v in a:
        x = ((x * 1000003) ^ int(v * 1000 + 7919)) & 0xFFFFFFFF
    x = ((x ^ (x >> 13)) * 0x5BD1E995) & 0xFFFFFFFF
    return ((x ^ (x >> 15)) & 0xFFFFFF) / 0x1000000


# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
NAMED = {
    "black": (16, 16, 20), "white": (245, 245, 245), "red": (220, 60, 60), "green": (70, 190, 110), "blue": (70, 130, 230),
    "yellow": (250, 210, 60), "orange": (245, 150, 50), "purple": (160, 110, 230), "pink": (240, 120, 180), "cyan": (60, 200, 220),
    "gray": (130, 135, 145), "grey": (130, 135, 145), "brown": (140, 95, 60), "navy": (28, 44, 92), "teal": (40, 150, 140),
    "gold": (240, 200, 60), "silver": (190, 195, 205), "skin": (236, 188, 150), "ink": (24, 24, 28),
}


def color(c, default=(24, 24, 28)) -> tuple:
    """"#rgb", "#rrggbb", "#rrggbbaa", a name, or [r, g, b(, a)] -> an RGB(A) tuple."""
    if c is None:
        return tuple(default)
    if isinstance(c, (list, tuple)) and 3 <= len(c) <= 4:
        return tuple(int(max(0, min(255, v))) for v in c)
    s = str(c).strip().lower()
    if s in NAMED:
        return NAMED[s]
    if s.startswith("#"):
        h = s[1:]
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h)
        if len(h) in (6, 8):
            try:
                return tuple(int(h[i : i + 2], 16) for i in range(0, len(h), 2))
            except ValueError:
                pass
    raise ValueError(f'"{c}" is not a color (use #rrggbb, [r, g, b] or a name: {", ".join(sorted(NAMED))})')


def shade(c: tuple, amount: float) -> tuple:
    """Darker (amount < 0) or lighter (amount > 0) version of a color; keeps alpha."""
    rgb = [int(max(0, min(255, v + amount))) for v in c[:3]]
    return tuple(rgb) + tuple(c[3:])


def mix(a: tuple, b: tuple, u: float) -> tuple:
    return tuple(int(round(a[i] + (b[i] - a[i]) * u)) for i in range(3))


def luminance(c: tuple) -> float:
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
