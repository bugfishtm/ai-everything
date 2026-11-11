"""Song files (*.song.yaml): load, validate and turn into timed events."""
from __future__ import annotations

import difflib
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import yaml

from . import registry
from .instruments import Instrument, InstrumentError, make_instrument
from .notation import Event, NotationError, SequenceResult, looks_like_grid, parse_chords, parse_duration, parse_grid, parse_sequence


class SongError(Exception):
    pass


@dataclass
class Pattern:
    name: str
    tracks: dict[str, SequenceResult]
    length: float  # quarter notes


@dataclass
class Section:
    name: str
    start_q: float
    start_sec: float
    bars: float
    bpm: float
    play: list[tuple[str, dict]]
    transpose: int = 0

    def length_q(self, bar_len: float) -> float:
        return self.bars * bar_len


@dataclass
class Song:
    path: Path
    base_dir: Path
    title: str
    bpm: float
    meter: tuple[int, int]
    bar_len: float
    sr: int
    swing: float
    swing_unit: int
    humanize: float
    seed: int
    tail: float
    instruments: dict[str, Instrument]
    inst_specs: dict[str, dict]
    patterns: dict[str, Pattern]
    sections: list[Section]
    mix: dict[str, dict]
    master: dict
    warnings: list[str] = field(default_factory=list)
    raw: dict = field(default_factory=dict)  # the parsed YAML (the editor model keeps the written forms)
    implicit_arrangement: bool = False

    # -------------------------------------------------------------------------
    @property
    def duration(self) -> float:
        if not self.sections:
            return 0.0
        last = self.sections[-1]
        return last.start_sec + last.bars * self.bar_len * 60 / last.bpm

    @property
    def total_bars(self) -> float:
        return sum(s.bars for s in self.sections)

    def events(self, from_bar: float | None = None, to_bar: float | None = None, humanize: bool = True) -> dict[str, list[tuple[float, float, Event]]]:
        """Timed events per instrument; humanize=False gives the notes as written (MIDI export)."""
        rng = np.random.default_rng(self.seed)
        out: dict[str, list[tuple[float, float, Event]]] = {}
        lo = (from_bar - 1) * self.bar_len if from_bar else None
        hi = (to_bar) * self.bar_len if to_bar else None
        for sec in self.sections:
            beat = 60.0 / sec.bpm
            sec_len = sec.length_q(self.bar_len)
            for pname, opts in sec.play:
                pat = self.patterns[pname]
                start_bar = float(opts.get("offset", 0)) * self.bar_len
                transpose = int(opts.get("transpose", 0)) + sec.transpose
                vel_scale = float(opts.get("velocity", 1.0))
                only = opts.get("only")
                rep = 0.0
                plen = pat.length if not opts.get("bars") else float(opts["bars"]) * self.bar_len
                while start_bar + rep < sec_len - 1e-9:
                    for inst, seq in pat.tracks.items():
                        if only and inst not in only:
                            continue
                        for ev in seq.events:
                            if ev.start >= plen - 1e-9:
                                continue
                            tq = start_bar + rep + ev.start
                            if tq >= sec_len - 1e-9:
                                continue
                            gq = sec.start_q + tq
                            if lo is not None and gq < lo - 1e-9:
                                continue
                            if hi is not None and gq >= hi - 1e-9:
                                continue
                            dq = min(ev.dur, sec_len - tq)
                            # swing: delay every second 16th (or 8th)
                            unit = 0.25 if self.swing_unit == 16 else 0.5
                            frac = (tq % (2 * unit))
                            if self.swing and abs(frac - unit) < 1e-6:
                                tq += self.swing * unit
                            t = sec.start_sec + tq * beat
                            vel = ev.vel * vel_scale
                            if self.humanize and humanize:
                                t += rng.normal(0, self.humanize * 0.008)
                                vel *= 1 + rng.normal(0, self.humanize * 0.07)
                            pitch = ev.pitch + transpose if ev.pitch is not None else None
                            e2 = Event(ev.start, ev.dur, pitch, float(min(1.0, max(0.02, vel))), ev.key, ev.extra)
                            out.setdefault(inst, []).append((max(0.0, t), dq * beat, e2))
                    rep += plen
                    if plen <= 0:
                        break
        if lo is not None:
            # shift so the excerpt starts at 0 (aligned to the bar)
            first_sec = self._q_to_sec(lo)
            out = {k: [(max(0.0, t - first_sec), d, e) for t, d, e in v] for k, v in out.items()}
        for v in out.values():
            v.sort(key=lambda x: x[0])
        return out

    def _q_to_sec(self, q: float) -> float:
        for sec in self.sections:
            if q < sec.start_q + sec.length_q(self.bar_len) + 1e-9:
                return sec.start_sec + (q - sec.start_q) * 60 / sec.bpm
        return self.duration


# ---------------------------------------------------------------------------
def _suggest(word: str, options) -> str:
    close = difflib.get_close_matches(word, list(options), n=3)
    return f" — did you mean {', '.join(close)}?" if close else ""


