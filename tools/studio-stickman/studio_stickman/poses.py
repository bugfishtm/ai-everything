"""Built-in poses and motions (continuous modifiers used with `fx:`)."""
from __future__ import annotations

import math

from . import gait
from .api import motion, pose
from .skeleton import ANGLES, DIMS, hash01, ik_limb

# name: (T, H, RS, RE, LS, LE, RH, RK, LH, LK), doc, extras
# Arm angles are relative to the torso (an arm that hangs while the body bends forward by T has
# RS = -T); leg angles are relative to straight down. Elbows stay in -10..160, knees in -165..5.
_P = {
    "stand":        ((0, 0, 8, 14, -8, 14, 6, -4, -6, -4), "relaxed standing"),
    "hero":         ((-4, -6, -24, 68, -30, 74, 12, -4, -12, -4), "upright, hands on the hips"),
    "guard":        ((12, -5, 35, 105, 55, 95, 28, -22, -22, -12), "fighting stance, fists up"),
    "block":        ((6, -14, 78, 98, 66, 108, 25, -20, -25, -10), "forearms up in front of the face"),
    "punch_windup": ((-10, -4, -55, 120, 45, 85, 24, -18, -24, -10), "fist pulled back"),
    "punch":        ((28, 6, 92, 2, -25, 70, 40, -34, -28, -4), "straight punch, arm fully out"),
    "jab":          ((14, 0, 88, 4, 50, 95, 26, -20, -22, -10), "quick punch from the guard"),
    "uppercut":     ((-8, -12, 140, 40, 30, 80, 20, -10, -20, -14), "fist driven upwards"),
    "overhead":     ((-15, -5, 195, 25, 185, 30, 22, -15, -25, -10), "both arms raised behind the head (before a strike)"),
    "strike":       ((35, 10, 100, 5, 20, 60, 42, -35, -25, -5), "arm swung down in front"),
    "swing":        ((22, 5, 125, 0, -40, 25, 32, -22, -25, -5), "wide horizontal swing"),
    "kick_windup":  ((-6, 0, -20, 50, 35, 70, 80, -100, -4, -6), "knee pulled up"),
    "kick":         ((-22, 0, -30, 40, 40, 60, 98, -5, -5, -5), "front kick at hip height"),
    "highkick":     ((-32, 5, -40, 30, 50, 50, 132, -4, -8, -8), "kick at head height"),
    "lowkick":      ((-10, 4, -25, 40, 35, 60, 62, -8, -10, -12), "kick at shin height"),
    "recoil":       ((-32, -35, -55, 35, -115, 40, 30, -10, -25, -25), "hit from the front: upper body thrown back"),
    "recoil_fwd":   ((28, 40, 60, 10, 110, 30, 18, -30, -18, -5), "hit in the stomach: doubled over"),
    "stagger":      ((-18, -25, -30, 60, 40, 80, -12, -30, 25, -40), "off balance"),
    "fall":         ((-50, -30, -100, 20, -130, 30, 60, -40, 30, -50), "falling backwards, limbs up"),
    "brace":        ((40, -40, 120, 10, 105, 15, 20, -10, -25, -20), "falling forwards, arms out to catch the fall"),
    "down":         ((0, 29, -168, 24, -150, 30, 30, -61, 3, -3), "lying on the back", {"rot": -90}),
    "down_front":   ((0, -29, 172, 12, 162, 20, -2, -4, -4, -62), "lying face down", {"rot": 90}),
    "sit":          ((4, 0, 15, 70, 10, 70, 90, -90, 84, -84), "sitting on a chair (thighs level)"),
    "sit_floor":    ((-15, 8, -18, 5, -24, 6, 100, -22, 96, -18), "sitting on the floor, legs out, hands behind"),
    "crouch":       ((45, -25, 60, 60, 50, 70, 95, -125, 70, -130), "low crouch"),
    "kneel":        ((6, 0, 20, 30, -10, 25, 90, -90, -2, -88), "one knee on the floor"),
    "type":         ((18, -6, 40, 35, 36, 40, 90, -90, 84, -84), "sitting, hands on a keyboard"),
    "sip":          ((10, -14, 40, 35, 20, 150, 90, -90, 84, -84), "sitting, cup at the mouth (far hand)"),
    "point":        ((4, 0, 88, 0, -10, 20, 8, -4, -8, -4), "arm straight out, pointing forward"),
    "wave":         ((0, -4, 150, 25, -8, 14, 6, -4, -6, -4), "one arm up"),
    "cheer":        ((-5, -10, 160, 10, 155, 12, 10, -4, -10, -4), "both arms up (also: hands up)"),
    "shrug":        ((0, 6, 32, 112, 28, 116, 6, -4, -6, -4), "forearms out, palms up"),
    "think":        ((4, 10, 30, 140, 20, 60, 6, -4, -6, -4), "hand at the chin"),
    "facepalm":     ((8, 26, 36, 152, -5, 12, 6, -4, -6, -4), "hand over the face"),
    "bow":          ((62, 10, -56, 8, -62, 8, 4, -2, -4, -2), "deep bow, arms hanging"),
    "salute":       ((0, -2, 102, 128, -6, 10, 4, -2, -4, -2), "hand at the forehead"),
    "run":          ((16, -4, -40, 80, 50, 80, 35, -40, -25, -50), "mid stride (use with fx: run)"),
    "sneak":        ((30, -15, 40, 70, 30, 80, 45, -60, -10, -50), "bent forward, careful"),
    "jump":         ((5, -5, 150, 5, 140, 8, 50, -80, 20, -70), "in the air, legs tucked"),
    "land":         ((30, -10, 30, 40, 20, 50, 70, -100, 50, -100), "absorbing a landing"),
    "carry":        ((10, -5, 80, 15, 75, 20, 25, -15, -20, -10), "both arms forward, holding something"),
    "push":         ((30, 0, 58, 12, 52, 16, 45, -40, -30, -5), "leaning into a push, arms out level"),
    "pull":         ((-25, 0, 102, 20, 96, 26, 30, -10, -10, -30), "leaning back, pulling"),
    "throw_windup": ((-20, -5, -120, 60, 60, 40, 25, -15, -25, -10), "arm back before a throw"),
    "throw":        ((30, 5, 110, 5, -30, 40, 40, -30, -25, -5), "arm released forward"),
    "pickup":       ((74, -40, -66, 8, -72, 10, 72, -112, 40, -98), "bent down, hands at the floor"),
    "dance1":       ((-8, -8, 140, 10, -40, 60, 30, -40, -10, -4), "dance move, near arm up"),
    "dance2":       ((8, 8, -40, 60, 140, 10, -10, -4, 30, -40), "dance move, far arm up"),
    "zombie":       ((10, 15, 85, 5, 80, 8, 10, -6, -8, -6), "arms out, stiff"),
    "slump":        ((-25, 30, -10, 10, 10, 10, 98, -18, 93, -5), "collapsed against something, legs out"),
    "hang":         ((0, 8, 178, 4, 176, 6, 4, -8, -4, -10), "hanging from the hands"),
    "crawl":        ((80, -62, -82, 4, -76, 6, 4, -92, -6, -86), "on hands and knees (use with do: crawl)"),
    "climb":        ((4, -14, 165, 30, 150, 60, 60, -95, 10, -30), "climbing: hands up on a ladder, one knee up"),
    "tuck":         ((55, 25, 20, 100, 10, 110, 145, -150, 135, -145), "rolled into a ball (rolls, somersaults)"),
    "sit_lean":     ((34, -16, 30, 40, 24, 44, 60, -80, 54, -74), "half way down to a seat: hips back, chest forward"),
    "prone_push":   ((0, -36, 90, 4, 84, 8, -2, -4, -4, -6), "face down, arms pushing the chest up", {"rot": 72}),
    "lean_back":    ((-45, 30, -8, 6, -14, 8, 120, -60, 110, -40), "sitting up from lying, a hand on the floor behind"),
    "clap":         ((4, -6, 70, 80, 64, 86, 6, -4, -6, -4), "hands together in front of the chest"),
    "disco":        ((-6, -14, 160, 5, -20, 60, 18, -24, -10, -4), "near hand points up to the sky"),
}

