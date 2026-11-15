"""Sound: synthesized effects (punch, whoosh, thud …), sound files, the soundtrack and the mix."""
from __future__ import annotations

import math
import os
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


@sound("block", params={"pitch": 1.0}, doc="a blow stopped by a guard: a short dull knock, no slap")
def block(sr, p, rng):
    n = _n(0.12, sr)
    body = _sweep(260 * p["pitch"], 140 * p["pitch"], n, sr, 0.5) * _decay(n, sr, 0.06)
    tap = _filt(rng.uniform(-1, 1, n), "band", (500, 1800), sr) * _decay(n, sr, 0.02) * 0.8
    return np.tanh((body + tap) * 1.6) * 0.6


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
AUDIO_EXT = (".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".opus")

# How loud each built-in sound is at gain 1 (dBFS of its loudest 50 ms). Synthesized sounds came out
# between -31.5 (step) and -5.7 dB (explosion), so a footstep at gain 1 was inaudible next to an alarm;
# now each is scaled to its level here: hits loudest, small sounds a little lower.
LEVELS = {"punch": -10.0, "kick": -9.0, "thud": -9.5, "crash": -9.0, "explosion": -7.5, "jab": -13.0, "glass": -12.0, "block": -13.0, "land": -14.0,
          "knock": -14.0, "zap": -14.0, "boing": -14.0, "whoosh": -15.0, "ding": -15.0, "coin": -15.0, "powerup": -15.0, "slide": -16.0,
          "pop": -16.0, "jump": -16.0, "alarm": -16.0, "swish": -17.0, "step": -18.0}


def resolve_audio_path(scene, value) -> Path:
    """Where an audio file named in a scene is: an absolute path, else the project folder first, then the
    folder of the scene file. When it is in neither, the project path (for the error message)."""
    p = Path(str(value))
    if p.is_absolute():
        return p
    project = (registry.project_dir() / p).resolve()
    if project.exists():
        return project
    spath = getattr(scene, "path", None)
    if spath:
        local = (Path(spath).resolve().parent / p).resolve()
        if local.exists():
            return local
    return project


def _looked(scene, value) -> str:
    def short(p: Path) -> str:
        try:
            rel = os.path.relpath(p, Path.cwd())
            return "./" if rel == "." else rel if not rel.startswith("..") else str(p)
        except ValueError:                      # another drive (Windows)
            return str(p)

    places = [registry.project_dir().resolve()]
    spath = getattr(scene, "path", None)
    if spath and Path(spath).resolve().parent not in places:
        places.append(Path(spath).resolve().parent)
    return f"looked in {' and '.join(short(p) for p in places)}"


def _check_params(name: str, params: dict) -> None:
    """Values that would crash the synthesizer (pitch 0 divided by zero and silenced the whole video)."""
    if "pitch" in params:
        try:
            p = float(params["pitch"])
        except (TypeError, ValueError):
            raise AudioError(f'sound "{name}": pitch must be a number, got {params["pitch"]!r}') from None
        if not 0.05 <= p <= 8:
            raise AudioError(f'sound "{name}": pitch must be between 0.05 and 8 (1 = normal), got {p:g}')
    if "dur" in params:
        try:
            d = float(params["dur"])
        except (TypeError, ValueError):
            raise AudioError(f'sound "{name}": dur must be seconds, got {params["dur"]!r}') from None
        if not 0 < d <= 10:
            raise AudioError(f'sound "{name}": dur must be more than 0 and at most 10 seconds, got {d:g}')


def _sound_refs(scene):
    """Every sound a scene asks for: (where, name, params)."""
    for ev in scene.events:
        where = ev.get("_where", "events")
        if ev["kind"] == "sfx":
            yield where, ev["value"], {k: v for k, v in ev.items() if k not in ("kind", "t", "value", "gain", "pan", "_where")}
        elif ev["kind"] in ("hit", "say") and ev.get("sfx"):
            yield where, ev["sfx"], {}


def validate_audio(scene) -> list[str]:
    """Fast warnings ("<where>: <message>") for the scene's sound: missing or unreadable audio files, a song
    that is not there, unknown sounds and bad sound parameters — what `render` would otherwise drop."""
    out: list[str] = []
    if scene.audio:
        p = resolve_audio_path(scene, scene.audio)
        name = str(scene.audio)
        if name.endswith((".song.yaml", ".song.yml")):
            if not p.is_file():
                out.append(f"scene.audio: song not found: {name} ({_looked(scene, name)})")
            else:
                try:
                    import yaml

                    data = yaml.safe_load(p.read_text("utf-8")) or {}
                    if not isinstance(data, dict) or not isinstance(data.get("song"), dict):
                        out.append(f"scene.audio: {name} is not a studio-daw song (no song: section)")
                except Exception as e:  # noqa: BLE001
                    out.append(f"scene.audio: cannot read the song {name}: {type(e).__name__}: {e}")
        elif not p.is_file():
            out.append(f"scene.audio: file not found: {name} ({_looked(scene, name)})")
        else:
            err = _probe(p)
            if err:
                out.append(f"scene.audio: cannot read {name}: {err}")
    seen: set = set()
    for where, name, params in _sound_refs(scene):
        n = str(name)
        try:
            if n in registry.SOUNDS:
                e = registry.SOUNDS[n]
                _check_params(n, {**e.params, **{k: v for k, v in params.items() if k in e.params}})
            elif n.lower().endswith(AUDIO_EXT):
                if n in seen:
                    continue
                seen.add(n)
                p = resolve_audio_path(scene, n)
                if not p.is_file():
                    out.append(f"{where}: sound file not found: {n} ({_looked(scene, n)})")
                else:
                    err = _probe(p)
                    if err:
                        out.append(f"{where}: cannot read the sound file {n}: {err}")
            elif "/" in n:
                if n in seen:
                    continue
                seen.add(n)
                try:
                    _pack_path(n)
                except AudioError as ex:
                    out.append(f"{where}: {ex}")
            else:
                out.append(f'{where}: unknown sound "{n}"{registry.suggest(n, registry.SOUNDS)} (studio-stickman list sounds)')
        except AudioError as ex:
            out.append(f"{where}: {ex}")
    return out


def _probe(path: Path) -> str | None:
    """None when ffmpeg can decode the start of the file, else the reason."""
    if not shutil.which("ffmpeg"):
        return None
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-t", "0.2", "-i", str(path), "-f", "null", "-"], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as e:
        return str(e)
    if r.returncode != 0:
        return r.stderr.decode("utf-8", "replace").strip().splitlines()[-1][:200] if r.stderr else "ffmpeg cannot decode it"
    return None


def _pack_path(n: str) -> Path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
    try:
        from studio_packs import PackError, resolve
    except ImportError:
        raise AudioError(f"{n}: packs are not available here") from None
    try:
        _, _, path = resolve(n)
    except PackError as ex:
        raise AudioError(str(ex)) from None
    if path is None:
        raise AudioError(f"{n}: this pack item has no file")
    return Path(path)


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


def _level_db(x: np.ndarray) -> float:
    """Loudness of a short sound: the RMS of its loudest 50 ms, in dBFS."""
    m = x.mean(axis=1) if x.ndim == 2 else x
    w = int(0.05 * SR)
    if len(m) <= w:
        return 10 * math.log10(float(np.mean(m * m)) + 1e-12)
    c = np.concatenate([[0.0], np.cumsum(m * m)])
    return 10 * math.log10(float((c[w:] - c[:-w]).max() / w) + 1e-12)


def resolve_sound(name: str, params: dict, seed: int, scene=None, vary: bool = False) -> np.ndarray:
    """A registered sound, an audio file (project folder, then the scene's folder), or a pack item
    (pack-id/item-id). Built-in sounds come at their level in LEVELS; vary: this instance a little
    higher or lower in pitch (±4 %) and level (±1.5 dB) than the last one, so ten punches are not ten copies."""
    n = str(name)
    e = registry.SOUNDS.get(n)
    if e:
        merged = {**e.params, **{k: v for k, v in params.items() if k in e.params}}
        _check_params(n, merged)
        key = f"synth:{n}:{sorted(merged.items())}:{seed}:{vary}"
        if key not in _cache:
            x = np.asarray(e.fn(SR, merged, np.random.default_rng(seed)), dtype=np.float64)
            x = x if x.ndim == 2 else np.stack([x, x], axis=1)
            if not np.all(np.isfinite(x)):
                raise AudioError(f'sound "{n}" made invalid samples (NaN or infinite)')
            if e.source == "built-in" and n in LEVELS and len(x):
                x = x * 10 ** ((LEVELS[n] - _level_db(x)) / 20)
            if vary and len(x) > 8:
                rng = np.random.default_rng(seed * 7 + 3)
                k = 1 + rng.uniform(-0.04, 0.04)
                src = np.arange(0, len(x) - 1, k)
                x = np.stack([np.interp(src, np.arange(len(x)), x[:, ch]) for ch in (0, 1)], axis=1)
                x *= 10 ** (rng.uniform(-1.5, 1.5) / 20)
            _cache[key] = x
        return _cache[key]
    if n.lower().endswith(AUDIO_EXT):
        path = resolve_audio_path(scene, n) if scene is not None else (registry.project_dir() / n).resolve()
        if not path.is_file():
            raise AudioError(f"sound file not found: {n}" + (f" ({_looked(scene, n)})" if scene is not None else ""))
        return decode(path)
    if "/" in n:
        return decode(_pack_path(n))
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


GAIT_STEPS = {"walk": 0.3, "run": 0.42, "sneak": 0.12}     # footstep gain per gait


def _footsteps(scene, t0: float, t1: float) -> list[tuple[float, float, float, int]]:
    """Automatic footsteps (t, gain, pan, seed) of walking, running and sneaking figures: the moments a
    foot comes down on the floor, found from the figures' own movement."""
    out = []
    rate = 100.0
    for fi, f in enumerate(scene.figures.values()):
        keys = list(getattr(f, "keys", []) or [])
        spans = []
        for j, a in enumerate(keys):
            b = keys[j + 1] if j + 1 < len(keys) else None
            names = [nm for nm, _ in (a.fx or [])] + ([nm for nm, _ in (b.fx or [])] if b else [])
            if any(nm in GAIT_STEPS for nm in names):
                spans.append((a.t, b.t if b else scene.duration))
        for s0, s1 in spans:
            s0, s1 = max(s0, t0 - 0.5), min(s1, t1)
            if s1 <= s0:
                continue
            lifted = {"R": False, "L": False}
            # on a grid of absolute times: a partial render finds the same steps as the full one
            for t in np.arange(math.ceil(s0 * rate), math.ceil(s1 * rate)) / rate:
                st, P = f.joints(float(t))
                gait = next((nm for nm in (st.get("fx") or []) if nm in GAIT_STEPS), None)
                if not gait or not st.get("visible", True) or abs(st.get("rot", 0)) > 1:
                    lifted = {"R": False, "L": False}
                    continue
                ground = scene.floor - 5 * f.scale - float(st.get("y", 0.0) or 0.0)
                for side in "RL":
                    h = ground - P[side + "foot"][1]
                    if h > 4.0 * f.scale:
                        lifted[side] = True
                    elif lifted[side] and h < 1.2 * f.scale:
                        lifted[side] = False
                        pan = (P[side + "foot"][0] / scene.world_w - 0.5) * 0.9
                        out.append((float(t), GAIT_STEPS[gait] * math.sqrt(f.scale), pan, fi * 100003 + int(t * 1000)))
    return out


def _blocks_max(x: np.ndarray, blk: int) -> np.ndarray:
    a = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    nb = (len(a) + blk - 1) // blk
    pad = np.zeros(nb * blk)
    pad[: len(a)] = a
    return pad.reshape(nb, blk).max(axis=1)


def _limit(buf: np.ndarray, ceiling: float = 0.97) -> tuple[np.ndarray, float, int]:
    """A look-ahead peak limiter: the gain goes down only around samples that would go over the ceiling
    (starting 5 ms before them, back up over about 80 ms); everything else stays exactly as mixed.
    The old limiter bent every sample of the mix through tanh as soon as one peak was too loud, and its
    result depended on the render range. Returns (sound, largest reduction in dB, where in samples)."""
    blk = 32
    need = np.minimum(1.0, ceiling / np.maximum(_blocks_max(buf, blk), 1e-9))
    if need.min() >= 1.0:
        return buf, 0.0, 0
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    hold = max(1, int(round(0.005 * SR / blk)))
    g = minimum_filter1d(need, size=2 * hold + 1, mode="nearest")
    # a short average after the hold: smooth, and still never above what any sample in reach needs
    g = np.minimum(g, uniform_filter1d(g, size=max(1, hold), mode="nearest"))
    g[g > 1.0 - 1e-9] = 1.0                            # an average of ones is not always exactly one
    rel = blk / (0.08 * SR)
    out = g.copy()
    idx = np.flatnonzero(g < 1.0)
    i, nb = int(idx[0]), len(g)
    cur = 1.0
    while i < nb:
        cur = min(g[i], cur + (1.0 - cur) * rel)
        out[i] = cur
        if cur > 0.99995 and g[i] >= 1.0:          # recovered: jump to the next block that needs less gain
            nxt = idx[np.searchsorted(idx, i)] if np.searchsorted(idx, i) < len(idx) else nb
            out[i:nxt] = 1.0
            i, cur = int(nxt), 1.0
            continue
        i += 1
    centres = np.arange(nb) * blk + (blk - 1) / 2
    gain = np.interp(np.arange(len(buf)), centres, out)
    worst = int(np.argmin(out))
    return buf * gain[:, None], round(-20 * math.log10(max(float(out[worst]), 1e-9)), 1), worst * blk


def _duck(music: np.ndarray, fx: np.ndarray, depth_db: float = 4.0) -> np.ndarray:
    """The music steps back (up to 4 dB) while sound effects play, so hits are heard over it:
    an envelope of the effects with 50 ms attack and 300 ms release."""
    blk = 441                                          # 10 ms
    env = _blocks_max(fx, blk)
    if env.max() < 0.02:
        return music
    target = np.clip(env / 0.25, 0.0, 1.0) * depth_db
    att, rel = 1 - math.exp(-1 / 5.0), 1 - math.exp(-1 / 30.0)
    db = np.empty(len(target))
    cur = 0.0
    for i, v in enumerate(target.tolist()):           # 100 steps a second: cheap even for long scenes
        cur += (v - cur) * (att if v > cur else rel)
        db[i] = cur
    centres = np.arange(len(db)) * blk + (blk - 1) / 2
    gain = 10 ** (-np.interp(np.arange(len(music)), centres, db) / 20)
    return music * gain[:, None]


def build_audio(scene, t0: float, t1: float) -> tuple[np.ndarray | None, dict]:
    """The mixed sound of the scene between t0 and t1 (None when there is nothing to hear).
    A sound that cannot be made is left out with a warning in info["warnings"] — the rest still plays."""
    info = {"sfx": 0, "music": None, "peak_db": None, "limited_db": 0.0, "footsteps": 0, "warnings": []}
    n = int((t1 - t0) * SR) + 1
    fx = np.zeros((n, 2))
    sfx_gain = 10 ** (float(scene.sfx_gain) / 20)

    def place(x: np.ndarray, t: float, gain: float, pan: float) -> bool:
        rel = t - t0
        if rel < 0:
            cut = int(-rel * SR)
            if cut >= len(x):
                return False
            x, rel = x[cut:], 0.0
        if not math.isfinite(gain) or not math.isfinite(pan):
            raise AudioError(f"gain and pan must be numbers (got {gain}, {pan})")
        _place(fx, x, rel, gain * sfx_gain, pan)
        return True

    for i, ev in enumerate(scene.events):
        where = ev.get("_where", f"events[{i}]")
        if ev["kind"] == "sfx":
            name, params = ev["value"], {k: v for k, v in ev.items() if k not in ("kind", "t", "value", "gain", "pan", "_where")}
        elif ev["kind"] == "hit" and ev.get("sfx"):
            name, params = ev["sfx"], {}
        elif ev["kind"] == "say" and ev.get("sfx"):
            name, params = ev["sfx"], {}
        else:
            continue
        if ev["t"] < t0 - 3 or ev["t"] > t1:
            continue
        try:
            if ev["kind"] == "say":
                # a quiet blip when a speech bubble opens, from the side the speaker stands on
                who = scene.figures.get(str(ev.get("who")))
                gain, pan = 0.32, ((who.state(ev["t"])["x"] / scene.world_w - 0.5) * 0.9) if who else 0.0
            else:
                gain, pan = float(ev.get("gain", 1.0)), ev.get("pan")
                if pan is None:
                    pan = (scene.hit_point(ev)[0] / scene.world_w - 0.5) * 0.9 if ev["kind"] == "hit" else 0.0
            x = resolve_sound(name, params, scene.seed * 1000 + i, scene, vary=ev["kind"] != "sfx" or str(name) in registry.SOUNDS)
            if place(x, ev["t"], gain, float(pan)):
                info["sfx"] += 1
            # a strike that lands is heard swinging through the air first
            if ev["kind"] == "hit" and str(where).startswith("timeline.") and str(name) not in ("whoosh", "swish"):
                w = resolve_sound("whoosh", {"dur": 0.18, "pitch": 1.15}, scene.seed * 1000 + i + 500, vary=True)
                place(w, ev["t"] - 0.17, 0.4 * min(1.2, gain), float(pan))
        except Exception as e:  # noqa: BLE001  (one bad sound must not silence the video)
            info["warnings"].append(f"{where}: sound '{name}' left out: {e if isinstance(e, AudioError) else f'{type(e).__name__}: {e}'}")
    if getattr(scene, "footsteps", True) is not False:
        try:
            for t, gain, pan, seed in _footsteps(scene, t0, t1):
                if place(resolve_sound("step", {}, seed, vary=True), t, gain, pan):
                    info["footsteps"] += 1
        except Exception as e:  # noqa: BLE001
            info["warnings"].append(f"footsteps left out: {type(e).__name__}: {e}")
    used = info["sfx"] > 0 or info["footsteps"] > 0
    buf = fx
    if scene.audio:
        try:
            src = resolve_audio_path(scene, scene.audio)
            if not src.is_file():
                song = str(scene.audio).endswith((".song.yaml", ".song.yml"))
                raise AudioError(f"{'song' if song else 'file'} not found: {scene.audio}")
            music = decode(music_file(src))
            info["music"] = {"file": str(scene.audio), "seconds": round(len(music) / SR, 2)}
            start = int(round((t0 - scene.audio_offset) * SR))
            seg = music[max(0, start) : max(0, start) + n]
            lead = max(0, -start)
            if len(seg) and lead < n:
                m = min(len(seg), n - lead)
                track = np.zeros((n, 2))
                track[lead : lead + m] = seg[:m] * 10 ** (float(scene.audio_gain) / 20)
                buf = fx + (_duck(track, fx) if used else track)
                used = True
        except Exception as e:  # noqa: BLE001
            where = "scene.audio"
            msg = str(e) if isinstance(e, AudioError) else f"{type(e).__name__}: {e}"
            if isinstance(e, AudioError) and "not found" in msg:
                msg += f" ({_looked(scene, scene.audio)})"
            info["warnings"].append(f"{where}: no music: {msg}")
    if not used:
        return None, info
    buf, reduced, at = _limit(buf)
    peak = float(np.max(np.abs(buf))) if len(buf) else 0.0
    info["peak_db"] = round(20 * math.log10(max(peak, 1e-9)), 1)
    info["limited_db"] = reduced
    if reduced > 3.0:
        info["warnings"].append(f"the sound is too loud: the limiter turned it down by {reduced:.1f} dB at {t0 + at / SR:.2f}s "
                                "(lower scene.sfx_gain, scene.audio_gain or the gain of the loudest sounds)")
    return buf, info


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
