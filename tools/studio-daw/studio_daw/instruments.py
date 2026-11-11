"""Instruments: what an `instruments:` entry of a song turns into.

  bass:   { use: bass, cutoff: 700 }                    built-in / plugin voice
  piano:  { use: gm-instruments/acoustic-grand-piano }  pack item (SoundFont preset, sample, kit, preset, plugin)
  vox:    { use: sample, file: assets/vox.wav, root: C4 }  sample from the project
  drums:  { use: drums }                                built-in synth kit
  kit:    { kit: { kick: studio-drums/kick-deep, snare: snare, hat: hat } }
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import registry
from .dsp import to_stereo
from .notation import Event, midi_to_freq, note_to_midi

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
from studio_packs import PackError, is_ref, resolve  # noqa: E402

RESERVED = {"use", "params", "file", "root", "pitched", "kit", "gain", "pan", "effects", "octave", "gate", "volume", "mute", "solo", "reverb", "delay", "sustain", "sounds"}

# General MIDI percussion names → notes (channel 10)
GM_DRUMS = {
    "kick": 36, "kick2": 35, "bd": 36, "snare": 38, "sd": 38, "snare2": 40, "rim": 37, "sidestick": 37, "clap": 39,
    "hat": 42, "chh": 42, "hihat": 42, "ohat": 46, "openhat": 46, "pedal": 44, "phh": 44,
    "tom1": 50, "hitom": 50, "tom2": 47, "midtom": 47, "tom3": 45, "lowtom": 45, "floor": 43, "floortom": 41,
    "crash": 49, "crash2": 57, "ride": 51, "ridebell": 53, "bell": 53, "china": 52, "splash": 55,
    "cowbell": 56, "tamb": 54, "tambourine": 54, "shaker": 70, "maracas": 70, "cabasa": 69,
    "conga": 63, "congalow": 64, "congamute": 62, "bongo": 60, "bongolow": 61, "timbale": 65, "timbalelow": 66,
    "agogo": 67, "agogolow": 68, "clave": 75, "claves": 75, "block": 76, "blocklow": 77, "triangle": 81,
    "triangle_mute": 80, "whistle": 72, "guiro": 74, "vibraslap": 58, "cuica": 79,
}


class InstrumentError(Exception):
    pass


class Instrument:
    kind = "instrument"
    drum = False

    def render(self, events: list[tuple[float, float, Event]], sr: int, n: int) -> np.ndarray:
        """events: (start_seconds, dur_seconds, event). Returns stereo (n, 2)."""
        raise NotImplementedError

    def describe(self) -> str:
        return self.kind


def _place(buf: np.ndarray, sig: np.ndarray, start: int) -> None:
    if start >= len(buf) or len(sig) == 0:
        return
    sig = to_stereo(np.asarray(sig, dtype=np.float64))
    end = min(len(buf), start + len(sig))
    buf[start:end] += sig[: end - start]


class VoiceInstrument(Instrument):
    kind = "voice"

    def __init__(self, entry: registry.Entry, params: dict):
        self.entry = entry
        self.params = {**entry.params, **params}
        unknown = [k for k in params if k not in entry.params]
        self.warnings = [f'unknown parameter(s) for "{entry.name}": {", ".join(unknown)} (known: {", ".join(entry.params) or "none"})'] if unknown else []
        self.drum = entry.drum

    def render(self, events, sr, n):
        buf = np.zeros((n, 2))
        for t, d, ev in events:
            freq = midi_to_freq(ev.pitch if ev.pitch is not None else 60)
            sig = self.entry.fn(freq, max(d, 0.005), ev.vel, sr, self.params)
            _place(buf, sig, int(t * sr))
        return buf

    def describe(self):
        return f"{self.entry.name} ({self.entry.source})"


class SampleInstrument(Instrument):
    kind = "sample"

    def __init__(self, path: Path, root: int | None, pitched: bool | None, sustain: bool = False):
        import soundfile as sf

        data, self.file_sr = sf.read(str(path), always_2d=True, dtype="float64")
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        self.data = data[:, :2]
        self.root = root if root is not None else 60
        self.pitched = bool(pitched) if pitched is not None else root is not None
        self.sustain = sustain
        self.path = path
        self.drum = not self.pitched

    def _resampled(self, ratio: float, sr: int) -> np.ndarray:
        ratio = ratio * self.file_sr / sr
        if abs(ratio - 1) < 1e-6:
            return self.data
        n_out = int(len(self.data) / ratio)
        idx = np.arange(n_out) * ratio
        base = np.arange(len(self.data))
        return np.stack([np.interp(idx, base, self.data[:, c]) for c in range(2)], axis=1)

    def render(self, events, sr, n):
        buf = np.zeros((n, 2))
        cache: dict[float, np.ndarray] = {}
        for t, d, ev in events:
            ratio = 2 ** (((ev.pitch if ev.pitch is not None else self.root) - self.root) / 12) if self.pitched else 1.0
            if ratio not in cache:
                cache[ratio] = self._resampled(ratio, sr)
            sig = cache[ratio] * (ev.vel**1.2)
            if self.sustain:
                keep = int((d + 0.05) * sr)
                if keep < len(sig):
                    sig = sig[:keep].copy()
                    fade = min(len(sig), int(0.05 * sr))
                    sig[-fade:] *= np.linspace(1, 0, fade)[:, None]
            _place(buf, sig, int(t * sr))
        return buf

    def describe(self):
        return f"sample {self.path.name}" + (f" (root {self.root})" if self.pitched else "")


class KitInstrument(Instrument):
    kind = "kit"
    drum = True

    def __init__(self, parts: dict[str, Instrument]):
        self.parts = parts

    def render(self, events, sr, n):
        buf = np.zeros((n, 2))
        by: dict[str, list] = {}
        for t, d, ev in events:
            key = ev.key or "kick"
            if key not in self.parts:
                raise InstrumentError(f'kit has no sound "{key}" (has: {", ".join(self.parts)})')
            by.setdefault(key, []).append((t, d, ev))
        for key, evs in by.items():
            buf += self.parts[key].render(evs, sr, n)
        return buf

    def describe(self):
        return "kit: " + ", ".join(self.parts)


class SoundFontInstrument(Instrument):
    """Renders through FluidSynth (one pass per instrument, effects off)."""

    kind = "soundfont"

    def __init__(self, sf2: Path, bank: int, program: int, drum: bool, gain: float = 0.6):
        self.sf2, self.bank, self.program, self.drum, self.gain = sf2, int(bank), int(program), drum, gain

    def render(self, events, sr, n):
        import mido
        import soundfile as sf

        if not events:
            return np.zeros((n, 2))
        mid = mido.MidiFile(ticks_per_beat=960)
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        ch = 9 if self.drum else 0
        tr.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))  # 120 bpm: 1920 ticks per second
        if not self.drum:
            tr.append(mido.Message("control_change", channel=ch, control=0, value=min(127, self.bank), time=0))
        tr.append(mido.Message("program_change", channel=ch, program=self.program, time=0))
        msgs = []
        for t, d, ev in events:
            note = ev.pitch if ev.pitch is not None else GM_DRUMS.get((ev.key or "").lower())
            if note is None and ev.key and ev.key.isdigit():
                note = int(ev.key)
            if note is None:
                raise InstrumentError(f'unknown drum sound "{ev.key}" (GM names: {", ".join(sorted(GM_DRUMS)[:20])} …, or a MIDI note number)')
            vel = max(1, min(127, int(round(ev.vel * 127))))
            on = int(round(t * 1920))
            off = int(round((t + max(d, 0.02)) * 1920))
            msgs.append((on, 1, mido.Message("note_on", channel=ch, note=int(note), velocity=vel)))
            msgs.append((off, 0, mido.Message("note_off", channel=ch, note=int(note), velocity=0)))
        msgs.sort(key=lambda m: (m[0], m[1]))
        now = 0
        for tick, _, msg in msgs:
            msg.time = tick - now
            now = tick
            tr.append(msg)
        with tempfile.TemporaryDirectory() as tmp:
            mf = os.path.join(tmp, "in.mid")
            wf = os.path.join(tmp, "out.wav")
            mid.save(mf)
            cmd = ["fluidsynth", "-ni", "-q", "-g", str(self.gain), "-R", "0", "-C", "0", "-r", str(sr), "-F", wf, str(self.sf2), mf]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0 or not os.path.exists(wf):
                raise InstrumentError(f"fluidsynth failed: {(r.stderr or r.stdout).strip()[:400]}")
            data, _ = sf.read(wf, always_2d=True, dtype="float64")
        out = np.zeros((n, 2))
        m = min(n, len(data))
        out[:m] = to_stereo(data[:m, :2] if data.shape[1] >= 2 else data[:m, 0])
        return out

    def describe(self):
        return f"SoundFont {self.sf2.name} bank {self.bank} program {self.program}" + (" (drums)" if self.drum else "")


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------
def _params(spec: dict) -> dict:
    p = dict(spec.get("params") or {})
    for k, v in spec.items():
        if k not in RESERVED:
            p[k] = v
    return p


def _root(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return note_to_midi(str(value))


def load_pack_plugin(pack, item, path: Path) -> None:
    if not pack.code_allowed:
        raise InstrumentError(
            f'pack "{pack.id}" contains plugin code that an admin has not reviewed yet — it cannot run (Packs page → Mark code as reviewed)'
        )
    registry.load_file(path, f"pack:{pack.id}/{item['id']}")


def make_instrument(name: str, spec, base_dir: Path, warnings: list[str], depth: int = 0) -> Instrument:
    if depth > 5:
        raise InstrumentError(f'instrument "{name}": presets reference each other too deeply')
    if isinstance(spec, str):
        spec = {"use": spec}
    if not isinstance(spec, dict):
        raise InstrumentError(f'instrument "{name}" must be a mapping like {{use: bass}}')
    if "kit" in spec:
        kit = spec["kit"]
        if not isinstance(kit, dict) or not kit:
            raise InstrumentError(f'instrument "{name}": kit must map sound names to instruments')
        return KitInstrument({k: make_instrument(f"{name}.{k}", v, base_dir, warnings, depth + 1) for k, v in kit.items()})
    use = str(spec.get("use", "")).strip()
    if not use:
        raise InstrumentError(f'instrument "{name}" needs "use:" (a built-in like bass/pad/drums, a pack item like pack/item, or "sample")')
    if use == "sample":
        if not spec.get("file"):
            raise InstrumentError(f'instrument "{name}": use: sample needs file: path/to/sound.wav')
        path = (base_dir / str(spec["file"])).resolve()
        if not path.exists():
            raise InstrumentError(f'instrument "{name}": file not found: {spec["file"]}')
        return SampleInstrument(path, _root(spec.get("root")), spec.get("pitched"), bool(spec.get("sustain", False)))
    if use in ("drums", "synth/drums"):
        from .synths import SYNTH_KIT

        # per-sound tweaks:  drums: { use: drums, sounds: { kick: { pitch: 45, decay: 0.6 } } }
        tweaks = spec.get("sounds") or {}
        return KitInstrument({k: VoiceInstrument(registry.VOICES[v], {**pp, **(tweaks.get(k) or {})}) for k, (v, pp) in SYNTH_KIT.items()})
    if use.startswith("synth/"):
        use = use[6:]
    if use in registry.VOICES:
        inst = VoiceInstrument(registry.VOICES[use], _params(spec))
        warnings.extend(f"{name}: {w}" for w in inst.warnings)
        return inst
    if is_ref(use):
        try:
            pack, item, path = resolve(use)
        except PackError as e:
            raise InstrumentError(f'instrument "{name}": {e}') from None
        kind = item.get("kind", "")
        meta = item.get("meta", {}) or {}
        if kind == "plugin":
            if path is None:
                raise InstrumentError(f"{use}: plugin item has no file")
            load_pack_plugin(pack, item, path)
            voice = meta.get("voice") or item["id"]
            if voice not in registry.VOICES:
                raise InstrumentError(f'{use}: the plugin did not register an instrument named "{voice}"')
            inst = VoiceInstrument(registry.VOICES[voice], _params(spec))
            warnings.extend(f"{name}: {w}" for w in inst.warnings)
            return inst
        if kind == "preset":
            data = json.loads(path.read_text("utf-8")) if path else dict(meta)
            merged = {**data, **{k: v for k, v in spec.items() if k != "use"}}
            inst = make_instrument(name, merged, path.parent if path else base_dir, warnings, depth + 1)
            # mix settings of the preset (effects, gain …) — the song's own mix settings win
            inst.preset_mix = {k: data[k] for k in ("effects", "gain", "pan", "reverb", "delay") if k in data}
            return inst
        if kind == "kit":
            mapping = meta.get("map") or {}
            if not mapping:
                raise InstrumentError(f"{use}: kit has no meta.map")
            parts = {}
            for k, ref in mapping.items():
                sub = ref if is_ref(str(ref)) else f"{pack.id}/{ref}"
                parts[k] = make_instrument(f"{name}.{k}", {"use": sub}, base_dir, warnings, depth + 1)
            return KitInstrument(parts)
        if path is None:
            raise InstrumentError(f"{use}: item has no file")
        if meta.get("format") == "sf2" or path.suffix.lower() == ".sf2":
            drum = kind in ("drumkit", "drum") or int(meta.get("bank", 0)) == 128
            return SoundFontInstrument(path, int(meta.get("bank", 128 if drum else 0)), int(meta.get("program", 0)), drum)
        if path.suffix.lower() in (".wav", ".flac", ".ogg", ".aif", ".aiff"):
            root = _root(spec.get("root", meta.get("root")))
            pitched = spec.get("pitched", meta.get("pitched"))
            return SampleInstrument(path, root, pitched, bool(spec.get("sustain", meta.get("sustain", False))))
        raise InstrumentError(f'{use}: items of kind "{kind}" ({path.suffix}) cannot be played')
    known = ", ".join(sorted(registry.VOICES))
    raise InstrumentError(f'instrument "{name}": unknown "{use}". Built-ins: drums, {known}. Pack items look like pack-id/item-id (studio-daw instruments).')
