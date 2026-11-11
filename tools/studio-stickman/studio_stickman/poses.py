"""Built-in poses and motions (continuous modifiers used with `fx:`)."""
from __future__ import annotations

import math

from .api import motion, pose
from .skeleton import ANGLES, hash01

# name: (T, H, RS, RE, LS, LE, RH, RK, LH, LK), doc, extras
_P = {
    "stand":        ((0, 0, 8, 14, -8, 14, 6, -4, -6, -4), "relaxed standing"),
    "hero":         ((-4, -6, -24, 68, -30, 74, 12, -4, -12, -4), "upright, hands on the hips"),
    "guard":        ((12, -5, 35, 105, 55, 95, 28, -22, -22, -12), "fighting stance, fists up"),
    "block":        ((-5, -10, 60, 80, 40, 100, 25, -20, -25, -10), "arms in front of the head"),
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
    "recoil_fwd":   ((28, 40, 60, -20, 110, 30, 18, -30, -18, -5), "hit in the stomach: doubled over"),
    "stagger":      ((-18, -25, -30, 60, 40, 80, -12, -30, 25, -40), "off balance"),
    "fall":         ((-50, -30, -100, 20, -130, 30, 60, -40, 30, -50), "falling backwards, limbs up"),
    "down":         ((0, 20, -160, 20, 160, -20, 12, -6, -10, -4), "lying on the back", {"rot": -90}),
    "down_front":   ((0, -20, 150, 20, 170, 10, 6, -8, -8, -4), "lying face down", {"rot": 90}),
    "sit":          ((4, 0, 15, 70, 10, 70, 90, -90, 84, -84), "sitting on a chair (thighs level)"),
    "sit_floor":    ((-12, 6, -32, 20, -40, 25, 86, -12, 76, -22), "sitting on the floor, legs out"),
    "crouch":       ((45, -25, 60, 60, 50, 70, 95, -125, 70, -130), "low crouch"),
    "kneel":        ((6, 0, 20, 30, -10, 25, 84, -86, -6, -96), "one knee on the floor"),
    "type":         ((18, -6, 40, 35, 36, 40, 90, -90, 84, -84), "sitting, hands on a keyboard"),
    "sip":          ((10, -14, 40, 35, 20, 150, 90, -90, 84, -84), "sitting, cup at the mouth (far hand)"),
    "point":        ((4, 0, 88, 0, -10, 20, 8, -4, -8, -4), "arm straight out, pointing forward"),
    "wave":         ((0, -4, 165, -30, -8, 14, 6, -4, -6, -4), "one arm up"),
    "cheer":        ((-5, -10, 170, -30, 165, -30, 10, -4, -10, -4), "both arms up (also: hands up)"),
    "shrug":        ((0, 6, 32, 112, 28, 116, 6, -4, -6, -4), "forearms out, palms up"),
    "think":        ((4, 10, 30, 140, 20, 60, 6, -4, -6, -4), "hand at the chin"),
    "facepalm":     ((8, 26, 36, 152, -5, 12, 6, -4, -6, -4), "hand over the face"),
    "bow":          ((62, 10, 10, 5, 5, 5, 4, -2, -4, -2), "deep bow"),
    "salute":       ((0, -2, 102, 128, -6, 10, 4, -2, -4, -2), "hand at the forehead"),
    "run":          ((16, -4, -40, 80, 50, 80, 35, -40, -25, -50), "mid stride (use with fx: run)"),
    "sneak":        ((30, -15, 40, 70, 30, 80, 45, -60, -10, -50), "bent forward, careful"),
    "jump":         ((5, -5, 150, -20, 140, -20, 50, -80, 20, -70), "in the air, legs tucked"),
    "land":         ((30, -10, 30, 40, 20, 50, 70, -100, 50, -100), "absorbing a landing"),
    "carry":        ((10, -5, 80, 15, 75, 20, 25, -15, -20, -10), "both arms forward, holding something"),
    "push":         ((30, 0, 85, 5, 80, 10, 45, -40, -30, -5), "leaning into a push"),
    "pull":         ((-25, 0, 70, 30, 65, 35, 30, -10, -10, -30), "leaning back, pulling"),
    "throw_windup": ((-20, -5, -120, 60, 60, 40, 25, -15, -25, -10), "arm back before a throw"),
    "throw":        ((30, 5, 110, 5, -30, 40, 40, -30, -25, -5), "arm released forward"),
    "pickup":       ((70, -30, 40, 10, 30, 20, 70, -100, 30, -60), "bent down to the floor"),
    "dance1":       ((-8, -8, 140, -40, -40, 60, 30, -40, -10, -4), "dance move, near arm up"),
    "dance2":       ((8, 8, -40, 60, 140, -40, -10, -4, 30, -40), "dance move, far arm up"),
    "zombie":       ((10, 15, 85, 5, 80, 8, 10, -6, -8, -6), "arms out, stiff"),
    "slump":        ((-25, 30, -10, 10, 10, 10, 85, -20, 80, -30), "collapsed against something, legs out"),
    "hang":         ((0, 8, 178, 4, 176, 6, 4, -8, -4, -10), "hanging from the hands"),
}

for _name, _v in _P.items():
    _angles = dict(zip(ANGLES, _v[0]))
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


@motion("walk", params={"speed": 1.0}, doc="legs and arms swing — use while x changes (do: walk does this for you)")
def walk(st, t, p, ctx):
    _stride(st, t, ctx, 26, 1.9 * p["speed"], 3, 2, 18)


@motion("run", params={"speed": 1.0}, doc="fast stride with a forward lean")
def run(st, t, p, ctx):
    _stride(st, t, ctx, 44, 3.2 * p["speed"], 10, 6, 30)


@motion("sneak", params={"speed": 1.0}, doc="slow, high steps")
def sneak_fx(st, t, p, ctx):
    _stride(st, t, ctx, 30, 1.1 * p["speed"], 2, 0, 6)


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


@motion("bounce", params={"amount": 1.0}, doc="whole body bounces on the beat")
def bounce(st, t, p, ctx):
    beat = ctx.get("beat") or 0.5
    w = abs(math.sin(math.pi * t / beat))
    st["y"] += 10 * w * p["amount"]
    st["RK"] -= 14 * (1 - w) * p["amount"]
    st["LK"] -= 14 * (1 - w) * p["amount"]
    st["RH"] += 8 * (1 - w) * p["amount"]
    st["LH"] += 8 * (1 - w) * p["amount"]


@motion("talk", params={"amount": 1.0}, doc="small head and hand gestures while speaking")
def talk(st, t, p, ctx):
    a = p["amount"]
    st["H"] += 5 * math.sin(t * 9.1) * a + 3 * math.sin(t * 5.3) * a
    st["RS"] += 14 * math.sin(t * 3.7) * a
    st["RE"] += 22 * (0.5 + 0.5 * math.sin(t * 4.9 + 1)) * a


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


@motion("spin", params={"speed": 1.0}, doc="turns around and around (flips the facing direction)")
def spin(st, t, p, ctx):
    st["face"] = 1 if math.sin(t * TAU * 3.5 * p["speed"]) > 0 else -1