# Poses that stand on both feet: after the angles above, the higher foot is put down on the floor with
# leg IK (keeping where it stands), so a fighting stance does not hover on its back toes.
_PLANT = {"stand", "hero", "guard", "block", "punch_windup", "punch", "jab", "uppercut", "overhead", "strike", "swing",
          "recoil", "point", "shrug", "think", "facepalm", "bow", "salute", "carry", "push", "pull", "throw_windup",
          "throw", "zombie", "clap", "land", "crouch", "sit", "type", "sip", "pickup"}


def _plant(a: dict) -> dict:
    """Both feet on the floor: re-solve the leg whose foot is higher so it reaches the same depth at
    the same x; when it cannot reach that far, both legs bend a little and the hips drop."""
    l1, l2 = DIMS["thigh"], DIMS["shin"]

    def foot(h: float, k: float) -> tuple[float, float]:
        r1, r2 = math.radians(h), math.radians(h + k)
        return l1 * math.sin(r1) + l2 * math.sin(r2), l1 * math.cos(r1) + l2 * math.cos(r2)

    (xr, yr), (xl, yl) = foot(a["RH"], a["RK"]), foot(a["LH"], a["LK"])
    if abs(yr - yl) < 0.5:
        return a
    hi = "L" if yl < yr else "R"
    depth = max(yr, yl)
    xs = {"R": xr, "L": xl}
    reach2 = (0.985 * (l1 + l2)) ** 2 - xs[hi] ** 2
    if reach2 >= depth * depth:
        a[hi + "H"], a[hi + "K"] = ik_limb(xs[hi], depth, l1, l2, -1)
    else:
        depth = math.sqrt(max(reach2, 1.0))
        for s in "RL":
            a[s + "H"], a[s + "K"] = ik_limb(xs[s], depth, l1, l2, -1)
    for n in ("RH", "RK", "LH", "LK"):
        a[n] = round(a[n], 1)
    return a


