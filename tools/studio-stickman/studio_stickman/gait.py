"""Walking, running and sneaking with planted feet.

A travelling figure gets a footstep plan for the stretch it covers (where each foot lands, one
foot after the other) and its legs are solved with two-bone inverse kinematics, so the foot on
the ground stays exactly where it was put while the body moves over it — no sliding. The stretch
starts and ends with the feet a little apart under the hip (like the `stand` pose), the swinging
foot lifts in an arc, the hip rises over the supporting leg (walk) or dips into it (run), and the
arms swing against the legs.

Used by the walk / run / sneak motions (poses.py) whenever the figure's x changes between two
keyframes; a figure that walks on the spot keeps the old time-based stride.
"""
from __future__ import annotations

import math

# per gait: step length, hip height and foot lift (× leg length), hip rise over the supporting leg
# (× leg length; negative = dips), arm swing and elbow bend (degrees), forward lean (degrees)
GAITS = {
    "walk": {"step": 0.74, "hip": 0.905, "lift": 0.13, "bob": 0.045, "arm": 20.0, "elbow": 10.0, "lean": 2.0},
    "run": {"step": 1.0, "hip": 0.85, "lift": 0.36, "bob": -0.035, "arm": 34.0, "elbow": 58.0, "lean": 9.0},
    "sneak": {"step": 0.52, "hip": 0.82, "lift": 0.27, "bob": 0.0, "arm": 7.0, "elbow": 26.0, "lean": 5.0},
}
STANCE = 0.12  # half the distance between the feet when standing (× leg length)


def ik_leg(fwd: float, down: float, l1: float, l2: float) -> tuple[float, float]:
    """Hip and knee angle (degrees, pose convention: 0 = straight down, + = towards the facing
    side, knee negative = bent like a real knee) that put the foot `fwd` in front of and `down`
    below the hip. Out of reach: the leg points at the target, straight."""
    d = math.hypot(fwd, down)
    d = min(max(d, abs(l1 - l2) + 1e-3, 1e-3), (l1 + l2) * 0.9995)
    phi = math.atan2(fwd, down)
    a = math.acos(max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))))
    b = math.acos(max(-1.0, min(1.0, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))))
    return math.degrees(phi + a), -math.degrees(math.pi - b)


def _smooth(u: float) -> float:
    u = 0.0 if u < 0 else 1.0 if u > 1 else u
    return u * u * (3 - 2 * u)


def plan(dist: float, leg: float, kind: str) -> dict | None:
    """Footsteps for covering `dist` px: plants (positions along the way, 0 = start) and the hip
    positions at which each swing begins and ends. None: too short to take a step."""
    g = GAITS[kind]
    c = STANCE * leg
    if dist < 2 * c + 4:
        return None
    s0 = g["step"] * leg
    n = max(1, round((dist - 2 * c) / s0))           # steps between the first and the last plant
    sp = (dist - 2 * c) / n
    # plant k (k >= 1) of the swing foot; p[0] is where the front foot already stands, p[-1] the back foot
    p = {-1: -c, 0: c}
    for k in range(1, n + 1):
        p[k] = c + k * sp
    p[n + 1] = dist + c                               # the closing step lands just in front of the hip
    m = n + 1                                          # number of swings
    h = [0.0] + [(p[k - 1] + p[k]) / 2 for k in range(1, m)] + [dist]
    return {"p": p, "h": h, "m": m, "step": sp, "c": c}


def feet(pl: dict, s: float) -> tuple[tuple[float, float], tuple[float, float], float]:
    """Where the two feet are when the hip is `s` along the way: ((front, lift), (back, lift), u) —
    front = the foot that stood in front at the start (the near leg), lift 0..1, u = how far the
    current step is (0..1; at 0.5 the hip is over the supporting foot)."""
    p, h, m = pl["p"], pl["h"], pl["m"]
    s = min(max(s, 0.0), h[-1])
    k = 1
    while k < m and s > h[k]:
        k += 1
    span = h[k] - h[k - 1]
    u = (s - h[k - 1]) / span if span > 1e-9 else 1.0
    swing_from, swing_to = p[k - 2], p[k]
    swing = (swing_from + (swing_to - swing_from) * _smooth(u), math.sin(math.pi * min(max(u, 0.0), 1.0)))
    stance = (p[k - 1], 0.0)
    # odd swings move the back foot, even swings the front one
    return ((stance, swing) if k % 2 == 1 else (swing, stance)) + (min(max(u, 0.0), 1.0),)


def apply(st: dict, kind: str, ctx: dict, weight: float) -> bool:
    """Legs (and arm swing, lean) of a travelling figure. False: not travelling — caller falls back."""
    run = ctx.get("run")
    if not run or st.get("rot", 0) != 0:
        return False
    x0, x1 = run
    dist = abs(x1 - x0)
    l1, l2 = ctx.get("thigh", 50.0), ctx.get("shin", 50.0)
    leg = l1 + l2
    pl = plan(dist, leg, kind)
    if pl is None:
        return False
    g = GAITS[kind]
    dirn = 1.0 if x1 >= x0 else -1.0
    s = (st["x"] - x0) * dirn
    (fa, la), (fb, lb), u = feet(pl, s)
    # the hip rises (walk) or dips (run) while it passes over the supporting foot
    hip = (g["hip"] + g["bob"] * math.sin(math.pi * u)) * leg
    lift = g["lift"] * leg
    face = 1.0 if st.get("face", 1) >= 0 else -1.0
    to_facing = dirn * face                           # walking backwards: the steps go behind
    out = {}
    for side, (pos, up) in (("R", (fa, la)), ("L", (fb, lb))):
        fwd = (pos - s) * to_facing
        out[side + "H"], out[side + "K"] = ik_leg(fwd, hip - up * lift, l1, l2)
        out[side] = max(-1.0, min(1.0, fwd / max(pl["step"] / 2, 1e-6)))
    w = max(0.0, min(1.0, weight))
    for a in ("RH", "RK", "LH", "LK"):
        st[a] += (out[a] - st[a]) * w
    # arms swing against the legs around the middle of the pose's two arms (a "run" pose has them
    # mid-stride already); elbows and lean at least as much as the gait needs, never doubled up
    centre = (st["RS"] + st["LS"]) / 2
    targets = {
        "RS": centre - g["arm"] * out["R"],
        "LS": centre - g["arm"] * out["L"],
        "RE": max(st["RE"], g["elbow"]),
        "LE": max(st["LE"], g["elbow"]),
        "T": max(st["T"], g["lean"]),
    }
    for a, v in targets.items():
        st[a] += (v - st[a]) * w
    return True
