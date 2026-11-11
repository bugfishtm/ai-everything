"""Built-in instruments. Each returns a mono or stereo array for one note."""
from __future__ import annotations

import math

import numpy as np

from .api import instrument
from .dsp import adsr, bandpass, exp_decay, highpass, lowpass, osc

_rng = np.random.default_rng(1234)


def _n(dur: float, sr: int) -> int:
    return max(1, int(dur * sr))


def _env(dur, sr, p):
    return adsr(_n(dur, sr), sr, p["attack"], p["decay"], p["sustain"], p["release"])


def _amp(vel: float) -> float:
    return float(vel) ** 1.5


# --- basic waveforms ----------------------------------------------------------
_BASIC = {"attack": 0.005, "decay": 0.12, "sustain": 0.7, "release": 0.12, "detune": 0.0}

for _shape in ("sine", "triangle", "square", "saw"):

    def _make(shape):
        def voice(freq, dur, vel, sr, p):
            env = _env(dur, sr, p)
            f = freq * 2 ** (p["detune"] / 1200)
            return osc(shape, f, len(env), sr) * env * _amp(vel) * (0.5 if shape in ("saw", "square") else 0.8)

        voice.__doc__ = f"Plain {shape} wave with ADSR envelope."
        return voice

    instrument(_shape, params=_BASIC)(_make(_shape))


@instrument("bass", params={"attack": 0.004, "decay": 0.18, "sustain": 0.6, "release": 0.08, "cutoff": 900, "resonance": 1.2, "sub": 0.5},
            doc="Saw + sub square bass through a resonant low-pass (key tracked).")
def bass(freq, dur, vel, sr, p):
    env = _env(dur, sr, p)
    n = len(env)
    x = osc("saw", freq, n, sr) + p["sub"] * osc("square", freq / 2, n, sr)
    cutoff = p["cutoff"] * (0.6 + 0.8 * vel) * (freq / 110) ** 0.3
    return lowpass(x, cutoff, sr, p["resonance"]) * env * _amp(vel) * 0.45


@instrument("lead", params={"attack": 0.01, "decay": 0.2, "sustain": 0.75, "release": 0.18, "cutoff": 3200, "vibrato": 0.25, "detune": 8},
            doc="Two detuned saws with delayed vibrato.")
def lead(freq, dur, vel, sr, p):
    env = _env(dur, sr, p)
    n = len(env)
    t = np.arange(n) / sr
    vib = 1 + (p["vibrato"] / 12) * np.log(2) * np.sin(2 * math.pi * 5.2 * t) * np.clip((t - 0.25) / 0.3, 0, 1)
    f = freq * vib
    d = 2 ** (p["detune"] / 1200)
    x = osc("saw", f * d, n, sr) + osc("saw", f / d, n, sr, 0.37)
    return lowpass(x, p["cutoff"], sr, 0.9) * env * _amp(vel) * 0.3


@instrument("pad", params={"attack": 0.7, "decay": 0.6, "sustain": 0.85, "release": 1.6, "cutoff": 1800, "voices": 5, "spread": 14},
            doc="Wide supersaw pad (stereo).")
def pad(freq, dur, vel, sr, p):
    env = _env(dur, sr, p)
    n = len(env)
    voices = max(1, int(p["voices"]))
    left = np.zeros(n)
    right = np.zeros(n)
    for i in range(voices):
        cents = (i - (voices - 1) / 2) * p["spread"] / max(1, voices - 1) * 2
        wave = osc("saw", freq * 2 ** (cents / 1200), n, sr, _rng.random())
        w = (i + 0.5) / voices
        left += wave * (1 - w)
        right += wave * w
    out = np.stack([lowpass(left, p["cutoff"], sr), lowpass(right, p["cutoff"], sr)], axis=1)
    return out * env[:, None] * _amp(vel) * (0.5 / voices)


@instrument("strings", params={"attack": 0.35, "decay": 0.4, "sustain": 0.9, "release": 0.6, "cutoff": 2600},
            doc="Ensemble strings: detuned saws, slow attack, gentle vibrato.")
def strings(freq, dur, vel, sr, p):
    env = _env(dur, sr, p)
    n = len(env)
    t = np.arange(n) / sr
    vib = 2 ** (0.08 / 12 * np.sin(2 * math.pi * 5.5 * t))
    x = sum(osc("saw", freq * vib * 2 ** (c / 1200), n, sr, ph) for c, ph in ((-9, 0.1), (0, 0.5), (9, 0.8)))
    return lowpass(x, p["cutoff"] * (0.7 + 0.5 * vel), sr) * env * _amp(vel) * 0.18