for _name, _v in _P.items():
    _angles = dict(zip(ANGLES, _v[0]))
    if _name in _PLANT:
        _plant(_angles)
    if len(_v) > 2:
        _angles.update(_v[2])
    pose(_name, doc=_v[1], **_angles)

TAU = 2 * math.pi


@motion("idle", params={"amount": 1.0}, doc="breathing — tiny movement so a still figure looks alive (default when no fx is set)")
def idle(st, t, p, ctx):
    a = p["amount"]
    ph = t * TAU * 0.28 + ctx.get("phase", 0)
    st["T"] += math.sin(ph) * 1.2 * a
    st["H"] += math.sin(ph + 0.6) * 1.0 * a
    st["RS"] += math.sin(ph + 1.1) * 1.6 * a
    st["LS"] -= math.sin(ph + 1.1) * 1.6 * a


@motion("still", doc="no movement at all (switches the breathing off)")
def still(st, t, p, ctx):
    return


def _stride(st, t, ctx, amp, freq, lift, lean, arm):
    ph = TAU * t * freq + ctx.get("phase", 0)
    s = math.sin(ph)
    st["RH"] += amp * s
    st["LH"] -= amp * s
    st["RK"] -= amp * 0.9 * max(0.0, -math.sin(ph + 0.6))
    st["LK"] -= amp * 0.9 * max(0.0, math.sin(ph + 0.6))
    st["RS"] -= arm * s
    st["LS"] += arm * s
    st["y"] += abs(s) * lift
    st["T"] += lean


# A crouched walk (do: crouch, to: …) is the sneak gait with the hips much lower and short steps.
# gait.py plans any kind listed in GAITS, so the new kind only has to be added to the table.
gait.GAITS.setdefault("crouch", {"step": 0.42, "hip": 0.66, "lift": 0.16, "bob": 0.0, "arm": 6.0, "elbow": 40.0, "lean": 26.0})

_ARMS = ("RS", "LS", "RE", "LE")


