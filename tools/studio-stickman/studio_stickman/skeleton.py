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


# How far the hinge joints can bend (degrees). An elbow cannot bend backwards past straight, a knee
# cannot bend forwards, a neck turns the head about 70 degrees each way. fk clamps the state to these
# after all fx ran, so a wobble added on top of a pose (wave, zap, talk …) never breaks a joint.
LIMITS = {"RE": (-10.0, 160.0), "LE": (-10.0, 160.0), "RK": (-165.0, 5.0), "LK": (-165.0, 5.0), "H": (-70.0, 70.0)}

# Body parts that can rest on the floor, and how far their drawn outline reaches below the joint
# (px at scale 1): the sole under a foot, a kneecap, the buttocks, the back. The head adds its radius.
CONTACTS = (("Rfoot", 5.0), ("Lfoot", 5.0), ("Rknee", 5.0), ("Lknee", 5.0), ("hip", 6.0), ("sho", 6.0), ("neck", 6.0))
# Hands and elbows do not hold the body up (a hand put "through" the floor would otherwise lift the whole
# figure off its feet); instead the arm folds up onto the floor, so they never sink either.
SOFT = {"elb": 4.5, "hand": 5.0}


def limit(st: dict) -> dict:
    """Clamp the hinge joints of a state to LIMITS (in place; returns st)."""
    for n, (lo, hi) in LIMITS.items():
        v = st.get(n)
        if v is not None and not lo <= v <= hi:
            st[n] = lo if v < lo else hi
    return st


def ik_limb(fwd: float, down: float, l1: float, l2: float, bend: int) -> tuple[float, float]:
    """Two-bone inverse kinematics in the pose convention (0 = straight down, + = towards the facing
    side): the root angle (world) and the hinge angle that put the end `fwd` px in front of and `down`
    px below the root. bend = +1: hinge bends forwards (an elbow), -1: backwards (a knee). Out of
    reach: the limb points at the target, straight."""
    dist = math.hypot(fwd, down)
    dist = min(max(dist, abs(l1 - l2) + 1e-3, 1e-3), (l1 + l2) * 0.9995)
    phi = math.atan2(fwd, down)
    a = math.acos(max(-1.0, min(1.0, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist))))
    b = math.acos(max(-1.0, min(1.0, (l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2))))
    if bend > 0:
        return math.degrees(phi - a), math.degrees(math.pi - b)
    return math.degrees(phi + a), -math.degrees(math.pi - b)


def _fold(P: dict, root: str, mid: str, end: str, floor: float, r_mid: float, r_end: float, side: float) -> None:
    """Swing a limb about its root, then its lower part about the middle joint, just far enough that
    neither goes below the floor (an arm thrown over the head while lying ends up lying on the floor)."""
    for a, b, rb, moved in ((root, mid, r_mid, (mid, end)), (mid, end, r_end, (end,))):
        ax, ay = P[a]
        bx, by = P[b]
        lim = floor - rb
        if by <= lim:
            continue
        ln = math.hypot(bx - ax, by - ay)
        if ln < 1e-6:
            continue
        dy = min(lim - ay, ln)
        if dy < -ln:
            continue
        sx = (1.0 if bx >= ax else -1.0) if abs(bx - ax) > 1e-6 else side
        nx, ny = ax + sx * math.sqrt(max(0.0, ln * ln - dy * dy)), ay + dy
        # rotate everything below the joint by the same angle
        da = math.atan2(ny - ay, nx - ax) - math.atan2(by - ay, bx - ax)
        c, s = math.cos(da), math.sin(da)
        for n in moved:
            px, py = P[n][0] - ax, P[n][1] - ay
            P[n] = (ax + px * c - py * s, ay + px * s + py * c)


def fk(st: dict, floor: float, scale: float = 1.0, build: dict | None = None) -> dict:
    """Joint positions (world px) for a state: the ten angles + x, y, rot, face.

    The hinge joints are clamped to LIMITS (in st, so whatever draws from st sees the same angles).
    Contact with the floor: the lowest of the CONTACTS (feet, knees, buttocks, back, head) rests on the
    floor, `y` lifts the body above that; hands and elbows that would go through the floor fold up
    onto it instead. A face between -1 and 1 (a turn in progress) squeezes the body sideways."""
    d = {k: v * scale for k, v in {**DIMS, **(build or {})}.items()}
    limit(st)
    face = st.get("face", 1)
    f = 1 if face >= 0 else -1
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
    # a turn in progress (face between -1 and 1): the body is seen more and more from the front
    squeeze = abs(face)
    if squeeze < 1.0:
        squeeze = max(0.12, squeeze)
        for n in P:
            P[n] = (P[n][0] * squeeze, P[n][1])
    rot = math.radians(st.get("rot", 0) * f)
    if rot:
        c, s_ = math.cos(rot), math.sin(rot)
        for n in list(P):
            x, y = P[n]
            P[n] = (x * c - y * s_, x * s_ + y * c)
    # the lowest contact rests on the floor (so any pose "stands", "sits" or "lies" by itself)
    low = P["head"][1] + d["head"] + 1.0 * scale
    for n, r in CONTACTS:
        v = P[n][1] + r * scale
        if v > low:
            low = v
    lift = st.get("y", 0)
    y0 = floor - low - lift
    x0 = st["x"]
    for n in P:
        P[n] = (P[n][0] + x0, P[n][1] + y0)
    if lift > -0.5:
        # arms (and legs of a body resting on its back or knees) never go through the floor
        for s in "RL":
            if P[s + "hand"][1] > floor - SOFT["hand"] * scale or P[s + "elb"][1] > floor - SOFT["elb"] * scale:
                _fold(P, "sho", s + "elb", s + "hand", floor, SOFT["elb"] * scale, SOFT["hand"] * scale, f)
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
