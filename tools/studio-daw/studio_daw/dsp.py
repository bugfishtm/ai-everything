"""DSP building blocks (numpy/scipy). Mono signals are 1-D, stereo is (n, 2)."""
from __future__ import annotations

import math

import numpy as np
from scipy import signal
from scipy.ndimage import maximum_filter1d

SR = 44100


def db_to_amp(db: float) -> float:
    return 10 ** (db / 20)


def amp_to_db(a: float) -> float:
    return 20 * math.log10(max(a, 1e-12))


# ---------------------------------------------------------------------------
# Oscillators (polyBLEP band limited)
# ---------------------------------------------------------------------------
def _polyblep(t: np.ndarray, dt: np.ndarray | float) -> np.ndarray:
    dt = np.broadcast_to(dt, t.shape)
    y = np.zeros_like(t)
    m = t < dt
    x = t[m] / dt[m]
    y[m] = x + x - x * x - 1
    m = t > 1 - dt
    x = (t[m] - 1) / dt[m]
    y[m] = x * x + x + x + 1
    return y


def phase(freq: np.ndarray | float, n: int, sr: int = SR, phase0: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    return (phase0 + np.cumsum(f) / sr) % 1.0


def osc(shape: str, freq, n: int, sr: int = SR, phase0: float = 0.0, rng: np.random.Generator | None = None) -> np.ndarray:
    if shape == "noise":
        return (rng or np.random.default_rng()).uniform(-1, 1, n)
    t = phase(freq, n, sr, phase0)
    dt = np.clip(np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,)) / sr, 1e-6, 0.5)
    if shape == "sine":
        return np.sin(2 * np.pi * t)
    if shape == "saw":
        return 2 * t - 1 - _polyblep(t, dt)
    if shape == "square":
        return np.where(t < 0.5, 1.0, -1.0) + _polyblep(t, dt) - _polyblep((t + 0.5) % 1.0, dt)
    if shape == "triangle":
        return 2 * np.abs(2 * t - 1) - 1
    raise ValueError(f"unknown oscillator {shape}")


# ---------------------------------------------------------------------------
# Envelopes
# ---------------------------------------------------------------------------
def adsr(note_len: int, sr: int, a: float = 0.01, d: float = 0.1, s: float = 0.8, r: float = 0.1) -> np.ndarray:
    """Envelope for a note held `note_len` samples, plus the release tail."""
    a_n, d_n, r_n = max(1, int(a * sr)), max(1, int(d * sr)), max(1, int(r * sr))
    total = note_len + r_n
    idx = np.arange(total, dtype=np.float64)
    if note_len >= a_n + d_n:
        level_at_off = s
        xs = [0, a_n, a_n + d_n, note_len, total]
        ys = [0, 1, s, s, 0]
    elif note_len >= a_n:
        level_at_off = 1 - (1 - s) * (note_len - a_n) / d_n
        xs = [0, a_n, note_len, total]
        ys = [0, 1, level_at_off, 0]
    else:
        level_at_off = note_len / a_n
        xs = [0, note_len, total]
        ys = [0, level_at_off, 0]
    return np.interp(idx, xs, ys)


def exp_decay(n: int, sr: int, seconds: float) -> np.ndarray:
    """Exponential decay reaching -60 dB after `seconds`."""
    return np.exp(-6.9 * np.arange(n) / (sr * max(seconds, 1e-4)))


