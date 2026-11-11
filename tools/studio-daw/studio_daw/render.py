"""Rendering: events → instrument stems → effects/mix → master → files + report."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np

from . import dsp, registry
from .instruments import GM_DRUMS
from .song import Song

DEFAULT_TARGET_LUFS = -14.0


def _effect_chain(spec: dict) -> list[tuple[str, dict]]:
    chain: list[tuple[str, dict]] = []
    for eff in spec.get("effects") or []:
        if isinstance(eff, str):
            chain.append((eff, {}))
        else:
            e = dict(eff)
            name = e.pop("use")
            chain.append((name, e))
    if spec.get("delay"):
        chain.append(("delay", {"mix": float(spec["delay"])}))
    if spec.get("reverb"):
        chain.append(("reverb", {"mix": float(spec["reverb"])}))
    return chain


def _apply(chain, x, sr, ctx):
    for name, params in chain:
        entry = registry.EFFECTS[name]
        x = entry.fn(dsp.to_stereo(x), sr, {**entry.params, **params}, ctx)
    return x


def render_song(song: Song, *, from_bar=None, to_bar=None) -> dict:
    sr = song.sr
    events = song.events(from_bar, to_bar)
    if from_bar or to_bar:
        span = max((t + d for evs in events.values() for t, d, _ in evs), default=0.0)
    else:
        span = song.duration
    n = int((span + song.tail) * sr) + 1
    solos = {k for k, m in song.mix.items() if m.get("solo")}
    raw: dict[str, np.ndarray] = {}
    note_counts: dict[str, int] = {}
    for name, evs in events.items():
        m = song.mix.get(name, {})
        if m.get("mute") or (solos and name not in solos):
            continue
        raw[name] = song.instruments[name].render(evs, sr, n)
        note_counts[name] = len(evs)
    beat = 60.0 / song.bpm
    warnings: list[str] = []
    # where this render starts in the song (an excerpt with --from starts later than bar 1)
    offset = song._q_to_sec((from_bar - 1) * song.bar_len) if from_bar else 0.0

    def at(pos) -> float:
        """A bar number (from 1, 2.5 = the middle of bar 2) or a section name -> seconds in this render."""
        try:
            bar = float(pos)
        except (TypeError, ValueError):
            name = str(pos).strip()
            sec = next((s for s in song.sections if s.name == name), None)
            if sec is None:
                names = ", ".join(dict.fromkeys(s.name for s in song.sections))
                raise ValueError(f'"{name}" is neither a bar number nor a section ({names})') from None
            return sec.start_sec - offset
        return song._q_to_sec((bar - 1) * song.bar_len) - offset

    ctx_base = {"bpm": song.bpm, "beat": beat, "stems": raw, "warnings": warnings, "sr": sr, "at": at, "offset": offset, "bar_len": song.bar_len}
    stems: dict[str, np.ndarray] = {}
    for name, buf in raw.items():
        m = song.mix.get(name, {})
        x = _apply(_effect_chain(m), buf, sr, {**ctx_base, "track": name})
        gain_db = float(m.get("gain", m.get("volume", 0)))
        x = dsp.pan(x, float(m.get("pan", 0))) * dsp.db_to_amp(gain_db)
        stems[name] = x
    master = np.zeros((n, 2))
    for x in stems.values():
        master += x
    master = dsp.highpass(master, 22, sr)
    master = _apply(_effect_chain(song.master), master, sr, {**ctx_base, "track": "master"})
    target = song.master.get("target", DEFAULT_TARGET_LUFS)
    ceiling = float(song.master.get("ceiling", -1.0))
    loud_before = dsp.lufs(master, sr)
    if target is not None and loud_before > -69:
        master = master * dsp.db_to_amp(float(target) - loud_before)
    master = dsp.limiter(master, sr, ceiling)
    if song.master.get("fade_out"):
        master = dsp.fade(master, sr, 0, float(song.master["fade_out"]))
    # trim trailing silence (keep a short tail)
    level = np.max(np.abs(master), axis=1)
    above = np.nonzero(level > 1e-4)[0]
    end = min(len(master), (above[-1] + int(0.25 * sr)) if len(above) else len(master))
    master = master[:end]
    stems = {k: v[:end] for k, v in stems.items()}
    return {
        "master": master,
        "stems": stems,
        "notes": note_counts,
        "warnings": warnings,
        "lufs": dsp.lufs(master, sr),
        "peak": dsp.peak_db(master),
        "events": events,
    }


# ---------------------------------------------------------------------------
def write_audio(path: Path, x: np.ndarray, sr: int) -> None:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(x, -1, 1).astype(np.float32), sr, subtype="PCM_24")


def to_mp3(wav: Path) -> Path | None:
    if not shutil.which("ffmpeg"):
        return None
    mp3 = wav.with_suffix(".mp3")
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame", "-qscale:a", "2", str(mp3)], capture_output=True)
    return mp3 if r.returncode == 0 else None


# General MIDI programs for the built-in synths (so other DAWs pick a sensible sound)
GM_PROGRAM = {"sine": 80, "triangle": 80, "square": 80, "saw": 81, "bass": 38, "lead": 81, "pad": 89, "strings": 48,
              "pluck": 25, "epiano": 4, "bell": 14, "organ": 16}
_DRUM_GUESS = [("kick", 36), ("bd", 36), ("snare", 38), ("sd", 38), ("clap", 39), ("rim", 37), ("stick", 37), ("ohat", 46),
               ("open", 46), ("pedal", 44), ("hat", 42), ("hh", 42), ("crash", 49), ("ride", 51), ("splash", 55),
               ("china", 52), ("cowbell", 56), ("tamb", 54), ("shaker", 70), ("conga", 63), ("bongo", 60), ("clave", 75),
               ("block", 76), ("triangle", 81), ("floor", 43), ("tom", 45), ("perc", 70), ("fx", 49), ("impact", 49),
               ("boom", 36), ("s", 38)]


def _drum_note(key: str | None, assigned: dict) -> int:
    k = (key or "kick").lower()
    if k in GM_DRUMS:
        return GM_DRUMS[k]
    if k.isdigit():
        return int(k)
    if k in assigned:
        return assigned[k]
    for word, note in _DRUM_GUESS:
        if word in k and (len(word) > 1 or k == word):
            assigned[k] = note
            return note
    free = [n for n in range(35, 82) if n not in assigned.values() and n not in GM_DRUMS.values()]
    assigned[k] = free[0] if free else 36
    return assigned[k]


def _program_of(inst) -> tuple[int, int]:
    """(bank, program) for an instrument."""
    from .instruments import SoundFontInstrument, VoiceInstrument

    if isinstance(inst, SoundFontInstrument):
        return inst.bank, inst.program
    if isinstance(inst, VoiceInstrument):
        return 0, GM_PROGRAM.get(inst.entry.name, 0)
    return 0, 0


def sec_to_q(song: Song, t: float) -> float:
    """Seconds → quarter notes from the song start (follows tempo changes of sections)."""
    for s in song.sections:
        end = s.start_sec + s.bars * song.bar_len * 60 / s.bpm
        if t < end - 1e-9:
            return s.start_q + max(0.0, t - s.start_sec) * s.bpm / 60
    if not song.sections:
        return t * song.bpm / 60
    last = song.sections[-1]
    return last.start_q + (t - last.start_sec) * last.bpm / 60


def write_midi(path: Path, song: Song, events: dict, from_bar: float | None = None) -> None:
    """Type-1 MIDI file: tempo map of the sections, one track per instrument (drums on channel 10)."""
    import mido

    tpq = 480
    mid = mido.MidiFile(ticks_per_beat=tpq, type=1)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("track_name", name=song.title, time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=song.meter[0], denominator=song.meter[1], time=0))
    offset_q = (from_bar - 1) * song.bar_len if from_bar else 0.0
    tempos = []
    prev = None
    for s in song.sections:
        q = s.start_q - offset_q
        if q < -1e-9:
            prev = s.bpm
            continue
        if s.bpm != prev:
            tempos.append((int(round(q * tpq)), s.bpm))
            prev = s.bpm
    if not tempos or tempos[0][0] > 0:
        tempos.insert(0, (0, prev or song.bpm))
    now = 0
    for tick, bpm in tempos:
        meta.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=tick - now))
        now = tick
    mid.tracks.append(meta)

    # events of an excerpt (--from) start at 0 → shift them back to song time for the tempo map
    base_sec = song._q_to_sec(offset_q) if from_bar else 0.0

    def to_tick(t_sec: float) -> int:
        return max(0, int(round((sec_to_q(song, t_sec + base_sec) - offset_q) * tpq)))

    ch_next = 0
    assigned: dict = {}
    for name, evs in events.items():
        inst = song.instruments[name]
        drum = bool(getattr(inst, "drum", False))
        if drum:
            ch = 9
        else:
            ch = ch_next
            ch_next = (ch_next + 1) % 16
            if ch_next == 9:
                ch_next = 10
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        tr.append(mido.MetaMessage("instrument_name", name=inst.describe()[:60], time=0))
        if not drum:
            bank, program = _program_of(inst)
            if bank:
                tr.append(mido.Message("control_change", channel=ch, control=0, value=min(127, bank), time=0))
            tr.append(mido.Message("program_change", channel=ch, program=min(127, max(0, program)), time=0))
        # a single drum sound played with notes ("C4:8bar" on a crash): its GM note, not the pitch
        from .instruments import VoiceInstrument

        single = inst.entry.name if drum and isinstance(inst, VoiceInstrument) else None
        msgs = []
        for t, d, ev in evs:
            if single:
                note = _drum_note(single, assigned)
            else:
                note = ev.pitch if ev.pitch is not None else _drum_note(ev.key, assigned)
            if not drum and ev.pitch is None:
                note = 60
            note = max(0, min(127, int(note)))
            vel = max(1, min(127, int(round(ev.vel * 127))))
            on, off = to_tick(t), to_tick(t + max(d, 0.01))
            msgs.append((on, 1, mido.Message("note_on", channel=ch, note=note, velocity=vel)))
            msgs.append((max(off, on + 1), 0, mido.Message("note_off", channel=ch, note=note, velocity=0)))
        msgs.sort(key=lambda m: (m[0], m[1]))
        now = 0
        for tick, _, msg in msgs:
            msg.time = tick - now
            now = tick
            tr.append(msg)
        mid.tracks.append(tr)
    path.parent.mkdir(parents=True, exist_ok=True)
    mid.save(str(path))


def preview_png(path: Path, x: np.ndarray, sr: int, title: str, sections: list[tuple[str, float]] | None = None) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    mono = np.mean(dsp.to_stereo(x), axis=1)
    t = np.arange(len(mono)) / sr
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 6), dpi=100, sharex=True, gridspec_kw={"height_ratios": [1, 2]})
    fig.patch.set_facecolor("#0d1016")
    for ax in (ax1, ax2):
        ax.set_facecolor("#0d1016")
        ax.tick_params(colors="#a2abbd", labelsize=8)
        for s in ax.spines.values():
            s.set_color("#2f3848")
    step = max(1, len(mono) // 6000)
    ax1.fill_between(t[::step], np.minimum.reduceat(mono, np.arange(0, len(mono), step)) if len(mono) else [],
                     np.maximum.reduceat(mono, np.arange(0, len(mono), step)) if len(mono) else [], color="#a78bfa", linewidth=0)
    ax1.set_ylim(-1, 1)
    ax1.set_title(title, color="#e7e9ee", fontsize=11, loc="left")
    if len(mono) > 2048:
        ax2.specgram(mono + 1e-9, NFFT=2048, Fs=sr, noverlap=1024, cmap="magma", vmin=-120, vmax=-20)
    ax2.set_ylim(20, min(16000, sr / 2))
    ax2.set_yscale("symlog", linthresh=200)
    ax2.set_ylabel("Hz", color="#a2abbd", fontsize=8)
    ax2.set_xlabel("seconds", color="#a2abbd", fontsize=8)
    for name, start in sections or []:
        for ax in (ax1, ax2):
            ax.axvline(start, color="#22d3ee", linewidth=0.8, alpha=0.7)
        ax1.text(start, 0.85, f" {name}", color="#22d3ee", fontsize=8)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(path), facecolor=fig.get_facecolor())
    plt.close(fig)


def analyze_audio(x: np.ndarray, sr: int) -> dict:
    x = dsp.to_stereo(x)
    mono = np.mean(x, axis=1)
    spec = np.abs(np.fft.rfft(mono[: min(len(mono), sr * 60)] * np.hanning(min(len(mono), sr * 60))))
    freqs = np.fft.rfftfreq(min(len(mono), sr * 60), 1 / sr)
    bands = {"sub (<60 Hz)": (0, 60), "bass (60-250)": (60, 250), "low-mid (250-1k)": (250, 1000), "mid (1k-4k)": (1000, 4000), "high (4k-12k)": (4000, 12000), "air (>12k)": (12000, sr / 2)}
    energy = {k: float(np.sum(spec[(freqs >= lo) & (freqs < hi)] ** 2)) for k, (lo, hi) in bands.items()}
    total = sum(energy.values()) or 1.0
    side = (x[:, 0] - x[:, 1]) / 2
    return {
        "duration": round(len(x) / sr, 3),
        "lufs": round(dsp.lufs(x, sr), 1),
        "peak_dbfs": round(dsp.peak_db(x), 1),
        "rms_dbfs": round(dsp.rms_db(mono), 1),
        "clipped_samples": int(np.sum(np.abs(x) >= 0.999)),
        "stereo_width": round(float(np.sqrt(np.mean(side**2)) / (np.sqrt(np.mean(mono**2)) + 1e-9)), 3),
        "spectrum_balance": {k: round(100 * v / total, 1) for k, v in energy.items()},
        "brightest_freq_hz": round(float(freqs[np.argmax(spec)]), 1) if len(spec) else 0,
    }