def _gait_fx(st: dict, t: float, p: dict, ctx: dict, kind: str, stride: tuple) -> None:
    """Legs of walk/run/sneak; `arms` (0..1) says how much the arms swing — 0 keeps the arms of the
    pose, so a figure can walk while it carries, points, guards or talks (do: walk, upper: carry)."""
    arms = float(p.get("arms", 1.0))
    keep = [st[n] for n in _ARMS] if arms < 1.0 else None
    if not gait.apply(st, kind, ctx, ctx.get("gait_w", 1.0)):
        _stride(st, t, ctx, *stride)
    if keep is not None:
        for n, v in zip(_ARMS, keep):
            st[n] = v + (st[n] - v) * arms


# While x changes, walk/run/sneak plan real footsteps (gait.py: feet stay planted on the floor);
# on the spot (x does not change) the legs swing in time instead (speed = steps per second factor).
@motion("walk", params={"speed": 1.0, "arms": 1.0}, doc="steps with planted feet while x changes (do: walk does this for you); on the spot: legs swing; arms: 0 keeps the pose's arms")
def walk(st, t, p, ctx):
    _gait_fx(st, t, p, ctx, "walk", (26, 1.9 * p["speed"], 3, 2, 18))


@motion("run", params={"speed": 1.0, "arms": 1.0}, doc="running stride with a forward lean, feet planted while x changes")
def run(st, t, p, ctx):
    _gait_fx(st, t, p, ctx, "run", (44, 3.2 * p["speed"], 10, 6, 30))


@motion("sneak", params={"speed": 1.0, "arms": 1.0, "low": False}, doc="slow, high, crouched steps, feet planted while x changes (low: true = crouch-walk)")
def sneak_fx(st, t, p, ctx):
    _gait_fx(st, t, p, ctx, "crouch" if p.get("low") else "sneak", (30, 1.1 * p["speed"], 2, 0, 6))


@motion("type", params={"speed": 1.0}, doc="hands hammer a keyboard")
def typing(st, t, p, ctx):
    s = p["speed"]
    st["RE"] += 14 * math.sin(t * TAU * 7.1 * s)
    st["LE"] += 14 * math.sin(t * TAU * 6.3 * s + 1)
    st["RS"] += 4 * math.sin(t * TAU * 3.3 * s)


@motion("nod", params={"speed": 1.0, "amount": 1.0}, doc="head nods (on the beat when the scene has a bpm)")
def nod(st, t, p, ctx):
    beat = ctx.get("beat") or 0.6
    w = 0.5 + 0.5 * math.cos(TAU * t / (beat / p["speed"]))
    st["H"] += 12 * w * p["amount"]
    st["T"] += 2.5 * w * p["amount"]


@motion("bounce", params={"amount": 1.0, "hop": 1.0}, doc="whole body bounces on the beat (knees dip on the beat; hop: 0 keeps the feet on the floor)")
def bounce(st, t, p, ctx):
    beat = ctx.get("beat") or 0.5
    w = abs(math.sin(math.pi * t / beat))
    st["y"] += 10 * w * p["amount"] * p.get("hop", 1.0)
    st["RK"] -= 14 * (1 - w) * p["amount"]
    st["LK"] -= 14 * (1 - w) * p["amount"]
    st["RH"] += 8 * (1 - w) * p["amount"]
    st["LH"] += 8 * (1 - w) * p["amount"]


# Beat gestures of a speaker, as offsets from the pose: (RS, RE, LS, LE, H, T).
_TALK = (
    (34, 72, 0, 0, -5, 2),       # open palm towards the listener
    (66, -6, 4, 6, -7, 4),       # explaining with a pointed hand
    (42, 96, 34, 84, 5, 0),      # both hands open
    (56, 44, 0, 0, 7, 5),        # chop (drops on the beat)
    (12, 30, 30, 88, -4, -2),    # the other hand
    (24, 110, 0, 0, 9, 3),       # hand to the chest ("I …")
    (0, 0, 0, 0, 6, 0),          # a pause: just the head
)


