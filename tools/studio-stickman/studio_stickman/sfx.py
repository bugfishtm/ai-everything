"""Sound: synthesized effects (punch, whoosh, thud …), sound files, the soundtrack and the mix."""
from __future__ import annotations

import math
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

from . import registry
from .api import sound

SR = 44100


# ---------------------------------------------------------------------------
# Small DSP helpers
# ---------------------------------------------------------------------------
def _n(sec: float, sr: int) -> int:
    return max(1, int(sec * sr))


def _decay(n: int, sr: int, t60: float) -> np.ndarray:
    return np.exp(-6.9 * np.arange(n) / (sr * max(t60, 1e-4)))


def _filt(x: np.ndarray, kind: str, fc, sr: int, order: int = 2) -> np.ndarray:
    from scipy import signal

    nyq = sr / 2
    if kind == "band":
        lo, hi = fc
        wn = [max(10.0, lo) / nyq, min(hi, nyq * 0.95) / nyq]
    else:
        wn = min(max(10.0, float(fc)), nyq * 0.95) / nyq
    b, a = signal.butter(order, wn, btype={"low": "lowpass", "high": "highpass", "band": "bandpass"}[kind])
    return signal.lfilter(b, a, x)


def _sweep(f0: float, f1: float, n: int, sr: int, curve: float = 1.0) -> np.ndarray:
    u = (np.arange(n) / max(1, n - 1)) ** curve
    f = f0 * (f1 / f0) ** u
    return np.sin(2 * np.pi * np.cumsum(f) / sr)


# ---------------------------------------------------------------------------
# Sounds — fn(sr, p, rng) -> mono (n,) or stereo (n, 2) float array, peak around 0.5–0.9
# ---------------------------------------------------------------------------
@sound("punch", params={"pitch": 1.0}, doc="a solid hit: low thump + slap")
def punch(sr, p, rng):
    n = _n(0.22, sr)
    body = _sweep(150 * p["pitch"], 52 * p["pitch"], n, sr, 0.5) * _decay(n, sr, 0.16)
    slap = _filt(rng.uniform(-1, 1, n), "band", (900, 4200), sr) * _decay(n, sr, 0.05) * 1.3
    return np.tanh((body * 0.9 + slap) * 1.6) * 0.75


@sound("jab", params={"pitch": 1.0}, doc="a lighter, snappy hit")
def jab(sr, p, rng):
    n = _n(0.13, sr)
    body = _sweep(210 * p["pitch"], 90 * p["pitch"], n, sr, 0.5) * _decay(n, sr, 0.08)
    slap = _filt(rng.uniform(-1, 1, n), "band", (1400, 6000), sr) * _decay(n, sr, 0.03) * 1.2
    return np.tanh((body * 0.7 + slap) * 1.5) * 0.6


@sound("kick", params={"pitch": 1.0}, doc="a heavy kick: deeper and longer than a punch")
def kick(sr, p, rng):
    n = _n(0.3, sr)
    body = _sweep(120 * p["pitch"], 40 * p["pitch"], n, sr, 0.45) * _decay(n, sr, 0.24)
    slap = _filt(rng.uniform(-1, 1, n), "band", (500, 2600), sr) * _decay(n, sr, 0.06) * 1.2
    return np.tanh((body * 1.1 + slap) * 1.8) * 0.8


@sound("thud", params={"pitch": 1.0}, doc="a body or a heavy thing hits the floor")
def thud(sr, p, rng):
    n = _n(0.42, sr)
    body = _sweep(90 * p["pitch"], 34 * p["pitch"], n, sr, 0.5) * _decay(n, sr, 0.32)
    noise = _filt(rng.uniform(-1, 1, n), "low", 420, sr) * _decay(n, sr, 0.12) * 1.4
    return np.tanh((body + noise) * 1.5) * 0.8


@sound("whoosh", params={"dur": 0.28, "pitch": 1.0}, doc="air: a fast swing or dodge")
def whoosh(sr, p, rng):
    n = _n(p["dur"], sr)
    u = np.arange(n) / n
    x = rng.uniform(-1, 1, n)
    lo = _filt(x, "band", (300 * p["pitch"], 900 * p["pitch"]), sr)
    hi = _filt(x, "band", (1200 * p["pitch"], 4200 * p["pitch"]), sr)
    env = np.sin(np.pi * u) ** 2
    y = (lo * (1 - u) + hi * u) * env * 2.2
    return np.stack([y * (1 - u * 0.6), y * (0.4 + u * 0.6)], axis=1) * 0.55