@instrument("pluck", params={"decay": 0.996, "brightness": 0.7, "release": 0.05},
            doc="Karplus-Strong plucked string (guitar/harp-like).")
def pluck(freq, dur, vel, sr, p):
    period = max(2, int(round(sr / freq)))
    n = _n(dur + 1.2, sr)
    burst = _rng.uniform(-1, 1, period)
    burst = lowpass(burst, 1500 + 9000 * p["brightness"] * vel, sr)
    out = np.empty(n)
    block = burst
    for start in range(0, n, period):
        end = min(n, start + period)
        out[start:end] = block[: end - start]
        block = p["decay"] * 0.5 * (block + np.roll(block, 1))
    fade = np.ones(n)
    off = _n(dur, sr)
    if off < n:
        r = min(n - off, _n(p["release"] + 0.15, sr))
        fade[off : off + r] = np.linspace(1, 0, r)
        fade[off + r :] = 0
    return out * fade * _amp(vel) * 0.8


def _fm(freq, n, sr, ratio, index, idx_decay, phase_mod=0.0):
    t = np.arange(n) / sr
    mod = np.sin(2 * math.pi * freq * ratio * t + phase_mod) * index * np.exp(-t / idx_decay)
    return np.sin(2 * math.pi * freq * t + mod)


@instrument("epiano", params={"attack": 0.002, "decay": 1.6, "sustain": 0.25, "release": 0.4, "tine": 0.15},
            doc="FM electric piano (Rhodes-like).")
def epiano(freq, dur, vel, sr, p):
    env = _env(dur, sr, p)
    n = len(env)
    body = _fm(freq, n, sr, 1.0, 1.2 + 2 * vel, 0.8)
    tine = _fm(freq, n, sr, 14.0, 0.8, 0.05) * p["tine"] * exp_decay(n, sr, 0.25)
    return (body + tine) * env * _amp(vel) * 0.45


@instrument("bell", params={"attack": 0.001, "decay": 3.0, "sustain": 0.0, "release": 1.0, "ratio": 3.5, "index": 4.0},
            doc="FM bell / glockenspiel.")
def bell(freq, dur, vel, sr, p):
    n = _n(max(dur, 0.1) + p["decay"], sr)
    x = _fm(freq, n, sr, p["ratio"], p["index"] * vel, 0.9)
    return x * exp_decay(n, sr, p["decay"]) * _amp(vel) * 0.35


@instrument("organ", params={"attack": 0.01, "decay": 0.05, "sustain": 1.0, "release": 0.08, "drawbars": [0.6, 1.0, 0.7, 0.4, 0.3, 0.2], "leslie": 0.3},
            doc="Additive drawbar organ with leslie-style tremolo.")
def organ(freq, dur, vel, sr, p):
    env = _env(dur, sr, p)
    n = len(env)
    harmonics = [0.5, 1, 2, 3, 4, 6]
    x = sum(w * osc("sine", freq * h, n, sr) for h, w in zip(harmonics, p["drawbars"]))
    t = np.arange(n) / sr
    trem = 1 - p["leslie"] * 0.5 * (1 + np.sin(2 * math.pi * 6.5 * t))
    return x * trem * env * _amp(vel) * 0.16


# --- drums ---------------------------------------------------------------------
@instrument("kick", params={"pitch": 50, "punch": 150, "decay": 0.45, "click": 0.3, "drive": 1.6}, drum=True,
            doc="Synth kick: pitch-swept sine + click.")
def kick(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.05, sr)
    t = np.arange(n) / sr
    f = p["pitch"] + (p["punch"] - p["pitch"]) * np.exp(-t / 0.035)
    body = np.sin(2 * math.pi * np.cumsum(f) / sr) * exp_decay(n, sr, p["decay"])
    click = highpass(_rng.uniform(-1, 1, n), 2500, sr) * exp_decay(n, sr, 0.008) * p["click"]
    x = np.tanh((body + click) * p["drive"]) / math.tanh(p["drive"])
    return x * _amp(vel) * 0.9


@instrument("snare", params={"tone": 185, "decay": 0.2, "snappy": 0.8}, drum=True, doc="Synth snare: tone + noise.")
def snare(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.1, sr)
    t = np.arange(n) / sr
    tone = np.sin(2 * math.pi * p["tone"] * t) * exp_decay(n, sr, 0.09)
    noise = highpass(_rng.uniform(-1, 1, n), 1800, sr) * exp_decay(n, sr, p["decay"]) * p["snappy"]
    return (tone * 0.6 + noise * 0.7) * _amp(vel) * 0.7


