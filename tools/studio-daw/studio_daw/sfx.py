"""One-shot sound effects for games and videos (`studio-daw sfx coin`).

Every recipe is a function (sr, pitch, dur, rng) -> mono numpy array. `pitch` and `dur` are
multipliers (1 = as designed), `rng` makes the noise parts repeatable (--seed).
"""
from __future__ import annotations

import math
from typing import Callable

import numpy as np

from . import dsp

RECIPES: dict[str, tuple[Callable, str]] = {}


def recipe(name: str, doc: str):
    def deco(fn):
        RECIPES[name] = (fn, doc)
        return fn

    return deco


def _t(seconds: float, sr: int) -> np.ndarray:
    return np.arange(max(1, int(seconds * sr))) / sr


def _decay(t: np.ndarray, rate: float) -> np.ndarray:
    return np.exp(-t * rate)


def _sweep(shape: str, f0: float, f1: float, seconds: float, sr: int, curve: float = 1.0) -> np.ndarray:
    """An oscillator gliding from f0 to f1 (curve > 1: fast at first)."""
    t = _t(seconds, sr)
    u = (t / max(seconds, 1e-6)) ** (1 / curve)
    return dsp.osc(shape, f0 * (f1 / f0) ** u, len(t), sr)


def _notes(shape: str, freqs: list[float], each: float, sr: int, last: float | None = None, decay: float = 9.0) -> np.ndarray:
    parts = []
    for i, f in enumerate(freqs):
        d = last if (last and i == len(freqs) - 1) else each
        t = _t(d, sr)
        parts.append(dsp.osc(shape, f, len(t), sr) * _decay(t, decay / max(d, 1e-3) * 0.35))
    return np.concatenate(parts)


def _noise(seconds: float, sr: int, rng) -> np.ndarray:
    return rng.uniform(-1, 1, max(1, int(seconds * sr)))


def _mix(*parts: np.ndarray) -> np.ndarray:
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[: len(p)] += p
    return out


@recipe("jump", "a quick upward sweep (platformer jump)")
def jump(sr, pitch, dur, rng):
    d = 0.2 * dur
    return _sweep("square", 280 * pitch, 880 * pitch, d, sr, 1.6) * _decay(_t(d, sr), 7) * 0.6


@recipe("coin", "two bright notes (pick-up, reward)")
def coin(sr, pitch, dur, rng):
    return _notes("square", [988 * pitch, 1319 * pitch], 0.07 * dur, sr, last=0.32 * dur) * 0.5


@recipe("pickup", "a short rising run (item collected)")
def pickup(sr, pitch, dur, rng):
    return _notes("triangle", [660 * pitch, 880 * pitch, 1320 * pitch], 0.055 * dur, sr, last=0.16 * dur) * 0.7


@recipe("powerup", "a rising arpeggio (level up, power-up)")
def powerup(sr, pitch, dur, rng):
    f = [523.25, 659.25, 783.99, 1046.5, 1318.5]
    return _notes("square", [x * pitch for x in f], 0.075 * dur, sr, last=0.3 * dur, decay=5) * 0.5


@recipe("hit", "a punchy impact (noise + thump)")
def hit(sr, pitch, dur, rng):
    d = 0.16 * dur
    t = _t(d, sr)
    thump = _sweep("sine", 190 * pitch, 55 * pitch, d, sr, 2.0) * _decay(t, 22)
    snap = dsp.lowpass(_noise(d, sr, rng), 2600 * pitch, sr) * _decay(t, 45)
    return _mix(thump, snap * 0.7)


@recipe("hurt", "a falling buzz (the player takes damage)")
def hurt(sr, pitch, dur, rng):
    d = 0.28 * dur
    t = _t(d, sr)
    x = _sweep("saw", 520 * pitch, 140 * pitch, d, sr, 1.3) * 0.6 + dsp.lowpass(_noise(d, sr, rng), 1800, sr) * 0.3
    return x * _decay(t, 9)