# ---------------------------------------------------------------------------
# Filters (RBJ biquads)
# ---------------------------------------------------------------------------
def biquad(kind: str, f0: float, sr: int, q: float = 0.707, gain_db: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    f0 = min(max(f0, 10.0), sr * 0.45)
    w0 = 2 * math.pi * f0 / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "lowpass":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "highpass":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "bandpass":
        b = [alpha, 0, -alpha]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peak":
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind == "lowshelf":
        sa = 2 * math.sqrt(A) * alpha
        b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
        a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
    elif kind == "highshelf":
        sa = 2 * math.sqrt(A) * alpha
        b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
        a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    else:
        raise ValueError(kind)
    b, a = np.array(b), np.array(a)
    return b / a[0], a / a[0]


def filt(x: np.ndarray, kind: str, f0: float, sr: int = SR, q: float = 0.707, gain_db: float = 0.0) -> np.ndarray:
    b, a = biquad(kind, f0, sr, q, gain_db)
    return signal.lfilter(b, a, x, axis=0)


def lowpass(x, cutoff, sr=SR, q=0.707):
    return filt(x, "lowpass", cutoff, sr, q)


def highpass(x, cutoff, sr=SR, q=0.707):
    return filt(x, "highpass", cutoff, sr, q)


def bandpass(x, center, sr=SR, q=1.0):
    return filt(x, "bandpass", center, sr, q)


# ---------------------------------------------------------------------------
# Stereo helpers
# ---------------------------------------------------------------------------
def to_stereo(x: np.ndarray) -> np.ndarray:
    return np.stack([x, x], axis=1) if x.ndim == 1 else x


def pan(x: np.ndarray, p: float) -> np.ndarray:
    """Equal power pan, p in -1 (left) .. 1 (right)."""
    x = to_stereo(x)
    ang = (np.clip(p, -1, 1) + 1) * math.pi / 4
    return x * np.array([math.cos(ang), math.sin(ang)]) * math.sqrt(2)


def width(x: np.ndarray, w: float) -> np.ndarray:
    x = to_stereo(x)
    mid = (x[:, 0] + x[:, 1]) / 2
    side = (x[:, 0] - x[:, 1]) / 2 * w
    return np.stack([mid + side, mid - side], axis=1)


# ---------------------------------------------------------------------------
# Effects
# ---------------------------------------------------------------------------
def reverb(x: np.ndarray, sr: int, mix: float = 0.25, size: float = 2.0, damp: float = 0.5, predelay: float = 0.015, seed: int = 7) -> np.ndarray:
    x = to_stereo(x)
    rng = np.random.default_rng(seed)
    n = max(int(size * sr), 64)
    env = exp_decay(n, sr, size)
    out = np.zeros_like(x)
    pre = np.zeros(int(predelay * sr))
    for ch in range(2):
        noise = rng.standard_normal(n)
        dark = lowpass(noise, 1800 + 4000 * (1 - damp), sr)
        t = np.linspace(0, 1, n)
        ir = (noise * (1 - t * damp) + dark * (t * damp)) * env
        ir = np.concatenate([pre, ir])
        ir /= np.sqrt(np.sum(ir**2)) + 1e-9
        out[:, ch] = signal.fftconvolve(x[:, ch], ir)[: len(x)]
    return x * (1 - mix) + out * mix * 0.9


def delay(x: np.ndarray, sr: int, seconds: float, feedback: float = 0.35, mix: float = 0.3, pingpong: bool = False) -> np.ndarray:
    x = to_stereo(x)
    d = max(1, int(seconds * sr))
    wet = np.zeros_like(x)
    g = 1.0
    k = 1
    while g > 0.001 and k * d < len(x) and k < 64:
        shifted = np.zeros_like(x)
        shifted[k * d :] = x[: len(x) - k * d]
        if pingpong and k % 2 == 1:
            shifted = shifted[:, ::-1]
        wet += shifted * g
        g *= feedback
        k += 1
    return x * (1 - mix) + wet * mix


def chorus(x: np.ndarray, sr: int, depth: float = 0.003, rate: float = 0.8, mix: float = 0.4) -> np.ndarray:
    x = to_stereo(x)
    n = len(x)
    idx = np.arange(n, dtype=np.float64)
    out = np.empty_like(x)
    for ch, ph in ((0, 0.0), (1, math.pi / 2)):
        dl = (0.012 + depth * (1 + np.sin(2 * math.pi * rate * idx / sr + ph)) / 2) * sr
        out[:, ch] = np.interp(idx - dl, idx, x[:, ch], left=0.0)
    return x * (1 - mix) + out * mix


def distortion(x: np.ndarray, drive: float = 2.0, mix: float = 1.0) -> np.ndarray:
    d = np.tanh(x * drive) / np.tanh(drive)
    return x * (1 - mix) + d * mix


def envelope(x: np.ndarray, sr: int, time: float) -> np.ndarray:
    mono = np.max(np.abs(to_stereo(x)), axis=1)
    a = math.exp(-1 / (max(time, 1e-4) * sr))
    return signal.lfilter([1 - a], [1, -a], mono)


def compressor(x: np.ndarray, sr: int, threshold: float = -18, ratio: float = 3, attack: float = 0.01, release: float = 0.12, makeup: float = 0.0) -> np.ndarray:
    x = to_stereo(x)
    env = envelope(x, sr, (attack + release) / 2)
    env_db = 20 * np.log10(np.maximum(env, 1e-9))
    over = np.maximum(env_db - threshold, 0)
    gain_db = -over * (1 - 1 / max(ratio, 1)) + makeup
    return x * (10 ** (gain_db / 20))[:, None]


def limiter(x: np.ndarray, sr: int, ceiling_db: float = -1.0, lookahead: float = 0.005, release: float = 0.06) -> np.ndarray:
    x = to_stereo(x)
    ceiling = db_to_amp(ceiling_db)
    peak = np.max(np.abs(x), axis=1)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    win = max(1, int(lookahead * sr))
    held = -maximum_filter1d(-need, size=2 * win + 1)  # minimum over the window
    a = math.exp(-1 / (release * sr))
    smooth = signal.lfilter([1 - a], [1, -a], held, zi=[held[0] * a])[0] if len(held) else held
    g = np.minimum(smooth, held)
    return np.clip(x * g[:, None], -ceiling, ceiling)


def sidechain(x: np.ndarray, source: np.ndarray, sr: int, amount: float = 0.6, release: float = 0.18) -> np.ndarray:
    env = envelope(source, sr, release / 3)
    env = env / (np.max(env) + 1e-9)
    return to_stereo(x) * (1 - amount * env)[:, None]


def tremolo(x: np.ndarray, sr: int, rate: float = 5, depth: float = 0.5) -> np.ndarray:
    t = np.arange(len(x)) / sr
    return to_stereo(x) * (1 - depth / 2 + depth / 2 * np.sin(2 * math.pi * rate * t))[:, None]


def bitcrush(x: np.ndarray, bits: int = 8, downsample: int = 1) -> np.ndarray:
    x = to_stereo(x)
    q = 2 ** (bits - 1)
    y = np.round(x * q) / q
    if downsample > 1:
        y = np.repeat(y[::downsample], downsample, axis=0)[: len(x)]
    return y


def fade(x: np.ndarray, sr: int, fade_in: float = 0.0, fade_out: float = 0.0) -> np.ndarray:
    x = to_stereo(x).copy()
    if fade_in > 0:
        n = min(len(x), int(fade_in * sr))
        x[:n] *= np.linspace(0, 1, n)[:, None]
    if fade_out > 0:
        n = min(len(x), int(fade_out * sr))
        x[len(x) - n :] *= np.linspace(1, 0, n)[:, None]
    return x


# ---------------------------------------------------------------------------
# Loudness (ITU-R BS.1770 / EBU R128 integrated loudness)
# ---------------------------------------------------------------------------
def _k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    # high shelf (+4 dB above ~1.7 kHz) then highpass (~38 Hz), as in BS.1770
    b1, a1 = biquad("highshelf", 1681.97, sr, 0.7071752, 3.99984)
    b2, a2 = biquad("highpass", 38.1355, sr, 0.5003271)
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=0), axis=0)


def lufs(x: np.ndarray, sr: int) -> float:
    x = to_stereo(x)
    if len(x) < int(0.4 * sr):
        return -70.0
    y = _k_weight(x, sr)
    block, hop = int(0.4 * sr), int(0.1 * sr)
    power = np.sum(y**2, axis=1)
    csum = np.concatenate([[0.0], np.cumsum(power)])
    starts = np.arange(0, len(y) - block + 1, hop)
    z = (csum[starts + block] - csum[starts]) / block
    lk = -0.691 + 10 * np.log10(np.maximum(z, 1e-12))
    z = z[lk > -70]
    if not len(z):
        return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(z)) - 10
    z2 = z[(-0.691 + 10 * np.log10(np.maximum(z, 1e-12))) > rel]
    return float(-0.691 + 10 * np.log10(np.mean(z2 if len(z2) else z)))


def peak_db(x: np.ndarray) -> float:
    return amp_to_db(float(np.max(np.abs(x))) if len(x) else 0.0)


def rms_db(x: np.ndarray) -> float:
    return amp_to_db(float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0)