@motion("talk", params={"amount": 1.0, "speed": 1.0}, doc="speaking: beat gestures with one or both hands, head nods, a little body sway")
def talk(st, t, p, ctx):
    a = p["amount"]
    # a new gesture every ~0.6 s (varied, but the same every render); the hands move over between
    # gestures and hit each one with a small accent, the head nods on it
    period = 0.62 / max(p.get("speed", 1.0), 0.1)
    seed = ctx.get("phase", 0.0) * 7.0
    s = t / period
    k = math.floor(s)
    u = s - k
    g0 = _TALK[int(hash01(k, seed) * len(_TALK))]
    g1 = _TALK[int(hash01(k + 1, seed) * len(_TALK))]
    v = min(1.0, max(0.0, (u - 0.6) / 0.4))
    v = v * v * (3 - 2 * v)
    accent = math.exp(-((u - 0.12) / 0.09) ** 2)
    for i, n in enumerate(("RS", "RE", "LS", "LE", "H", "T")):
        st[n] += (g0[i] + (g1[i] - g0[i]) * v) * a
    st["RS"] -= 9 * accent * a
    st["RE"] += 8 * accent * a
    st["H"] += 7 * accent * a + 2.5 * math.sin(t * 5.3) * a
    st["T"] += 1.5 * math.sin(TAU * t * 0.4) * a


@motion("laugh", params={"amount": 1.0}, doc="shaking with laughter")
def laugh(st, t, p, ctx):
    a = p["amount"]
    st["T"] += (-12 + 7 * math.sin(TAU * t * 5.5)) * a
    st["H"] += (-18 + 6 * math.sin(TAU * t * 5.5)) * a
    st["RS"] += 15 * math.sin(TAU * t * 5.5) * a
    st["y"] += 3 * abs(math.sin(TAU * t * 5.5)) * a


@motion("shiver", params={"amount": 1.0}, doc="trembling (cold, fear)")
def shiver(st, t, p, ctx):
    fr = round(t * 30)
    st["x"] += (hash01(fr, 5) - 0.5) * 3 * p["amount"]
    st["H"] += (hash01(fr, 6) - 0.5) * 6 * p["amount"]
    st["RS"] += (hash01(fr, 7) - 0.5) * 5 * p["amount"]


@motion("daze", params={"amount": 1.0}, doc="swaying, dizzy")
def daze(st, t, p, ctx):
    st["T"] += 8 * math.sin(TAU * t * 0.9) * p["amount"]
    st["H"] += 14 * math.sin(TAU * t * 1.3) * p["amount"]
    st["x"] += 6 * math.sin(TAU * t * 0.45) * p["amount"]


@motion("flail", params={"speed": 1.0}, doc="arms windmill (falling, panic)")
def flail(st, t, p, ctx):
    st["RS"] = (t * 1100 * p["speed"]) % 360
    st["LS"] = (t * 1100 * p["speed"] + 180) % 360
    st["T"] += 10 * math.sin(t * 9)


@motion("zap", params={"amount": 1.0}, doc="electrocuted: every joint jitters")
def zap(st, t, p, ctx):
    fr = round(t * 30)
    for i, a in enumerate(ANGLES):
        st[a] += (hash01(fr, i) - 0.5) * 40 * p["amount"]
    st["x"] += (hash01(fr, 99) - 0.5) * 10 * p["amount"]


@motion("pant", params={"amount": 1.0}, doc="out of breath: fast, deep breathing")
def pant(st, t, p, ctx):
    w = math.sin(TAU * t * 2.2)
    st["T"] += (8 + 5 * w) * p["amount"]
    st["H"] += 4 * w * p["amount"]
    st["RS"] += 4 * w * p["amount"]


@motion("float", params={"height": 12, "speed": 1.0}, doc="hovers up and down")
def float_fx(st, t, p, ctx):
    st["y"] += p["height"] * (0.5 + 0.5 * math.sin(TAU * t * 0.5 * p["speed"]))
    st["RK"] -= 6
    st["LK"] -= 10


@motion("shake_head", params={"speed": 1.0}, doc="head shakes: no")
def shake_head(st, t, p, ctx):
    st["H"] += 9 * math.sin(TAU * t * 2.6 * p["speed"])


@motion("wave", params={"speed": 1.0}, doc="the raised near arm waves (use with pose: wave)")
def wave_fx(st, t, p, ctx):
    st["RE"] += 28 * math.sin(TAU * t * 2.4 * p["speed"])


