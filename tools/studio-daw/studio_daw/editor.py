"""Engine side of the website DAW (the visual editor for *.song.yaml).

  song_model(song)    everything the editor shows: instruments (+ knob ranges), parsed patterns
                      with exact events, sections, mix — computed by the real parser, so the
                      editor never re-implements the notation
  catalog()           built-in, plugin (project / pack) and pack instruments and effects
  render_sounds(req)  "sample banks": single notes rendered by the real instruments (built-ins,
                      SoundFonts, samples and AI-made plugins alike), cached per user, so the
                      browser can play edits instantly with the actual sounds
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np

from . import registry
from .instruments import (
    GM_DRUMS,
    Instrument,
    InstrumentError,
    KitInstrument,
    SampleInstrument,
    SoundFontInstrument,
    VoiceInstrument,
    make_instrument,
)
from .notation import Event, looks_like_grid
from .song import Song, SongError, parse_yaml

MODEL_VERSION = 1

# drum sound names offered for General MIDI kits (rows of the step grid)
GM_KIT_ROWS = ["kick", "snare", "rim", "clap", "hat", "pedal", "ohat", "tom1", "tom2", "tom3", "floor", "crash", "ride",
               "ridebell", "china", "splash", "cowbell", "tamb", "shaker", "conga", "bongo", "clave", "block", "triangle"]


def _r(x: float) -> float:
    return round(float(x), 6)


def _ev(e: Event) -> dict:
    d = {"t": _r(e.start), "d": _r(e.dur), "l": _r(e.extra.get("len", e.dur)), "v": round(float(e.vel), 4)}
    if e.pitch is not None:
        d["p"] = int(e.pitch)
    if e.key is not None:
        d["k"] = str(e.key)
    if e.extra.get("st"):
        d["s"] = 1
    if e.extra.get("ch"):
        d["c"] = str(e.extra["ch"])
    return d


def track_form(spec) -> tuple[str, dict]:
    """How a pattern track is written: notes | chords | grid | events | voices (+ its options)."""
    if isinstance(spec, list):
        return "voices", {}
    if isinstance(spec, dict):
        for form in ("grid", "chords", "notes", "events"):
            if form in spec:
                return form, {k: v for k, v in spec.items() if k != form}
        return "notes", {}
    if looks_like_grid(str(spec)):
        return "grid", {}
    return "notes", {}


def _jsonable(v):
    return json.loads(json.dumps(v, default=str))


def _norm_effects(effs) -> list[dict]:
    out = []
    for e in effs or []:
        if isinstance(e, str):
            out.append({"use": e})
        elif isinstance(e, dict):
            out.append(_jsonable(e))
    return out


def release_of(inst: Instrument) -> float:
    """Seconds a note keeps sounding after its end (used by the live preview to fade out)."""
    if isinstance(inst, VoiceInstrument):
        try:
            return float(inst.params.get("release", 0.1))
        except (TypeError, ValueError):
            return 0.1
    if isinstance(inst, SoundFontInstrument):
        return 0.35
    if isinstance(inst, SampleInstrument):
        return 0.05 if inst.sustain else 0.0
    return 0.1


def instrument_info(name: str, inst: Instrument, spec: dict, sr: int) -> dict:
    info: dict = {
        "kind": inst.kind,
        "drum": bool(getattr(inst, "drum", False)),
        "describe": inst.describe(),
        "use": spec.get("use") if "kit" not in spec else None,
        "spec": _jsonable(spec),
        "octave": int(spec.get("octave", 4)) if str(spec.get("octave", 4)).lstrip("-").isdigit() else 4,
        "gate": float(spec.get("gate", 0.92)),
        "release": release_of(inst),
        "soundKey": sound_key(inst, sr),
    }
    if isinstance(inst, VoiceInstrument):
        e = inst.entry
        info.update(voice=e.name, source=e.source, doc=e.doc.split("\n")[0], params=_jsonable(inst.params), specs=e.ui())
    if isinstance(inst, KitInstrument):
        info["sounds"] = list(inst.parts)
        info["parts"] = {k: p.describe() for k, p in inst.parts.items()}
        if spec.get("use") in ("drums", "synth/drums"):
            info["source"] = "built-in"
    elif isinstance(inst, SoundFontInstrument):
        info.update(program=inst.program, bank=inst.bank)
        if inst.drum:
            info["sounds"] = GM_KIT_ROWS
    elif isinstance(inst, SampleInstrument):
        info.update(root=inst.root, pitched=inst.pitched, file=inst.path.name)
        if not inst.pitched:
            info["sounds"] = ["hit"]
    elif isinstance(inst, VoiceInstrument) and inst.drum:
        info["sounds"] = [inst.entry.name]
    preset_mix = getattr(inst, "preset_mix", None)
    if preset_mix:
        info["presetMix"] = _jsonable(preset_mix)
    return info


def song_model(song: Song) -> dict:
    raw = song.raw or {}
    raw_patterns = raw.get("patterns") or {}
    patterns = {}
    for pname, pat in song.patterns.items():
        rp = raw_patterns.get(pname) or {}
        tracks = {}
        for inst, seq in pat.tracks.items():
            form, opts = track_form(rp.get(inst))
            tracks[inst] = {"form": form, "opts": _jsonable(opts), "length": _r(seq.length), "events": [_ev(e) for e in seq.events]}
        patterns[pname] = {"length": _r(pat.length), "bars": rp.get("bars"), "tracks": tracks}
    sections = []
    for s in song.sections:
        sections.append({
            "name": s.name, "bars": s.bars, "bpm": s.bpm, "transpose": s.transpose,
            "startQ": _r(s.start_q), "startSec": _r(s.start_sec),
            "play": [{"pattern": p, "opts": _jsonable(o)} for p, o in s.play],
        })
    mix = {}
    for name, m in song.mix.items():
        mm = {k: v for k, v in m.items() if k != "effects"}
        mm["effects"] = _norm_effects(m.get("effects"))
        mix[name] = _jsonable(mm)
    master = _jsonable({k: v for k, v in song.master.items() if k != "effects"})
    master["effects"] = _norm_effects(song.master.get("effects"))
    s = raw.get("song") or {}
    return {
        "ok": True,
        "version": MODEL_VERSION,
        "song": {
            "title": song.title, "bpm": song.bpm, "time": f"{song.meter[0]}/{song.meter[1]}", "meter": list(song.meter),
            "barLen": song.bar_len, "swing": song.swing, "swingUnit": song.swing_unit, "humanize": song.humanize,
            "seed": song.seed, "tail": song.tail, "sampleRate": song.sr, "loop": int(s.get("loop", 1) or 1),
        },
        "instruments": {n: instrument_info(n, i, song.inst_specs[n], song.sr) for n, i in song.instruments.items()},
        "patterns": patterns,
        "sections": sections,
        "implicitArrangement": song.implicit_arrangement,
        "mix": mix,
        "master": master,
        "duration": _r(song.duration),
        "totalBars": song.total_bars,
        "warnings": song.warnings,
        "pluginErrors": registry.PLUGIN_ERRORS,
    }


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------
def catalog() -> dict:
    import sys

    registry.load_builtins()
    registry.load_project_plugins()
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
    from studio_packs import all_packs

    from .synths import SYNTH_KIT

    voices = [{"name": "drums", "doc": "Synth drum kit: " + " ".join(k for k in SYNTH_KIT if k not in ("chh", "openhat")),
               "source": "built-in", "params": {}, "specs": {}, "drum": True, "kit": True, "sounds": list(SYNTH_KIT)}]
    for e in registry.VOICES.values():
        voices.append({"name": e.name, "doc": e.doc.split("\n")[0], "source": e.source, "params": _jsonable(e.params),
                       "specs": e.ui(), "drum": e.drum})
    effects = [{"name": e.name, "doc": e.doc.split("\n")[0], "source": e.source, "params": _jsonable(e.params), "specs": e.ui()}
               for e in registry.EFFECTS.values()]
    packs = []
    for p in all_packs():
        if p.type != "music":
            continue
        for it in p.items.values():
            kind = it.get("kind")
            if kind not in ("instrument", "drumkit", "sample", "kit", "preset", "plugin"):
                continue
            meta = it.get("meta") or {}
            entry = {"use": f"{p.id}/{it['id']}", "kind": kind, "name": it.get("name", it["id"]), "pack": p.manifest.get("name", p.id),
                     "tags": it.get("tags", []), "drum": kind in ("drumkit", "kit") or (kind == "sample" and not meta.get("root") and not meta.get("pitched"))}
            if kind == "plugin":
                entry["params"] = _jsonable(meta.get("params") or {})
                entry["codeAllowed"] = p.code_allowed
            if kind in ("instrument", "drumkit"):
                entry["program"] = meta.get("program")
                entry["family"] = meta.get("family")
            if kind == "kit":
                entry["sounds"] = list((meta.get("map") or {}).keys())
            if kind == "drumkit":
                entry["sounds"] = GM_KIT_ROWS
            packs.append(entry)
    return {
        "ok": True,
        "voices": voices,
        "effects": effects,
        "packs": packs,
        "gmDrums": GM_DRUMS,
        "gmKitRows": GM_KIT_ROWS,
        "pluginErrors": registry.PLUGIN_ERRORS,
        "warnings": registry.WARNINGS,
    }


# ---------------------------------------------------------------------------
# Sound banks
# ---------------------------------------------------------------------------
def _feed(h, inst: Instrument, depth: int = 0) -> None:
    if depth > 6:
        return
    if isinstance(inst, VoiceInstrument):
        e = inst.entry
        h.update(f"voice|{e.name}|{e.source}|{e.code_hash()}|{json.dumps(inst.params, sort_keys=True, default=str)}".encode())
    elif isinstance(inst, SampleInstrument):
        try:
            st = inst.path.stat()
            stamp = f"{st.st_size}|{st.st_mtime_ns}"
        except OSError:
            stamp = "missing"
        h.update(f"sample|{inst.path}|{stamp}|{inst.root}|{inst.pitched}|{inst.sustain}".encode())
    elif isinstance(inst, KitInstrument):
        for k in sorted(inst.parts):
            h.update(f"part|{k}|".encode())
            _feed(h, inst.parts[k], depth + 1)
    elif isinstance(inst, SoundFontInstrument):
        try:
            st = Path(inst.sf2).stat()
            stamp = f"{st.st_size}|{st.st_mtime_ns}"
        except OSError:
            stamp = "missing"
        h.update(f"sf|{inst.sf2}|{stamp}|{inst.bank}|{inst.program}|{inst.drum}|{inst.gain}".encode())
    else:  # instrument classes added later: hash what we can see
        h.update(f"other|{type(inst).__module__}.{type(inst).__name__}|{json.dumps(getattr(inst, '__dict__', {}), sort_keys=True, default=str)}".encode())


def sound_key(inst: Instrument, sr: int) -> str:
    h = hashlib.sha1(f"bank2|{sr}|{registry.engine_hash()}|".encode())
    _feed(h, inst)
    return h.hexdigest()[:20]


def cache_root() -> Path:
    base = os.environ.get("STUDIO_DAW_CACHE")
    root = Path(base) if base else Path.home() / ".cache" / "studio-daw"
    return root / "sounds"


@contextmanager
def _locked(path: Path):
    try:
        import fcntl
    except ImportError:  # not on Linux (local development)
        yield
        return
    with open(path, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _trim(x: np.ndarray, sr: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    level = np.max(np.abs(x), axis=1) if len(x) else np.zeros(0)
    above = np.nonzero(level > 1e-4)[0]
    if not len(above):
        return np.zeros((max(1, int(0.002 * sr)), 2))
    end = min(len(x), int(above[-1]) + int(0.012 * sr))
    y = x[:end].copy()
    fade = min(len(y), int(0.004 * sr))
    if fade > 1:
        y[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return y


MAX_TAIL = 8.0
GAP = 128  # silent samples between notes in a chunk (safe slicing after resampling)
ID_RE = re.compile(r"^[A-Za-z0-9_.:#+\-]{1,80}$")


def _note_event(w: dict) -> tuple[float, Event]:
    d = min(max(float(w.get("d", 0.5)), 0.01), 60.0)
    p = w.get("p")
    return d, Event(0.0, d, int(p) if p is not None else None, float(min(1.0, max(0.02, w.get("v", 0.8)))), w.get("k"))


def _render_notes(inst: Instrument, wanted: list[dict], sr: int) -> list[np.ndarray | str]:
    out: list[np.ndarray | str] = []
    if isinstance(inst, SoundFontInstrument):
        # one FluidSynth pass for all notes (starting it per note would be slow)
        events, starts, slots = [], [], []
        t = 0.0
        for w in wanted:
            d, ev = _note_event(w)
            slot = d + 4.0
            events.append((t, d, ev))
            starts.append(t)
            slots.append(slot)
            t += slot
        try:
            buf = inst.render(events, sr, int(t * sr) + 1)
        except Exception as e:  # noqa: BLE001
            return [f"{type(e).__name__}: {e}"] * len(wanted)
        for s, slot in zip(starts, slots):
            a = int(s * sr)
            out.append(_trim(buf[a : a + int(slot * sr)], sr))
        return out
    for w in wanted:
        d, ev = _note_event(w)
        try:
            buf = inst.render([(0.0, d, ev)], sr, int((d + MAX_TAIL) * sr))
            out.append(_trim(buf, sr))
        except Exception as e:  # noqa: BLE001
            out.append(f"{type(e).__name__}: {e}")
    return out


def _write_chunk(path: Path, data: np.ndarray, sr: int) -> Path:
    import soundfile as sf

    try:
        sf.write(str(path), data.astype(np.float32), sr, format="FLAC", subtype="PCM_16")
        return path
    except Exception:  # noqa: BLE001  (libsndfile without FLAC)
        wav = path.with_suffix(".wav")
        sf.write(str(wav), data.astype(np.float32), sr, subtype="PCM_16")
        return wav


def render_bank(inst: Instrument, key: str, wanted: list[dict], sr: int, root: Path) -> dict:
    d = root / key
    d.mkdir(parents=True, exist_ok=True)
    idx_path = d / "index.json"
    with _locked(d / ".lock"):
        try:
            index = json.loads(idx_path.read_text("utf-8"))
        except (OSError, ValueError):
            index = {}
        missing = []
        seen = set()
        for w in wanted:
            wid = w.get("id")
            if not isinstance(wid, str) or not ID_RE.match(wid) or wid in seen:
                continue
            seen.add(wid)
            e = index.get(wid)
            if not e or "error" in e or not (d / e["f"]).exists():
                missing.append(w)
        if missing:
            slices = _render_notes(inst, missing, sr)
            good = [(w, x) for w, x in zip(missing, slices) if not isinstance(x, str)]
            for w, x in zip(missing, slices):
                if isinstance(x, str):
                    index[w["id"]] = {"error": x}
            if good:
                stereo = any(float(np.max(np.abs(x[:, 0] - x[:, 1]))) > 1e-5 for _, x in good)
                parts, offs = [], []
                off = 0
                for _, x in good:
                    offs.append(off)
                    parts.append(x if stereo else x[:, :1])
                    parts.append(np.zeros((GAP, 2 if stereo else 1)))
                    off += len(x) + GAP
                cat = np.concatenate(parts, axis=0)
                peak = float(np.max(np.abs(cat))) if len(cat) else 0.0
                gain = peak / 0.98 if peak > 1e-9 else 1.0
                name = hashlib.sha1(("|".join(w["id"] for w, _ in good) + str(time.time())).encode()).hexdigest()[:14] + ".flac"
                written = _write_chunk(d / name, cat / gain, sr)
                for (w, x), o in zip(good, offs):
                    index[w["id"]] = {"f": written.name, "o": o, "n": len(x), "g": round(gain, 6), "c": 2 if stereo else 1}
            tmp = idx_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(index), "utf-8")
            tmp.replace(idx_path)
        else:
            try:
                os.utime(idx_path)
            except OSError:
                pass
    out = {}
    for w in wanted:
        e = index.get(w.get("id"))
        if e:
            out[w["id"]] = {**e, "f": f"{key}/{e['f']}"} if "f" in e else e
    return out


def gc_cache(root: Path, max_mb: int = 600, keep_mb: int = 400) -> None:
    if not root.is_dir():
        return
    dirs = []
    total = 0
    for d in root.iterdir():
        if not d.is_dir():
            continue
        size = sum(f.stat().st_size for f in d.iterdir() if f.is_file())
        try:
            mtime = (d / "index.json").stat().st_mtime
        except OSError:
            mtime = 0
        dirs.append((mtime, size, d))
        total += size
    if total <= max_mb * 1024 * 1024:
        return
    for _, size, d in sorted(dirs):
        shutil.rmtree(d, ignore_errors=True)
        total -= size
        if total <= keep_mb * 1024 * 1024:
            break


def render_sounds(req: dict) -> dict:
    """req: {yaml, path, requests: {instrument: [{id, p|k, d (seconds held), v}]}}"""
    data = parse_yaml(str(req.get("yaml") or ""), Path(str(req.get("path") or "song")).name)
    registry.load_builtins()
    registry.load_project_plugins()
    sr = int((data.get("song") or {}).get("sample_rate", 44100) or 44100)
    specs = data.get("instruments") or {}
    project = registry.project_dir()
    root = cache_root()
    sounds, errors = {}, {}
    for name, wanted in (req.get("requests") or {}).items():
        if name not in specs:
            errors[name] = f'unknown instrument "{name}"'
            continue
        spec = specs[name]
        spec_d = {"use": spec} if isinstance(spec, str) else dict(spec or {})
        try:
            inst = make_instrument(name, spec_d, project, [])
        except (InstrumentError, ImportError, SongError) as e:
            errors[name] = str(e) + (registry.plugin_error_hint() if "unknown" in str(e) else "")
            continue
        except Exception as e:  # noqa: BLE001
            errors[name] = f"{type(e).__name__}: {e}"
            continue
        key = sound_key(inst, sr)
        wanted = [w for w in (wanted or []) if isinstance(w, dict)][:400]
        try:
            sounds[name] = {"soundKey": key, "release": release_of(inst), "entries": render_bank(inst, key, wanted, sr, root)}
        except Exception as e:  # noqa: BLE001
            errors[name] = f"{type(e).__name__}: {e}"
    try:
        gc_cache(root)
    except OSError:
        pass
    return {"ok": True, "sr": sr, "sounds": sounds, "errors": errors, "pluginErrors": registry.PLUGIN_ERRORS}
