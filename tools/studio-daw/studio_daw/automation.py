"""Effects that change over time: automation (gain, pan, filters along the song) and
modulation (phaser, auto-pan, rhythmic gate).

    mix:
      pad:
        effects:
          - { use: automate, param: gain, points: "1:-18 5:0 21:0 25:-40" }     # bar:value …
          - { use: automate, param: lowpass, points: "intro:300 verse:9000" }    # section names work too
          - { use: gate, pattern: "x-x-xx-x", step: 0.25 }
"""
from __future__ import annotations

import math

import numpy as np
from scipy import signal

from . import dsp
from .api import effect


def _positions(spec, ctx) -> list[tuple[float, float]]:
    """ "1:-12 5:0" | [[1, -12], [5, 0]] | {1: -12, chorus: 0}  ->  [(seconds, value)] in order."""
    pairs: list[tuple] = []
    if isinstance(spec, str):
        for tok in spec.replace(",", " ").split():
            if ":" not in tok:
                raise ValueError(f'"{tok}" — write points as bar:value, e.g. "1:-12 5:0"')
            b, v = tok.rsplit(":", 1)
            pairs.append((b, v))
    elif isinstance(spec, dict):
        pairs = list(spec.items())
    elif isinstance(spec, (list, tuple)):
        for p in spec:
            if not isinstance(p, (list, tuple)) or len(p) != 2:
                raise ValueError("points as a list must be pairs: [[1, -12], [5, 0]]")
            pairs.append(tuple(p))
    else:
        raise ValueError('points must look like "1:-12 5:0"')
    if not pairs:
        raise ValueError("no points")
    out = []
    for b, v in pairs:
        try:
            out.append((float(ctx["at"](b)), float(v)))
        except (TypeError, ValueError) as e:
            raise ValueError(str(e) or f'bad point "{b}:{v}"') from None
    out.sort(key=lambda p: p[0])
    return out


def _curve(points: list[tuple[float, float]], n: int, sr: int, log: bool = False) -> np.ndarray:
    t = np.arange(n) / sr
    xs = np.array([p[0] for p in points])
    ys = np.array([p[1] for p in points])
    if log:
        return np.exp(np.interp(t, xs, np.log(np.maximum(ys, 1.0))))
    return np.interp(t, xs, ys)