@sound("crash", params={"dur": 0.9}, doc="something breaks: wood and metal")
def crash(sr, p, rng):
    n = _n(p["dur"], sr)
    x = rng.uniform(-1, 1, n)
    y = _filt(x, "band", (400, 7000), sr) * _decay(n, sr, p["dur"] * 0.6)
    y[: _n(0.02, sr)] *= 3
    t = np.arange(n) / sr
    ring = sum(np.sin(2 * np.pi * f * t) for f in (523, 811, 1237, 1790)) * _decay(n, sr, 0.5) * 0.08
    low = _sweep(110, 45, n, sr, 0.5) * _decay(n, sr, 0.25)
    return np.tanh((y * 0.9 + ring + low) * 1.4) * 0.75


@sound("glass", params={}, doc="glass shatters")
def glass(sr, p, rng):
    n = _n(0.8, sr)
    t = np.arange(n) / sr
    y = _filt(rng.uniform(-1, 1, n), "high", 3200, sr) * _decay(n, sr, 0.35) * 0.9
    for i in range(14):
        f = 2200 + rng.random() * 5200
        d = int(rng.random() * 0.25 * sr)
        m = n - d
        y[d:] += np.sin(2 * np.pi * f * t[:m]) * _decay(m, sr, 0.08 + rng.random() * 0.2) * 0.12
    return np.tanh(y * 1.3) * 0.7


@sound("zap", params={"dur": 0.35}, doc="electricity")
def zap(sr, p, rng):
    n = _n(p["dur"], sr)
    t = np.arange(n) / sr
    saw = 2 * ((t * 110) % 1) - 1
    gate = (rng.random(n // 220 + 1).repeat(220)[:n] > 0.35).astype(float)
    y = _filt(saw * gate + rng.uniform(-1, 1, n) * 0.5, "band", (700, 5200), sr)
    return np.tanh(y * 3) * np.minimum(1, (n - np.arange(n)) / (0.03 * sr)) * 0.5


@sound("pop", params={"pitch": 1.0}, doc="a soft pop (appear, bubble)")
def pop(sr, p, rng):
    n = _n(0.09, sr)
    return _sweep(900 * p["pitch"], 240 * p["pitch"], n, sr, 0.6) * _decay(n, sr, 0.06) * 0.7


@sound("ding", params={"pitch": 1.0}, doc="a small bell (idea, success)")
def ding(sr, p, rng):
    n = _n(0.9, sr)
    t = np.arange(n) / sr
    f = 1320 * p["pitch"]
    y = np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.76 * t) + 0.2 * np.sin(2 * np.pi * f * 5.4 * t)
    return y * _decay(n, sr, 0.7) * 0.32


@sound("boing", params={"pitch": 1.0}, doc="a cartoon spring")
def boing(sr, p, rng):
    n = _n(0.5, sr)
    t = np.arange(n) / sr
    f = 180 * p["pitch"] * (1 + 0.7 * np.exp(-t * 6) * np.sin(2 * np.pi * 11 * t))
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * _decay(n, sr, 0.42) * 0.55


@sound("jump", params={"pitch": 1.0}, doc="a quick upward sweep")
def jump_snd(sr, p, rng):
    n = _n(0.16, sr)
    y = _sweep(260 * p["pitch"], 620 * p["pitch"], n, sr) * np.sin(np.pi * np.arange(n) / n)
    return y * 0.35


@sound("land", params={}, doc="feet hit the floor")
def land(sr, p, rng):
    n = _n(0.16, sr)
    y = _sweep(130, 60, n, sr, 0.5) * _decay(n, sr, 0.1) + _filt(rng.uniform(-1, 1, n), "low", 900, sr) * _decay(n, sr, 0.05) * 0.9
    return np.tanh(y * 1.4) * 0.6


@sound("step", params={}, doc="a single footstep")
def step(sr, p, rng):
    n = _n(0.07, sr)
    return _filt(rng.uniform(-1, 1, n), "band", (200, 1500), sr) * _decay(n, sr, 0.04) * 0.9


@sound("knock", params={"times": 3, "gap": 0.16}, doc="knocking on a door")
def knock(sr, p, rng):
    one_n = _n(0.09, sr)
    one = (_sweep(420, 180, one_n, sr, 0.5) + _filt(rng.uniform(-1, 1, one_n), "band", (800, 2600), sr) * 0.7) * _decay(one_n, sr, 0.06)
    times = max(1, int(p["times"]))
    gap = _n(p["gap"], sr)
    y = np.zeros(gap * (times - 1) + one_n)
    for i in range(times):
        y[i * gap : i * gap + one_n] += one
    return np.tanh(y * 1.5) * 0.7


@sound("coin", params={}, doc="pick-up / reward blip")
def coin(sr, p, rng):
    n1, n2 = _n(0.07, sr), _n(0.3, sr)
    t1, t2 = np.arange(n1) / sr, np.arange(n2) / sr
    a = np.sign(np.sin(2 * np.pi * 988 * t1)) * 0.5
    b = np.sign(np.sin(2 * np.pi * 1319 * t2)) * _decay(n2, sr, 0.28) * 0.5
    return _filt(np.concatenate([a, b]), "low", 6000, sr) * 0.5


@sound("powerup", params={}, doc="rising arpeggio")
def powerup(sr, p, rng):
    out = []
    for f in (392, 494, 587, 784, 988):
        n = _n(0.075, sr)
        t = np.arange(n) / sr
        out.append(np.sign(np.sin(2 * np.pi * f * t)) * 0.4 * np.minimum(1, (n - np.arange(n)) / (0.01 * sr)))
    return _filt(np.concatenate(out), "low", 5000, sr) * 0.6


@sound("explosion", params={"dur": 1.4}, doc="a big boom with a rumble")
def explosion(sr, p, rng):
    n = _n(p["dur"], sr)
    x = rng.uniform(-1, 1, n)
    rumble = _filt(x, "low", 260, sr) * _decay(n, sr, p["dur"] * 0.7) * 2.6
    crack = _filt(x, "band", (600, 5000), sr) * _decay(n, sr, 0.18) * 1.2
    sub = _sweep(80, 28, n, sr, 0.4) * _decay(n, sr, 0.6)
    return np.tanh((rumble + crack + sub) * 1.5) * 0.85


@sound("swish", params={}, doc="a short light air sound (cloth, quick turn)")
def swish(sr, p, rng):
    n = _n(0.14, sr)
    u = np.arange(n) / n
    return _filt(rng.uniform(-1, 1, n), "band", (1800, 7000), sr) * np.sin(np.pi * u) ** 2 * 0.5


@sound("slide", params={"dur": 0.5}, doc="something drags across the floor")
def slide(sr, p, rng):
    n = _n(p["dur"], sr)
    u = np.arange(n) / n
    return _filt(rng.uniform(-1, 1, n), "band", (500, 2400), sr) * (1 - u) ** 0.7 * np.minimum(1, u * 30) * 0.6


@sound("alarm", params={"dur": 1.2}, doc="a two-tone alarm")
def alarm(sr, p, rng):
    n = _n(p["dur"], sr)
    t = np.arange(n) / sr
    f = np.where((t * 4).astype(int) % 2 == 0, 880, 660)
    y = np.sign(np.sin(2 * np.pi * np.cumsum(f) / sr)) * 0.3
    return _filt(y, "low", 4000, sr) * np.minimum(1, (n - np.arange(n)) / (0.02 * sr))


# ---------------------------------------------------------------------------
# Files and the mix
# ---------------------------------------------------------------------------
class AudioError(Exception):
    pass


_cache: dict[str, np.ndarray] = {}


def decode(path: Path) -> np.ndarray:
    """Any audio file -> stereo float32 at 44.1 kHz (through ffmpeg)."""
    key = str(path)
    if key in _cache:
        return _cache[key]
    if not path.is_file():
        raise AudioError(f"audio file not found: {path}")
    if not shutil.which("ffmpeg"):
        raise AudioError("ffmpeg is needed to read audio files")
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True)
    if r.returncode != 0:
        raise AudioError(f"cannot read {path.name}: {r.stderr.decode('utf-8', 'replace').strip()[:300]}")
    x = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).astype(np.float64)
    _cache[key] = x
    return x


