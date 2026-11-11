"""MIDI file -> song text (`studio-daw import song.mid`).

Tracks become instruments (General MIDI SoundFont presets when the gm-instruments pack is
there, built-in synths otherwise). The piece is cut into sections of a few bars; parts that
repeat share one pattern, and neighbouring sections that play the same patterns are merged.
Notes are written as exact events (t = start in beats, d = length in beats), drums on a
16th grid as step grids.
"""
from __future__ import annotations

import re
from pathlib import Path

from .instruments import GM_DRUMS

# what plays a General MIDI program when no SoundFont is used (one synth per family of 8)
SYNTH_BY_FAMILY = ["epiano", "bell", "organ", "pluck", "bass", "strings", "strings", "lead", "lead", "lead", "lead", "pad", "pad", "pluck", "bell", "sine"]
# built-in drum kit: GM note -> sound of the synth kit
SYNTH_DRUMS = {35: "kick", 36: "kick", 37: "rim", 38: "snare", 39: "clap", 40: "snare", 41: "tom3", 42: "hat", 43: "tom3", 44: "hat", 45: "tom2",
               46: "ohat", 47: "tom2", 48: "tom1", 49: "crash", 50: "tom1", 51: "ride", 52: "crash", 53: "ride", 54: "shaker", 55: "crash", 56: "cowbell",
               57: "crash", 59: "ride", 69: "shaker", 70: "shaker", 82: "shaker"}
SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


class MidiImportError(Exception):
    pass


def _slug(s: str, fallback: str) -> str:
    x = re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")[:20]
    if not x:
        return fallback
    return x if re.match(r"[a-z_]", x) else f"t_{x}"