@recipe("explosion", "a boom with a rumble")
def explosion(sr, pitch, dur, rng):
    d = 1.1 * dur
    t = _t(d, sr)
    n = _noise(d, sr, rng)
    body = dsp.lowpass(n, 900 * pitch, sr) * _decay(t, 4.5)
    crack = dsp.highpass(n, 1500, sr) * _decay(t, 28) * 0.5
    sub = _sweep("sine", 90 * pitch, 32 * pitch, d, sr, 1.5) * _decay(t, 3.5) * 0.9
    return np.tanh(_mix(body, crack, sub) * 1.6)


@recipe("laser", "a falling zap (sci-fi shot)")
def laser(sr, pitch, dur, rng):
    d = 0.22 * dur
    return _sweep("saw", 1900 * pitch, 220 * pitch, d, sr, 1.8) * _decay(_t(d, sr), 11) * 0.5


@recipe("shoot", "a dry shot (noise + falling tone)")
def shoot(sr, pitch, dur, rng):
    d = 0.13 * dur
    t = _t(d, sr)
    return _mix(dsp.highpass(_noise(d, sr, rng), 900, sr) * _decay(t, 38) * 0.6, _sweep("square", 900 * pitch, 180 * pitch, d, sr, 2.0) * _decay(t, 26) * 0.4)


@recipe("click", "a tiny UI click")
def click(sr, pitch, dur, rng):
    d = 0.03 * dur
    t = _t(d, sr)
    return dsp.osc("sine", 1250 * pitch, len(t), sr) * _decay(t, 150) * 0.8


@recipe("select", "two quick blips (menu choice)")
def select(sr, pitch, dur, rng):
    return _notes("square", [660 * pitch, 990 * pitch], 0.045 * dur, sr, last=0.09 * dur) * 0.45


@recipe("blip", "a single short blip (text, cursor)")
def blip(sr, pitch, dur, rng):
    d = 0.06 * dur
    t = _t(d, sr)
    return dsp.osc("square", 880 * pitch, len(t), sr) * _decay(t, 40) * 0.45


@recipe("error", "two low buzzes (not allowed)")
def error(sr, pitch, dur, rng):
    d = 0.11 * dur
    one = dsp.osc("saw", 150 * pitch, int(d * sr), sr) * _decay(_t(d, sr), 6)
    gap = np.zeros(int(0.045 * dur * sr))
    return np.concatenate([one, gap, one]) * 0.5


@recipe("win", "a little fanfare (level complete)")
def win(sr, pitch, dur, rng):
    f = [523.25, 659.25, 783.99, 1046.5]
    lead = _notes("square", [x * pitch for x in f], 0.12 * dur, sr, last=0.6 * dur, decay=4)
    low = _notes("triangle", [x * pitch / 2 for x in f], 0.12 * dur, sr, last=0.6 * dur, decay=4)
    return _mix(lead * 0.4, low * 0.5)


@recipe("lose", "falling notes (game over)")
def lose(sr, pitch, dur, rng):
    f = [392.0, 329.63, 261.63, 196.0]
    x = _notes("triangle", [v * pitch for v in f], 0.17 * dur, sr, last=0.55 * dur, decay=4)
    return x * 0.8


@recipe("bounce", "a cartoon spring (boing)")
def bounce(sr, pitch, dur, rng):
    d = 0.32 * dur
    t = _t(d, sr)
    f = 180 * pitch * (1 + 0.9 * np.exp(-t * 14) + 0.25 * np.sin(2 * math.pi * 22 * t) * np.exp(-t * 6))
    return dsp.osc("sine", f, len(t), sr) * _decay(t, 8) * 0.8


@recipe("swoosh", "air moving fast (swing, dash)")
def swoosh(sr, pitch, dur, rng):
    d = 0.32 * dur
    t = _t(d, sr)
    n = _noise(d, sr, rng)
    lo = dsp.bandpass(n, 700 * pitch, sr, 1.2)
    hi = dsp.bandpass(n, 2600 * pitch, sr, 1.2)
    u = t / d
    return (lo * (1 - u) + hi * u) * np.sin(math.pi * u) ** 1.5 * 1.6


@recipe("step", "a single footstep")
def step(sr, pitch, dur, rng):
    d = 0.07 * dur
    t = _t(d, sr)
    return _mix(dsp.lowpass(_noise(d, sr, rng), 700 * pitch, sr) * _decay(t, 60), dsp.osc("sine", 90 * pitch, len(t), sr) * _decay(t, 70) * 0.6)