def resolve_sound(name: str, params: dict, seed: int) -> np.ndarray:
    """A registered sound, an audio file of the project, or a pack item (pack-id/item-id)."""
    n = str(name)
    e = registry.SOUNDS.get(n)
    if e:
        merged = {**e.params, **{k: v for k, v in params.items() if k in e.params}}
        key = f"synth:{n}:{sorted(merged.items())}:{seed}"
        if key not in _cache:
            x = np.asarray(e.fn(SR, merged, np.random.default_rng(seed)), dtype=np.float64)
            _cache[key] = x if x.ndim == 2 else np.stack([x, x], axis=1)
        return _cache[key]
    if n.lower().endswith((".wav", ".mp3", ".ogg", ".flac", ".m4a")):
        return decode((registry.project_dir() / n).resolve())
    if "/" in n:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
        from studio_packs import PackError, resolve

        try:
            _, _, path = resolve(n)
        except PackError as ex:
            raise AudioError(str(ex)) from None
        if path is None:
            raise AudioError(f"{n}: this pack item has no file")
        return decode(path)
    raise AudioError(f'unknown sound "{n}"')


def _place(buf: np.ndarray, x: np.ndarray, t: float, gain: float, pan: float) -> None:
    start = int(t * SR)
    if start >= len(buf) or start < 0:
        return
    end = min(len(buf), start + len(x))
    ang = (max(-1.0, min(1.0, pan)) + 1) * math.pi / 4
    seg = x[: end - start] * gain
    buf[start:end, 0] += seg[:, 0] * math.cos(ang) * math.sqrt(2)
    buf[start:end, 1] += seg[:, 1] * math.sin(ang) * math.sqrt(2)