def _num(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def _gm_pack():
    """(program -> pack ref, drum kit ref, kit sound names by note) from the gm-instruments pack, if installed."""
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
    try:
        from studio_packs import find_pack  # noqa: E402

        pack = find_pack("gm-instruments")
    except Exception:  # noqa: BLE001
        pack = None
    if pack is None:
        return {}, None
    programs, kit = {}, None
    for item in pack.items.values():
        meta = item.get("meta") or {}
        if item.get("kind") == "instrument" and "program" in meta and int(meta.get("bank", 0)) != 128:
            programs.setdefault(int(meta["program"]), f"gm-instruments/{item['id']}")
        elif item.get("kind") == "drumkit" and (kit is None or int(meta.get("program", 0)) == 0):
            kit = f"gm-instruments/{item['id']}"
    return programs, kit


def read_midi(path: Path) -> dict:
    try:
        import mido
    except ImportError:
        raise MidiImportError("the Python package mido is missing (pip install mido)") from None
    try:
        mf = mido.MidiFile(str(path))
    except Exception as e:  # noqa: BLE001
        raise MidiImportError(f"cannot read {path.name}: {e}") from None
    if mf.ticks_per_beat <= 0:
        raise MidiImportError("SMPTE timed MIDI files are not supported")
    tpq = mf.ticks_per_beat
    tempo, tempos, meter, title = 500000, 0, (4, 4), None
    tracks = []
    for ti, tr in enumerate(mf.tracks):
        tick = 0
        name = ""
        open_notes: dict[tuple[int, int], list[tuple[int, int]]] = {}
        by_ch: dict[int, dict] = {}
        for msg in tr:
            tick += msg.time
            if msg.type == "track_name":
                name = msg.name.strip()
                if ti == 0 and title is None:
                    title = name
            elif msg.type == "set_tempo":
                if tempos == 0:
                    tempo = msg.tempo
                tempos += 1 if (tempos == 0 or msg.tempo != tempo) else 0
            elif msg.type == "time_signature" and tick == 0:
                meter = (msg.numerator, msg.denominator)
            elif msg.type == "program_change":
                by_ch.setdefault(msg.channel, {"notes": [], "program": None})
                if by_ch[msg.channel]["program"] is None:
                    by_ch[msg.channel]["program"] = msg.program
            elif msg.type == "note_on" and msg.velocity > 0:
                open_notes.setdefault((msg.channel, msg.note), []).append((tick, msg.velocity))
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                stack = open_notes.get((msg.channel, msg.note))
                if stack:
                    start, vel = stack.pop(0)
                    by_ch.setdefault(msg.channel, {"notes": [], "program": None})["notes"].append((start / tpq, max(1, tick - start) / tpq, msg.note, vel / 127))
        for (ch, note), stack in open_notes.items():      # notes that never got a note-off
            for start, vel in stack:
                by_ch.setdefault(ch, {"notes": [], "program": None})["notes"].append((start / tpq, 1.0, note, vel / 127))
        for ch, d in sorted(by_ch.items()):
            if d["notes"]:
                tracks.append({"name": name, "channel": ch, "program": d["program"], "notes": sorted(d["notes"])})
    if not tracks:
        raise MidiImportError("the MIDI file has no notes")
    return {"bpm": round(60_000_000 / tempo, 2), "tempo_changes": max(0, tempos - 1), "meter": meter, "title": title, "tracks": tracks}


def midi_to_song(path: Path, quantize: int = 16, bars: int = 4, gm: bool = True, max_bars: int | None = None) -> tuple[str, dict]:
    """Returns (song YAML, facts for the report)."""
    data = read_midi(path)
    num, den = data["meter"]
    bar_len = num * 4 / den
    q = 4 / quantize if quantize else 1 / 48

    def snap(v: float) -> float:
        return round(v / q) * q

    programs, kit = _gm_pack() if gm else ({}, None)
    note_names = {v: k for k, v in reversed(list(GM_DRUMS.items()))}       # the first name listed wins
    used: set[str] = set()
    insts = []
    for i, tr in enumerate(data["tracks"]):
        drum = tr["channel"] == 9
        name = _slug(tr["name"], "drums" if drum else f"track{i + 1}")
        while name in used:
            name = f"{name}_{i + 1}"
        used.add(name)
        prog = tr["program"] or 0
        if drum:
            use = kit or "drums"
        else:
            use = programs.get(prog) or SYNTH_BY_FAMILY[prog // 8]
        notes = [(snap(t), max(q, snap(d)), n, round(v, 2)) for t, d, n, v in tr["notes"]]
        insts.append({"name": name, "use": use, "drum": drum, "synth_kit": drum and not kit, "notes": notes})

    # key (best matching major scale) decides between sharps and flats
    hist = [0.0] * 12
    for ins in insts:
        if not ins["drum"]:
            for _, d, n, _ in ins["notes"]:
                hist[n % 12] += d
    key = max(range(12), key=lambda k: sum(hist[(k + i) % 12] for i in (0, 2, 4, 5, 7, 9, 11)))
    names = FLATS if key in (5, 10, 3, 8, 1, 6) else SHARPS

    def pitch(n: int) -> str:
        return f"{names[n % 12]}{n // 12 - 1}"

    end = max(t + d for ins in insts for t, d, _, _ in ins["notes"])
    total_bars = max(1, int(-(-end // bar_len)))
    cut = bool(max_bars and total_bars > max_bars)
    if cut:
        total_bars = int(max_bars)
    chunk = bars if bars > 0 else total_bars
    patterns: list[tuple[str, str, list[str], int | None]] = []      # (pattern name, instrument, lines, bars)
    by_sig: dict[str, str] = {}
    counters: dict[str, int] = {}
    sections: list[dict] = []
    for c in range(-(-total_bars // chunk)):
        a = c * chunk * bar_len
        nbars = min(chunk, total_bars - c * chunk)
        b = a + nbars * bar_len
        play = []
        for ins in insts:
            evs = [(t - a, min(d, b - t), n, v) for t, d, n, v in ins["notes"] if a - 1e-9 <= t < b - 1e-9]
            if not evs:
                continue
            lines = _drum_lines(evs, ins, nbars * bar_len, note_names) if ins["drum"] else _note_lines(evs, pitch)
            sig = ins["name"] + "|" + str(nbars) + "|" + "|".join(lines)
            pname = by_sig.get(sig)
            if not pname:
                counters[ins["name"]] = counters.get(ins["name"], 0) + 1
                pname = f"{ins['name']}{counters[ins['name']]}"
                by_sig[sig] = pname
                # a pattern is as long as its part even when its last bar is silent (else it would loop early)
                natural = max(1, int(-(-max(t + d for t, d, _, _ in evs) // bar_len))) if lines[0] == "events:" else nbars
                patterns.append((pname, ins["name"], lines, nbars if natural != nbars else None))
            play.append(pname)
        if sections and sections[-1]["play"] == play and play:
            sections[-1]["bars"] += nbars                 # the same patterns again: they loop
        else:
            sections.append({"bars": nbars, "play": play})

    title = (data["title"] or path.stem).strip() or path.stem
    out = [f"# Imported from {path.name} — {len(insts)} instruments, {total_bars} bars (edit freely; studio-daw docs)", "song:",
           f"  title: {_yaml_str(title)}", f"  bpm: {_num(data['bpm'])}", f"  time: {num}/{den}", "", "instruments:"]
    for ins in insts:
        out.append(f"  {ins['name']}: {{ use: {ins['use']} }}")
    out += ["", "patterns:"]
    for pname, inst, lines, pbars in patterns:
        out.append(f"  {pname}:")
        if pbars:
            out.append(f"    bars: {pbars}")
        out.append(f"    {inst}:" + ("" if lines[0] == "events:" else " |"))
        out += [f"      {ln}" for ln in lines]
    out += ["", "arrangement:"]
    for i, s in enumerate(sections):
        out.append(f"  - {{ section: part{i + 1}, bars: {s['bars']}, play: [{', '.join(s['play'])}] }}")
    out.append("")
    facts = {"bpm": data["bpm"], "time": f"{num}/{den}", "bars": total_bars, "instruments": {i["name"]: i["use"] for i in insts},
             "patterns": len(patterns), "sections": len(sections), "warnings": []}
    if data["tempo_changes"]:
        facts["warnings"].append(f"the file changes its tempo {data['tempo_changes']} time(s) — the song uses the first tempo ({_num(data['bpm'])} bpm); set bpm per section in the arrangement where needed")
    if cut:
        facts["warnings"].append(f"only the first {total_bars} bars were imported (--max-bars)")
    if gm and not programs:
        facts["warnings"].append("the gm-instruments pack is not installed — built-in synths play the tracks")
    return "\n".join(out) + "\n", facts


def _yaml_str(s: str) -> str:
    return s if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.()'&+-]*", s) and not re.fullmatch(r"(?i)(true|false|null|yes|no|on|off|~|[0-9.]+)", s) else '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _note_lines(evs, pitch) -> list[str]:
    lines = ["events:"]
    for t, d, n, v in sorted(evs):
        lines.append(f"  - {{ t: {_num(t)}, n: {pitch(n)}, d: {_num(d)}, v: {_num(v)} }}")
    return lines


def _drum_lines(evs, ins, length: float, note_names: dict) -> list[str]:
    def sound(n: int) -> str:
        if ins["synth_kit"]:
            return SYNTH_DRUMS.get(n, "hat" if n >= 60 else "tom2")
        return note_names.get(n, str(n))

    step = 0.25
    on_grid = all(abs(t / step - round(t / step)) < 1e-6 for t, _, _, _ in evs)
    steps = int(round(length / step))
    if on_grid and steps <= 256:
        rows: dict[str, list[str]] = {}
        for t, _, n, v in sorted(evs):
            row = rows.setdefault(sound(n), ["-"] * steps)
            i = int(round(t / step))
            if i < steps:
                row[i] = "X" if v >= 0.9 else "o" if v < 0.45 else "x"
        width = max(len(k) for k in rows) + 1
        group = 16 if steps % 16 == 0 else steps      # a space between bars keeps long grids readable
        return [f"{(k + ':').ljust(width)} " + " ".join("".join(cells)[i : i + group] for i in range(0, steps, group)) for k, cells in rows.items()]
    lines = ["events:"]
    for t, d, n, v in sorted(evs):
        lines.append(f"  - {{ t: {_num(t)}, k: {sound(n)}, d: {_num(d)}, v: {_num(v)} }}")
    return lines