def sweep_filter(x: np.ndarray, kind: str, freqs: np.ndarray, sr: int, q: float = 0.707, block: int = 256) -> np.ndarray:
    """A filter whose frequency follows `freqs` (one value per sample), processed in small blocks."""
    x = dsp.to_stereo(x)
    out = np.empty_like(x)
    zi = np.zeros((2, x.shape[1]))
    n = len(x)
    for i in range(0, n, block):
        f = float(freqs[min(i + block // 2, n - 1)])
        b, a = dsp.biquad(kind, f, sr, q)
        out[i : i + block], zi = signal.lfilter(b, a, x[i : i + block], axis=0, zi=zi)
    return out


def pan_curve(x: np.ndarray, p: np.ndarray) -> np.ndarray:
    x = dsp.to_stereo(x)
    ang = (np.clip(p, -1, 1) + 1) * math.pi / 4
    return x * np.stack([np.cos(ang), np.sin(ang)], axis=1) * math.sqrt(2)


_PARAMS = ["gain", "pan", "lowpass", "highpass", "width"]


@effect(
    "automate",
    params={
        "param": {"value": "gain", "options": _PARAMS, "doc": "what changes: gain (dB), pan (-1…1), lowpass / highpass (Hz), width (0…2)"},
        "points": {"value": "1:0", "type": "text", "doc": 'bar:value pairs, e.g. "1:-18 5:0 17:0 21:-40" — bars count from 1 (2.5 = middle of bar 2); section names work too ("intro:300 drop:9000")'},
        "q": {"value": 0.707, "min": 0.3, "max": 8, "doc": "resonance of the filter (lowpass / highpass)"},
    },
    doc="Automation: a value that moves along the song — fades (gain), pans, filter sweeps. Straight lines between the points.",
)
def automate(x, sr, p, ctx):
    what = str(p["param"]).lower()
    if what in ("cutoff", "filter"):
        what = "lowpass"
    if what in ("volume", "level"):
        what = "gain"
    if what not in _PARAMS:
        ctx["warnings"].append(f'automate on "{ctx["track"]}": unknown param "{p["param"]}" (one of: {", ".join(_PARAMS)})')
        return x
    try:
        pts = _positions(p["points"], ctx)
    except ValueError as e:
        ctx["warnings"].append(f'automate on "{ctx["track"]}": {e}')
        return x
    n = len(x)
    if what == "gain":
        return dsp.to_stereo(x) * (10 ** (_curve(pts, n, sr) / 20))[:, None]
    if what == "pan":
        return pan_curve(x, _curve(pts, n, sr))
    if what == "width":
        w = _curve(pts, n, sr)
        x = dsp.to_stereo(x)
        mid = (x[:, 0] + x[:, 1]) / 2
        side = (x[:, 0] - x[:, 1]) / 2 * w
        return np.stack([mid + side, mid - side], axis=1)
    return sweep_filter(x, what, _curve(pts, n, sr, log=True), sr, float(p["q"]))


@effect("autopan", params={"beats": 2.0, "depth": 0.8, "phase": 0.0},
        doc="The sound wanders left ↔ right; one round trip takes `beats` beats.")
def autopan(x, sr, p, ctx):
    t = np.arange(len(x)) / sr
    period = max(0.05, float(p["beats"]) * ctx["beat"])
    return pan_curve(x, float(p["depth"]) * np.sin(2 * math.pi * (t / period + float(p["phase"]))))


@effect("gate", params={"pattern": {"value": "x-x-xx-x", "type": "text", "doc": "x = open, - = closed, o = half; repeats"},
                        "step": 0.25, "depth": 1.0, "smooth": 0.006},
        doc="Rhythmic gate: chops a held sound (pads, strings) into a pattern; step in beats (0.25 = 16th).")
def gate(x, sr, p, ctx):
    pat = [c for c in str(p["pattern"]) if c not in " |"]
    if not pat:
        return x
    levels = np.array([1.0 if c in "xX" else 0.5 if c in "oO" else 0.0 for c in pat])
    step = max(0.01, float(p["step"]) * ctx["beat"])
    t = np.arange(len(x)) / sr + float(ctx.get("offset", 0.0))
    env = levels[(np.floor(t / step).astype(np.int64)) % len(levels)]
    k = max(1, int(float(p["smooth"]) * sr))
    if k > 1:  # short ramps instead of clicks
        env = np.convolve(env, np.ones(k) / k, mode="same")
    depth = min(1.0, max(0.0, float(p["depth"])))
    return dsp.to_stereo(x) * (1 - depth + depth * env)[:, None]


@effect("phaser", params={"rate": 0.35, "depth": 0.8, "mix": 0.5, "stages": 4, "center": 900.0},
        doc="Sweeping notches (classic phaser): rate in Hz, center frequency in Hz, 2–8 stages.")
def phaser(x, sr, p, ctx):
    x = dsp.to_stereo(x)
    wet = x.copy()
    stages = int(min(12, max(1, p["stages"])))
    zis = [np.zeros((1, 2)) for _ in range(stages)]
    block, n = 128, len(x)
    rate, depth, center = float(p["rate"]), float(p["depth"]), float(p["center"])
    for i in range(0, n, block):
        t = (i + block / 2) / sr
        fc = min(center * 2 ** (depth * 2 * math.sin(2 * math.pi * rate * t)), sr * 0.45)
        k = math.tan(math.pi * fc / sr)
        a1 = (k - 1) / (k + 1)
        seg = wet[i : i + block]
        for s in range(stages):
            seg, zis[s] = signal.lfilter([a1, 1.0], [1.0, a1], seg, axis=0, zi=zis[s])
        wet[i : i + block] = seg
    mix = min(1.0, max(0.0, float(p["mix"])))
    return x * (1 - mix) + wet * mix


@effect("saturate", params={"drive": 1.5, "tone": 0.5, "mix": 1.0},
        doc="Warm tape-style saturation: gentle, keeps the level (drive 1–4, tone 0 dark … 1 bright).")
def saturate(x, sr, p, ctx):
    x = dsp.to_stereo(x)
    d = max(0.1, float(p["drive"]))
    y = np.tanh(x * d) / math.tanh(d)
    y = y - 0.08 * d * (y ** 2 - np.mean(y ** 2, axis=0))          # a little even harmonics
    tone = min(1.0, max(0.0, float(p["tone"])))
    y = dsp.lowpass(y, 2500 * 2 ** (tone * 3), sr)
    rms_in, rms_out = np.sqrt(np.mean(x ** 2) + 1e-12), np.sqrt(np.mean(y ** 2) + 1e-12)
    y = y * (rms_in / rms_out)
    mix = min(1.0, max(0.0, float(p["mix"])))
    return x * (1 - mix) + y * mix