def _meter(value) -> tuple[int, int]:
    try:
        a, b = str(value or "4/4").split("/")
        return int(a), int(b)
    except ValueError:
        raise SongError(f'song.time must look like "4/4" or "6/8", got "{value}"') from None


def _parse_track(pname: str, inst: str, spec, bar_len: float, ispec: dict) -> SequenceResult:
    octave = int(ispec.get("octave", 4))
    gate = float(ispec.get("gate", 0.92))
    where = f"patterns.{pname}.{inst}"
    try:
        if isinstance(spec, list):
            merged = SequenceResult([], 0.0, [])
            for voice in spec:
                r = _parse_track(pname, inst, voice, bar_len, ispec)
                merged.events += r.events
                merged.length = max(merged.length, r.length)
                merged.warnings += r.warnings
            return merged
        if isinstance(spec, dict):
            opts = dict(spec)
            step = parse_duration(str(opts.get("step", "s")), bar_len)
            if "grid" in opts:
                r = parse_grid(opts["grid"], step=step, gate=float(opts.get("gate", 0.9)))
            elif "chords" in opts:
                r = parse_chords(opts["chords"], bar_len=bar_len, octave=int(opts.get("octave", 3)), voicing=str(opts.get("voicing", "close")),
                                 gate=float(opts.get("gate", 0.98)), velocity=float(opts.get("velocity", 0.62)))
            elif "notes" in opts:
                r = parse_sequence(opts["notes"], bar_len=bar_len, octave=int(opts.get("octave", octave)), gate=float(opts.get("gate", gate)),
                                   velocity=float(opts.get("velocity", 0.72)), voicing=str(opts.get("voicing", "close")))
            elif "events" in opts:
                evs = []
                end = 0.0
                for i, e in enumerate(opts["events"]):
                    if not isinstance(e, dict) or "t" not in e:
                        raise NotationError(f"events[{i}] needs t (start in beats), n (note) or k (drum), d (beats), v (0..1)")
                    d = float(e.get("d", 1))
                    pitch = None
                    if "n" in e:
                        from .notation import note_to_midi

                        pitch = e["n"] if isinstance(e["n"], int) else note_to_midi(str(e["n"]), octave)
                    evs.append(Event(float(e["t"]), d * gate, pitch, float(e.get("v", 0.75)), e.get("k"), {"len": d}))
                    end = max(end, float(e["t"]) + d)
                r = SequenceResult(evs, end, [])
            else:
                raise NotationError("use one of: notes, chords, grid, events")
            if "transpose" in opts:
                for e in r.events:
                    if e.pitch is not None:
                        e.pitch += int(opts["transpose"])
            return r
        text = str(spec)
        if looks_like_grid(text):
            return parse_grid(text, step=0.25)
        return parse_sequence(text, bar_len=bar_len, octave=octave, gate=gate)
    except NotationError as e:
        raise SongError(f"{where}: {e}") from None


def load_song(path: str | Path) -> Song:
    path = Path(path)
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        raise SongError(f"file not found: {path}") from None
    return load_song_text(text, path)


def parse_yaml(text: str, name: str = "song") -> dict:
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise SongError(f"{name}: YAML syntax error: {e}") from None
    if not isinstance(data, dict):
        raise SongError("a song file must be a mapping with song/instruments/patterns/arrangement")
    return data