@instrument("hat", params={"decay": 0.05, "tone": 8000}, drum=True, doc="Closed hi-hat.")
def hat(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.02, sr)
    return highpass(_rng.uniform(-1, 1, n), p["tone"], sr) * exp_decay(n, sr, p["decay"]) * _amp(vel) * 0.35


@instrument("ohat", params={"decay": 0.38, "tone": 7500}, drum=True, doc="Open hi-hat.")
def ohat(freq, dur, vel, sr, p):
    return hat(freq, dur, vel, sr, p)


@instrument("clap", params={"decay": 0.22}, drum=True, doc="Hand clap: three noise bursts + tail.")
def clap(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.06, sr)
    noise = bandpass(_rng.uniform(-1, 1, n), 1400, sr, 0.8)
    env = np.zeros(n)
    for k in range(3):
        s = int(k * 0.011 * sr)
        env[s:] += exp_decay(n - s, sr, 0.02) * 0.8
    env += exp_decay(n, sr, p["decay"]) * 0.5
    return noise * env * _amp(vel) * 0.6


@instrument("tom", params={"pitch": 110, "decay": 0.35}, drum=True, doc="Synth tom (set pitch: 160 high … 80 low).")
def tom(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.05, sr)
    t = np.arange(n) / sr
    f = p["pitch"] * (1 + 0.6 * np.exp(-t / 0.04))
    return np.sin(2 * math.pi * np.cumsum(f) / sr) * exp_decay(n, sr, p["decay"]) * _amp(vel) * 0.8


@instrument("crash", params={"decay": 1.6}, drum=True, doc="Crash cymbal.")
def crash(freq, dur, vel, sr, p):
    n = _n(p["decay"], sr)
    noise = highpass(_rng.uniform(-1, 1, n), 4500, sr)
    t = np.arange(n) / sr
    metal = sum(np.sign(np.sin(2 * math.pi * f * t)) for f in (587, 845, 1031, 1471)) * 0.08
    return (noise + highpass(metal, 3000, sr)) * exp_decay(n, sr, p["decay"]) * _amp(vel) * 0.3


@instrument("ride", params={"decay": 1.1}, drum=True, doc="Ride cymbal with bell.")
def ride(freq, dur, vel, sr, p):
    n = _n(p["decay"], sr)
    t = np.arange(n) / sr
    bell_ = np.sin(2 * math.pi * 2400 * t) * exp_decay(n, sr, 0.4) * 0.3
    noise = highpass(_rng.uniform(-1, 1, n), 6000, sr) * 0.6
    return (noise + bell_) * exp_decay(n, sr, p["decay"]) * _amp(vel) * 0.3


@instrument("rim", params={}, drum=True, doc="Rim shot / side stick.")
def rim(freq, dur, vel, sr, p):
    n = _n(0.05, sr)
    t = np.arange(n) / sr
    return (np.sin(2 * math.pi * 420 * t) + highpass(_rng.uniform(-1, 1, n), 3000, sr) * 0.5) * exp_decay(n, sr, 0.03) * _amp(vel) * 0.6


@instrument("shaker", params={"decay": 0.08}, drum=True, doc="Shaker.")
def shaker(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.03, sr)
    env = np.minimum(1, np.arange(n) / (0.012 * sr)) * exp_decay(n, sr, p["decay"])
    return bandpass(_rng.uniform(-1, 1, n), 6500, sr, 1.2) * env * _amp(vel) * 0.4


@instrument("cowbell", params={"decay": 0.3}, drum=True, doc="808-style cowbell.")
def cowbell(freq, dur, vel, sr, p):
    n = _n(p["decay"] + 0.05, sr)
    x = osc("square", 540, n, sr) + osc("square", 800, n, sr)
    return bandpass(x, 900, sr, 1.5) * exp_decay(n, sr, p["decay"]) * _amp(vel) * 0.3


# name → (voice, params) used by the built-in "drums" kit
SYNTH_KIT = {
    "kick": ("kick", {}), "snare": ("snare", {}), "clap": ("clap", {}), "rim": ("rim", {}),
    "hat": ("hat", {}), "chh": ("hat", {}), "ohat": ("ohat", {}), "openhat": ("ohat", {}),
    "tom1": ("tom", {"pitch": 165}), "tom2": ("tom", {"pitch": 125}), "tom3": ("tom", {"pitch": 90}),
    "crash": ("crash", {}), "ride": ("ride", {}), "shaker": ("shaker", {}), "cowbell": ("cowbell", {}),
}