@recipe("door", "a door closing (thud + latch)")
def door(sr, pitch, dur, rng):
    d = 0.35 * dur
    t = _t(d, sr)
    thud = _sweep("sine", 120 * pitch, 60 * pitch, d, sr) * _decay(t, 16)
    latch = np.zeros(len(t))
    k = int(0.09 * dur * sr)
    c = dsp.highpass(_noise(0.03, sr, rng), 2500, sr) * _decay(_t(0.03, sr), 160)
    latch[k : k + len(c)] = c[: max(0, len(latch) - k)]
    return _mix(thud, dsp.lowpass(_noise(d, sr, rng), 500, sr) * _decay(t, 30) * 0.6, latch * 0.5)


@recipe("splash", "something drops into water")
def splash(sr, pitch, dur, rng):
    d = 0.6 * dur
    t = _t(d, sr)
    n = _noise(d, sr, rng)
    body = dsp.bandpass(n, 1400 * pitch, sr, 0.7) * _decay(t, 7) * (1 - np.exp(-t * 90))
    plop = _sweep("sine", 420 * pitch, 160 * pitch, 0.09 * dur, sr) * _decay(_t(0.09 * dur, sr), 28)
    return _mix(body * 1.4, plop * 0.7)


@recipe("zap", "an electric buzz")
def zap(sr, pitch, dur, rng):
    d = 0.3 * dur
    t = _t(d, sr)
    mod = np.sign(np.sin(2 * math.pi * 55 * pitch * t))
    x = dsp.osc("saw", 700 * pitch * (1 + 0.5 * mod), len(t), sr) * 0.5 + dsp.highpass(_noise(d, sr, rng), 3000, sr) * 0.3
    return x * (0.6 + 0.4 * mod) * _decay(t, 5)


@recipe("alarm", "a two-tone alarm")
def alarm(sr, pitch, dur, rng):
    d = 1.0 * dur
    t = _t(d, sr)
    f = np.where((t * 4).astype(int) % 2 == 0, 880.0, 660.0) * pitch
    edge = np.minimum(1, np.minimum(t, d - t) * 60)
    return dsp.osc("square", f, len(t), sr) * 0.4 * edge


@recipe("magic", "a sparkling shimmer (spell, heal)")
def magic(sr, pitch, dur, rng):
    d = 0.7 * dur
    t = _t(d, sr)
    out = np.zeros(len(t))
    for i, f in enumerate([1046.5, 1318.5, 1568.0, 2093.0, 2637.0]):
        start = int(i * 0.07 * dur * sr)
        tt = t[: len(t) - start]
        out[start:] += np.sin(2 * math.pi * f * pitch * tt + 2 * np.sin(2 * math.pi * 7 * tt)) * _decay(tt, 6) * 0.25
    return out


@recipe("thud", "something heavy lands")
def thud(sr, pitch, dur, rng):
    d = 0.3 * dur
    t = _t(d, sr)
    return _mix(_sweep("sine", 110 * pitch, 42 * pitch, d, sr, 1.6) * _decay(t, 13), dsp.lowpass(_noise(d, sr, rng), 380, sr) * _decay(t, 24) * 0.8)


def make(kind: str, sr: int = dsp.SR, pitch: float = 1.0, dur: float = 1.0, seed: int = 1) -> np.ndarray:
    """One effect as a stereo array, peak at -3 dBFS, with short fades (no clicks)."""
    fn, _ = RECIPES[kind]
    rng = np.random.default_rng(seed)
    x = np.asarray(fn(sr, max(0.1, pitch), max(0.1, dur), rng), dtype=np.float64)
    x = np.concatenate([x, np.zeros(int(0.02 * sr))])
    k = max(1, int(0.003 * sr))
    x[:k] *= np.linspace(0, 1, k)
    x[-k:] *= np.linspace(1, 0, k)
    peak = float(np.max(np.abs(x))) or 1.0
    return dsp.to_stereo(x / peak * dsp.db_to_amp(-3.0))
