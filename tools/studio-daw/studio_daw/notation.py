"""Text music notation for studio-daw.

Durations are measured in quarter notes ("beats" in 4/4).
See README.md for the full reference.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


class NotationError(Exception):
    pass


@dataclass
class Event:
    start: float          # quarter notes from pattern start
    dur: float            # quarter notes (sounding length, gate applied)
    pitch: int | None     # MIDI note (None for drum/sample keys)
    vel: float            # 0..1
    key: str | None = None  # drum name / kit sound
    # editor info: "len" written length (beats, before gate), "st" staccato, "ch" chord symbol it came from
    extra: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Notes, durations, chords
# ---------------------------------------------------------------------------
NOTE_RE = re.compile(r"^([A-Ga-g])([#b]{0,2})(-?\d)?$")
SEMI = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_to_midi(name: str, default_octave: int = 4) -> int:
    m = NOTE_RE.match(name)
    if not m:
        raise NotationError(f'"{name}" is not a note (examples: C4, F#3, Bb2, e5)')
    letter, acc, octave = m.groups()
    semi = SEMI[letter.lower()] + acc.count("#") - acc.count("b")
    o = int(octave) if octave is not None else default_octave
    return 12 * (o + 1) + semi


def midi_to_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def midi_to_freq(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


DUR_LETTERS = {"w": 4.0, "h": 2.0, "q": 1.0, "e": 0.5, "s": 0.25, "t": 0.125}
DUR_RE = re.compile(r"^([whqest])(\.{0,2})(3)?$")


def parse_duration(tok: str, bar_len: float = 4.0) -> float:
    tok = tok.strip()
    m = DUR_RE.match(tok)
    if m:
        base = DUR_LETTERS[m.group(1)]
        val = base
        add = base
        for _ in m.group(2):
            add /= 2
            val += add
        if m.group(3):
            val *= 2 / 3
        return val
    if tok.endswith("bar") or tok.endswith("bars"):
        num = tok.rstrip("bars") or "1"
        return float(num) * bar_len
    if "/" in tok:
        a, b = tok.split("/", 1)
        return float(a) / float(b)
    try:
        v = float(tok)
    except ValueError:
        raise NotationError(f'"{tok}" is not a duration (w h q e s t, dotted "q.", triplet "e3", beats "1.5", "1/3", "2bar")') from None
    if v <= 0:
        raise NotationError(f"duration must be positive: {tok}")
    return v


CHORD_QUALITIES: dict[str, list[int]] = {
    "": [0, 4, 7], "maj": [0, 4, 7], "M": [0, 4, 7], "m": [0, 3, 7], "min": [0, 3, 7], "-": [0, 3, 7],
    "dim": [0, 3, 6], "aug": [0, 4, 8], "+": [0, 4, 8], "sus2": [0, 2, 7], "sus4": [0, 5, 7], "sus": [0, 5, 7],
    "5": [0, 7], "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9], "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11], "M7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10], "min7": [0, 3, 7, 10], "-7": [0, 3, 7, 10], "mmaj7": [0, 3, 7, 11], "dim7": [0, 3, 6, 9],
    "m7b5": [0, 3, 6, 10], "7sus4": [0, 5, 7, 10], "9": [0, 4, 7, 10, 14], "maj9": [0, 4, 7, 11, 14], "m9": [0, 3, 7, 10, 14],
    "add9": [0, 4, 7, 14], "madd9": [0, 3, 7, 14], "11": [0, 4, 7, 10, 14, 17], "m11": [0, 3, 7, 10, 14, 17],
    "13": [0, 4, 7, 10, 14, 21], "7b9": [0, 4, 7, 10, 13], "7#9": [0, 4, 7, 10, 15], "6/9": [0, 4, 7, 9, 14],
}
CHORD_RE = re.compile(r"^([A-G])([#b]?)([^/@]*)(?:/([A-G][#b]?))?(?:@(-?\d))?$")


def chord_notes(symbol: str, octave: int = 3, voicing: str = "close") -> list[int]:
    m = CHORD_RE.match(symbol)
    if not m or m.group(3) not in CHORD_QUALITIES:
        raise NotationError(f'"{symbol}" is not a chord symbol (examples: C, Am, F#m7, Bbmaj7, G7sus4, Dm/F, Am7@4)')
    root, acc, quality, bass, oct_ = m.groups()
    o = int(oct_) if oct_ is not None else octave
    base = note_to_midi(root + acc + str(o))
    notes = [base + i for i in CHORD_QUALITIES[quality]]
    if voicing in ("open", "spread") and len(notes) >= 3:
        notes = [n + (12 if i % 2 == 1 else 0) for i, n in enumerate(notes)]
    elif voicing == "drop2" and len(notes) >= 4:
        notes[-2] -= 12
        notes.sort()
    if bass:
        b = note_to_midi(bass + str(o - 1))
        while b >= notes[0]:
            b -= 12
        notes.insert(0, b)
    return notes


DYNAMICS = {"ppp": 0.2, "pp": 0.3, "p": 0.45, "mp": 0.6, "mf": 0.72, "f": 0.85, "ff": 0.95, "fff": 1.0}

# ---------------------------------------------------------------------------
# Sequences: "C4:q E4 G4:e | [Am7]:2 r:q (C5 D5)*2 _ ..."
# ---------------------------------------------------------------------------
GROUP_RE = re.compile(r"\(([^()]*)\)\s*\*\s*(\d+)")
TOKEN_RE = re.compile(
    r"^(?P<el>[^:!*^']+?)(?::(?P<dur>[^!*^']+))?(?P<acc>\^)?(?P<stac>')?(?:!(?P<vel>[0-9.]+))?(?:\*(?P<rep>\d+))?$"
)


@dataclass
class SequenceResult:
    events: list[Event]
    length: float            # quarter notes
    warnings: list[str]


def _expand_groups(text: str) -> str:
    prev = None
    while prev != text:
        prev = text
        text = GROUP_RE.sub(lambda m: " ".join([m.group(1)] * int(m.group(2))), text)
    if "(" in text or ")" in text:
        raise NotationError('unbalanced "( … )*n" group')
    return text


def parse_sequence(text: str, *, bar_len: float = 4.0, octave: int = 4, chord_octave: int = 3,
                   voicing: str = "close", gate: float = 0.92, velocity: float = 0.72) -> SequenceResult:
    """Parse a melodic/harmonic sequence into events."""
    text = _expand_groups(str(text).replace("|", " | ").replace("\n", " "))
    events: list[Event] = []
    warnings: list[str] = []
    pos = 0.0
    dur = 1.0
    vel = velocity
    oct_ = octave
    last: list[Event] = []
    bar_no = 1
    bar_start = 0.0
    for raw in text.split():
        if raw == "|":
            used = pos - bar_start
            if abs(used - bar_len) > 1e-6:
                warnings.append(f"bar {bar_no} has {used:g} beats (expected {bar_len:g})")
            bar_no += 1
            bar_start = pos
            continue
        if raw in DYNAMICS:
            vel = DYNAMICS[raw]
            continue
        if re.fullmatch(r"o-?\d", raw):
            oct_ = int(raw[1:])
            continue
        if raw in (">", "<"):
            oct_ += 1 if raw == ">" else -1
            continue
        m = TOKEN_RE.match(raw)
        if not m:
            raise NotationError(f'cannot read "{raw}" (bar {bar_no})')
        el = m.group("el")
        if m.group("dur"):
            try:
                dur = parse_duration(m.group("dur"), bar_len)
            except NotationError as e:
                raise NotationError(f"{e} (bar {bar_no})") from None
        v = vel
        if m.group("vel"):
            x = float(m.group("vel"))
            v = x / 127 if x > 1 else x
        if m.group("acc"):
            v = min(1.0, v + 0.15)
        g = 0.5 if m.group("stac") else gate
        reps = int(m.group("rep") or 1)
        for _ in range(reps):
            if el in ("r", "-", "~"):
                last = []
            elif el == "_":
                for ev in last:
                    ev.dur += dur
                    ev.extra["len"] = ev.extra.get("len", 0.0) + dur
                if not last:
                    warnings.append(f'tie "_" without a note before it (bar {bar_no})')
            else:
                chord = None
                try:
                    if el.startswith("[") and el.endswith("]"):
                        chord = el[1:-1]
                        pitches = chord_notes(chord, chord_octave, voicing)
                    elif "+" in el:
                        pitches = [note_to_midi(p, oct_) for p in el.split("+")]
                    else:
                        pitches = [note_to_midi(el, oct_)]
                except NotationError as e:
                    raise NotationError(f"{e} (bar {bar_no})") from None
                info = {"len": dur}
                if m.group("stac"):
                    info["st"] = 1
                if chord:
                    info["ch"] = chord
                last = [Event(pos, dur * g, p, v, extra=dict(info)) for p in pitches]
                events.extend(last)
            pos += dur
    if abs(pos - bar_start) > 1e-6 and abs(pos - bar_start - bar_len) > 1e-6 and "|" in text:
        warnings.append(f"last bar ({bar_no}) has {pos - bar_start:g} beats (expected {bar_len:g})")
    return SequenceResult(events, pos, warnings)


def parse_chords(text: str, *, bar_len: float = 4.0, octave: int = 3, voicing: str = "close",
                 gate: float = 0.98, velocity: float = 0.65, default_dur: float | None = None) -> SequenceResult:
    """Chord track: "Am7:2 F:2 | C G" — symbols with durations (default: one bar)."""
    text = _expand_groups(str(text).replace("|", " | ").replace("\n", " "))
    events: list[Event] = []
    warnings: list[str] = []
    pos = 0.0
    dur = default_dur or bar_len
    vel = velocity
    bar_no, bar_start = 1, 0.0
    for raw in text.split():
        if raw == "|":
            used = pos - bar_start
            if abs(used - bar_len) > 1e-6:
                warnings.append(f"bar {bar_no} has {used:g} beats (expected {bar_len:g})")
            bar_no += 1
            bar_start = pos
            continue
        if raw in DYNAMICS:
            vel = DYNAMICS[raw]
            continue
        m = TOKEN_RE.match(raw)
        if not m:
            raise NotationError(f'cannot read "{raw}" (bar {bar_no})')
        if m.group("dur"):
            dur = parse_duration(m.group("dur"), bar_len)
        sym = m.group("el").strip("[]")
        reps = int(m.group("rep") or 1)
        v = vel if not m.group("vel") else (float(m.group("vel")) / 127 if float(m.group("vel")) > 1 else float(m.group("vel")))
        for _ in range(reps):
            if sym not in ("r", "-", "~"):
                try:
                    for p in chord_notes(sym, octave, voicing):
                        events.append(Event(pos, dur * gate, p, v, extra={"len": dur, "ch": sym}))
                except NotationError as e:
                    raise NotationError(f"{e} (bar {bar_no})") from None
            pos += dur
    return SequenceResult(events, pos, warnings)


# ---------------------------------------------------------------------------
# Step grids:   kick: x---x---x---x---
# ---------------------------------------------------------------------------
GRID_LINE = re.compile(r"^\s*([A-Za-z0-9#_.+-]+)\s*:\s*([xXoO.\-_|0-9 ]+?)\s*$")
GRID_VEL = {"x": 0.8, "X": 1.0, "o": 0.45, "O": 0.6}


def looks_like_grid(text: str) -> bool:
    lines = [ln for ln in str(text).splitlines() if ln.strip() and not ln.strip().startswith("#")]
    return bool(lines) and all(GRID_LINE.match(ln) for ln in lines)


def parse_grid(text: str, *, step: float = 0.25, gate: float = 0.9) -> SequenceResult:
    """Each row: name: x---X---o--- (x hit, X accent, o ghost, 1-9 velocity, - or . rest).
    Shorter rows repeat until the longest row ends."""
    rows: list[tuple[str, list[tuple[int, float]], int]] = []
    for ln in str(text).splitlines():
        if not ln.strip() or ln.strip().startswith("#"):
            continue
        m = GRID_LINE.match(ln)
        if not m:
            raise NotationError(f'grid line "{ln.strip()}" — expected "name: x---x---"')
        name, cells = m.group(1), m.group(2).replace("|", "").replace(" ", "")
        hits = []
        for i, c in enumerate(cells):
            if c in GRID_VEL:
                hits.append((i, GRID_VEL[c]))
            elif c.isdigit() and c != "0":
                hits.append((i, int(c) / 9))
        rows.append((name, hits, len(cells)))
    if not rows:
        raise NotationError("empty grid")
    steps = max(n for _, _, n in rows)
    events = []
    for name, hits, n in rows:
        if n == 0:
            continue
        for rep in range(0, steps, n):
            for i, v in hits:
                if rep + i < steps:
                    events.append(Event((rep + i) * step, step * gate, None, v, key=name, extra={"len": step}))
    return SequenceResult(events, steps * step, [])