def load_song_text(text: str, path: str | Path = "song.song.yaml") -> Song:
    """Load a song from YAML text (the website DAW sends unsaved edits this way)."""
    path = Path(path)
    data = parse_yaml(text, path.name)
    if not isinstance(data, dict):
        raise SongError("a song file must be a mapping with song/instruments/patterns/arrangement")
    unknown = set(data) - {"song", "instruments", "patterns", "arrangement", "mix", "master"}
    warnings: list[str] = []
    if unknown:
        warnings.append(f"ignored top-level keys: {', '.join(sorted(unknown))}")

    registry.load_builtins()
    registry.load_project_plugins()
    for err in registry.PLUGIN_ERRORS:
        warnings.append(f'plugin {err["file"]} failed to load: {err["error"]}')

    s = data.get("song") or {}
    bpm = float(s.get("bpm", 120))
    if not 20 <= bpm <= 400:
        raise SongError("song.bpm must be between 20 and 400")
    meter = _meter(s.get("time"))
    bar_len = meter[0] * 4 / meter[1]
    base_dir = path.parent.resolve()
    # project-relative file paths: walk up to the project root
    project = registry.project_dir()

    inst_specs = data.get("instruments") or {}
    if not isinstance(inst_specs, dict) or not inst_specs:
        raise SongError("instruments: define at least one, e.g.  instruments: { lead: { use: lead } }")
    instruments: dict[str, Instrument] = {}
    norm_specs: dict[str, dict] = {}
    for name, spec in inst_specs.items():
        spec_d = {"use": spec} if isinstance(spec, str) else dict(spec or {})
        norm_specs[name] = spec_d
        try:
            instruments[name] = make_instrument(name, spec_d, project, warnings)
        except (InstrumentError, ImportError) as e:
            hint = registry.plugin_error_hint() if "unknown" in str(e) else ""
            raise SongError(f"instruments.{name}: {e}{hint}") from None
        except Exception as e:  # noqa: BLE001
            raise SongError(f"instruments.{name}: {type(e).__name__}: {e}") from None

    patterns: dict[str, Pattern] = {}
    for pname, pdef in (data.get("patterns") or {}).items():
        if not isinstance(pdef, dict):
            raise SongError(f"patterns.{pname} must map instrument names to music")
        tracks = {}
        bars_override = pdef.get("bars")
        for inst, spec in pdef.items():
            if inst == "bars":
                continue
            if inst not in instruments:
                raise SongError(f'patterns.{pname}: unknown instrument "{inst}"{_suggest(inst, instruments)}')
            r = _parse_track(pname, inst, spec, bar_len, norm_specs[inst])
            warnings.extend(f"patterns.{pname}.{inst}: {w}" for w in r.warnings)
            tracks[inst] = r
        if not tracks:
            raise SongError(f"patterns.{pname} is empty")
        raw_len = max(t.length for t in tracks.values())
        length = float(bars_override) * bar_len if bars_override else max(bar_len, math.ceil(raw_len / bar_len - 1e-9) * bar_len)
        patterns[pname] = Pattern(pname, tracks, length)
    if not patterns:
        raise SongError("patterns: define at least one pattern")

    sections: list[Section] = []
    arrangement = data.get("arrangement")
    implicit = not arrangement
    q = 0.0
    t = 0.0
    if not arrangement:
        bars = max(p.length for p in patterns.values()) / bar_len * int(s.get("loop", 1))
        arrangement = [{"section": "main", "bars": bars, "play": list(patterns)}]
    if not isinstance(arrangement, list):
        raise SongError("arrangement must be a list of sections")
    for i, sec in enumerate(arrangement):
        if not isinstance(sec, dict):
            raise SongError(f"arrangement[{i}] must be a mapping like {{section: verse, bars: 8, play: [beat, bass]}}")
        play_raw = sec.get("play", [])
        if isinstance(play_raw, str):
            play_raw = [play_raw]
        play: list[tuple[str, dict]] = []
        for entry in play_raw:
            opts = {}
            if isinstance(entry, dict):
                opts = dict(entry)
                entry = opts.pop("pattern", None)
            if entry not in patterns:
                raise SongError(f'arrangement[{i}] ({sec.get("section", "?")}): unknown pattern "{entry}"{_suggest(str(entry), patterns)}')
            play.append((entry, opts))
        sec_bpm = float(sec.get("bpm", bpm))
        bars = float(sec.get("bars") or (max((patterns[p].length for p, _ in play), default=bar_len) / bar_len))
        name = str(sec.get("section") or sec.get("name") or f"section {i + 1}")
        sections.append(Section(name, q, t, bars, sec_bpm, play, int(sec.get("transpose", 0))))
        q += bars * bar_len
        t += bars * bar_len * 60 / sec_bpm

    mix_keys = ("gain", "volume", "pan", "mute", "solo", "effects", "reverb", "delay")
    mix = {
        name: {**getattr(instruments[name], "preset_mix", {}), **{k: v for k, v in spec.items() if k in mix_keys}}
        for name, spec in norm_specs.items()
    }
    for name, m in (data.get("mix") or {}).items():
        if name not in instruments:
            raise SongError(f'mix: unknown instrument "{name}"{_suggest(name, instruments)}')
        mix.setdefault(name, {}).update(m or {})
    for name, m in mix.items():
        for eff in m.get("effects") or []:
            ename = eff if isinstance(eff, str) else (eff or {}).get("use")
            if ename not in registry.EFFECTS:
                raise SongError(f'mix.{name}: unknown effect "{ename}"{_suggest(str(ename), registry.EFFECTS)} (studio-daw effects){registry.plugin_error_hint()}')
    master = data.get("master") or {}
    if not isinstance(master, dict):
        raise SongError("master must be a mapping like { target: -14, ceiling: -1 }")
    for eff in master.get("effects") or []:
        ename = eff if isinstance(eff, str) else (eff or {}).get("use")
        if ename not in registry.EFFECTS:
            raise SongError(f'master: unknown effect "{ename}"{_suggest(str(ename), registry.EFFECTS)} (studio-daw effects){registry.plugin_error_hint()}')

    return Song(
        path=path, base_dir=base_dir, title=str(s.get("title") or path.stem.replace(".song", "")), bpm=bpm, meter=meter,
        bar_len=bar_len, sr=int(s.get("sample_rate", 44100)), swing=float(s.get("swing", 0)), swing_unit=int(s.get("swing_unit", 16)),
        humanize=float(s.get("humanize", 0)), seed=int(s.get("seed", 1)), tail=float(s.get("tail", 2.5)), instruments=instruments,
        inst_specs=norm_specs, patterns=patterns, sections=sections, mix=mix, master=dict(data.get("master") or {}),
        warnings=warnings + registry.WARNINGS, raw=data, implicit_arrangement=implicit,
    )