def _seen_from_front(st: dict) -> None:
    # half way through a turn the figure faces the camera: eyes in the middle of the face
    if abs(st["face"]) < 0.4:
        st["look"] = "camera"


@motion("spin", params={"speed": 1.0}, doc="turns around and around (the body narrows, faces the camera, and turns on)")
def spin(st, t, p, ctx):
    # facing between -1 and 1 squeezes the body sideways (skeleton.fk), so it really turns
    f = math.sin(t * TAU * 1.75 * p["speed"])
    st["face"] = f if abs(f) > 1e-3 else 1e-3
    _seen_from_front(st)


def _face_value(v) -> float:
    if isinstance(v, (int, float)):
        return 1.0 if v >= 0 else -1.0
    return -1.0 if str(v).strip().lower().startswith(("l", "-")) else 1.0


@motion("turn", params={"t0": 0.0, "dur": 0.22, "from": 1}, doc="turning round: from the `from` facing to the key's face over dur seconds starting at t0 (do: turn adds this)")
def turn_fx(st, t, p, ctx):
    dur = max(float(p["dur"]), 1e-3)
    u = (t - float(p["t0"])) / dur
    if not 0.0 <= u < 1.0:
        return
    to = 1.0 if st.get("face", 1) >= 0 else -1.0
    fr = _face_value(p["from"])
    e = 0.5 - 0.5 * math.cos(math.pi * u)
    f = fr + (to - fr) * e
    st["face"] = f if abs(f) > 1e-3 else 1e-3 * to
    _seen_from_front(st)


def _cycle(s: float, duty: float, length: float) -> tuple[float, float]:
    """One limb of a crawl or climb: where it is along the cycle (offset, -length/2 … +length/2
    in the direction of travel) and how far it is lifted (0..1). While on the ground (the first
    `duty` of the cycle) it moves back exactly as fast as the body moves on — so it stays put."""
    u = s - math.floor(s)
    if u < duty:
        return (duty / 2 - u) * length, 0.0
    v = (u - duty) / (1 - duty)
    v2 = v * v * (3 - 2 * v)
    return (-duty / 2 + duty * v2) * length, math.sin(math.pi * v)


@motion("crawl", params={"stride": 44.0}, doc="on hands and knees: hands and knees take turns, planted while x changes (do: crawl)")
def crawl_fx(st, t, p, ctx):
    sc = ctx.get("thigh", 50.0) / 50.0
    L = float(p["stride"]) * sc
    face = 1.0 if st.get("face", 1) >= 0 else -1.0
    s = st["x"] * face / L
    T = math.radians(st["T"])
    sho = (70.2 * sc * math.sin(T), -70.2 * sc * math.cos(T))   # shoulder, relative to the hip
    thigh = ctx.get("thigh", 50.0)
    depth = thigh * 0.985                                          # knees and hands rest at this depth
    lift = 11.0 * sc
    # diagonal pairs move together: near arm + far knee, then far arm + near knee
    for arm, leg, ph in (("R", "L", 0.0), ("L", "R", 0.5)):
        off, up = _cycle(s + ph, 0.62, L)
        a, e = ik_limb(off, depth - up * lift - sho[1], 42.0 * sc, 40.0 * sc, 1)
        st[arm + "S"], st[arm + "E"] = a - st["T"], e
        off, up = _cycle(s + ph + 0.5, 0.62, L)
        h = math.degrees(math.atan2(off, depth - up * lift))
        st[leg + "H"] = h
        st[leg + "K"] = -92.0 - h - up * 20.0


@motion("climb", params={"rung": 34.0}, doc="hands and feet take turns going up while y changes (do: climb)")
def climb_fx(st, t, p, ctx):
    s = st.get("y", 0.0) / max(float(p["rung"]), 1.0) * 0.5
    for arm, leg, ph in (("R", "L", 0.0), ("L", "R", 0.5)):
        u = (s + ph) % 1.0
        w = math.sin(math.pi * u)                 # this pair reaches up …
        st[arm + "S"] += 18 * w - 9
        st[arm + "E"] += 26 * (1 - w)
        st[leg + "H"] += 46 * w - 10              # … while its opposite knee comes up
        st[leg + "K"] -= 70 * w