def music_file(src: Path) -> Path:
    """The soundtrack as an audio file: a studio-daw song (*.song.yaml) is rendered first (and cached)."""
    if not src.name.endswith((".song.yaml", ".song.yml")):
        return src
    if not src.is_file():
        raise AudioError(f"song not found: {src}")
    import hashlib
    import json

    st = src.stat()
    name = f"{src.name.split('.')[0]}-{hashlib.sha1(f'{src}:{st.st_mtime_ns}:{st.st_size}'.encode()).hexdigest()[:12]}"
    cache = registry.project_dir() / ".studio" / "cache" / "stick"
    out = cache / f"{name}.wav"
    if out.is_file() and out.stat().st_size > 0:
        return out
    cache.mkdir(parents=True, exist_ok=True)
    exe = shutil.which("studio-daw")
    cmd = [exe] if exe else [sys.executable, str(Path(__file__).resolve().parents[2] / "studio-daw" / "bin" / "studio-daw")]
    try:
        r = subprocess.run(cmd + ["render", str(src), "--json", "--out", str(cache), "--name", name, "--format", "wav"], capture_output=True, text=True,
                           cwd=str(registry.project_dir()), timeout=1800)
        data = json.loads((r.stdout or "").strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired) as e:
        raise AudioError(f"studio-daw could not render {src.name}: {e}") from None
    made = (data.get("files") or {}).get("wav")
    if not data.get("ok") or not made or not Path(made).is_file():
        raise AudioError(f"studio-daw could not render {src.name}: {data.get('error') or 'no audio file'}")
    return Path(made)


def build_audio(scene, t0: float, t1: float) -> tuple[np.ndarray | None, dict]:
    """The mixed sound of the scene between t0 and t1 (None when there is nothing to hear)."""
    info = {"sfx": 0, "music": None, "peak_db": None}
    n = int((t1 - t0) * SR) + 1
    buf = np.zeros((n, 2))
    sfx_gain = 10 ** (scene.sfx_gain / 20)
    used = False
    for i, ev in enumerate(scene.events):
        if ev["kind"] == "sfx":
            name, params = ev["value"], {k: v for k, v in ev.items() if k not in ("kind", "t", "value", "gain", "pan", "_where")}
        elif ev["kind"] == "hit" and ev.get("sfx"):
            name, params = ev["sfx"], {}
        elif ev["kind"] == "say" and ev.get("sfx"):
            # a quiet blip when a speech bubble opens, from the side the speaker stands on
            name, params = ev["sfx"], {}
            who = scene.figures.get(str(ev.get("who")))
            ev = {**ev, "gain": 0.32, "pan": ((who.state(ev["t"])["x"] / scene.world_w - 0.5) * 0.9) if who else 0.0}
        else:
            continue
        if ev["t"] < t0 - 3 or ev["t"] > t1:
            continue
        x = resolve_sound(name, params, scene.seed * 1000 + i)
        pan = ev.get("pan")
        if pan is None:
            pan = 0.0
            if ev["kind"] == "hit":
                pan = (scene.hit_point(ev)[0] / scene.world_w - 0.5) * 0.9
        rel = ev["t"] - t0
        if rel < 0:
            cut = int(-rel * SR)
            if cut >= len(x):
                continue
            x, rel = x[cut:], 0.0
        _place(buf, x, rel, float(ev.get("gain", 1.0)) * sfx_gain, float(pan))
        info["sfx"] += 1
        used = True
    if scene.audio:
        music = decode(music_file((registry.project_dir() / str(scene.audio)).resolve()))
        start = int((t0 - scene.audio_offset) * SR)
        seg = music[max(0, start) : max(0, start) + n]
        lead = max(0, -start)
        if len(seg) and lead < n:
            m = min(len(seg), n - lead)
            buf[lead : lead + m] += seg[:m] * 10 ** (scene.audio_gain / 20)
            used = True
        info["music"] = {"file": str(scene.audio), "seconds": round(len(music) / SR, 2)}
    if not used:
        return None, info
    peak = float(np.max(np.abs(buf))) if len(buf) else 0.0
    if peak > 0.98:
        buf = np.tanh(buf / peak * 1.25) / math.tanh(1.25) * 0.97   # gentle limiting instead of clipping
    info["peak_db"] = round(20 * math.log10(max(peak, 1e-9)), 1)
    return buf, info


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
