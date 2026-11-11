"""More studio-daw commands: `import` (MIDI file -> song) and `sfx` (one-shot sound effects)."""
from __future__ import annotations

import re
from pathlib import Path

from . import registry


def cmd_import(args, out, fail, quiet):
    from .midi_import import MidiImportError, midi_to_song
    from .song import SongError, load_song

    src = Path(args.file)
    if not src.is_file():
        fail(args, f"file not found: {src}")
    if src.suffix.lower() not in (".mid", ".midi"):
        fail(args, f"{src.name} is not a MIDI file (.mid)")
    stem = re.sub(r"[^a-z0-9]+", "-", src.stem.lower()).strip("-") or "imported"
    dest = Path(args.out) if args.out else registry.project_dir() / "src" / f"{stem}.song.yaml"
    if not dest.name.endswith((".song.yaml", ".song.yml")):
        dest = dest.with_name(dest.name.split(".")[0] + ".song.yaml")
    if dest.exists() and not args.force:
        fail(args, f"{dest} exists (use --force to overwrite, or --out another.song.yaml)")
    try:
        with quiet():
            text, facts = midi_to_song(src, quantize=int(args.quantize), bars=int(args.bars), gm=not args.synths,
                                       max_bars=int(args.max_bars) if args.max_bars else None)
    except MidiImportError as e:
        fail(args, str(e))
    except ValueError as e:
        fail(args, f"cannot import {src.name}: {e}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, "utf-8")
    try:
        with quiet():
            song = load_song(dest)
        facts["seconds"] = round(song.duration, 2)
        facts["warnings"] += [w for w in song.warnings if w not in facts["warnings"]][:20]
    except SongError as e:
        facts["warnings"].append(f"the imported song does not validate yet: {e}")
    lines = [f"Imported {src.name} → {dest}: {facts['bars']} bars at {facts['bpm']:g} bpm ({facts['time']}), "
             f"{len(facts['instruments'])} instruments, {facts['patterns']} patterns in {facts['sections']} sections"]
    lines += [f"  {k}: {v}" for k, v in facts["instruments"].items()]
    lines += [f"warning: {w}" for w in facts["warnings"]]
    lines.append(f"Next: studio-daw render {dest} --preview   (the instruments are a first guess — change `use:` freely)")
    out(args, {"ok": True, "file": str(dest), **facts}, "\n".join(lines))


def cmd_sfx(args, out, fail, quiet):
    from . import dsp, sfx
    from .render import to_mp3, write_audio

    kind = (args.kind or "list").lower()
    if kind in ("list", "ls"):
        data = [{"name": k, "doc": doc} for k, (_, doc) in sfx.RECIPES.items()]
        out(args, {"ok": True, "sounds": data},
            "\n".join(f"  {d['name']:<10} {d['doc']}" for d in data) + "\nMake one: studio-daw sfx <name> [--pitch 1.2] [--dur 0.8] [--seed 3] [--variants 4] [--out assets/sfx]")
        return
    names = list(sfx.RECIPES) if kind == "all" else [k.strip() for k in kind.split(",") if k.strip()]
    for k in names:
        if k not in sfx.RECIPES:
            import difflib

            close = difflib.get_close_matches(k, list(sfx.RECIPES), n=3, cutoff=0.5)
            fail(args, f'unknown sound "{k}"' + (f" — did you mean {', '.join(close)}?" if close else "") + " (studio-daw sfx list)")
    out_dir = Path(args.out) if args.out else registry.project_dir() / "exports" / "sfx"
    single_file = out_dir.suffix.lower() in (".wav", ".mp3") and len(names) == 1 and int(args.variants) <= 1
    variants = max(1, min(16, int(args.variants)))
    pitch, dur, seed = float(args.pitch), float(args.dur), int(args.seed)
    files, made = [], []
    import numpy as np

    for k in names:
        for v in range(variants):
            rng = np.random.default_rng(seed * 1000 + v)
            # further variants differ a little in pitch and length (same family, not the same sound)
            vp = pitch * (1.0 if v == 0 else float(2 ** rng.uniform(-0.25, 0.25)))
            vd = dur * (1.0 if v == 0 else float(rng.uniform(0.8, 1.25)))
            with quiet():
                x = sfx.make(k, dsp.SR, vp, vd, seed + v)
            if single_file:
                wav = out_dir.with_suffix(".wav")
            else:
                wav = out_dir / (f"{k}.wav" if variants == 1 else f"{k}-{v + 1}.wav")
            write_audio(wav, x, dsp.SR)
            path = wav
            if args.mp3 or (single_file and out_dir.suffix.lower() == ".mp3"):
                mp3 = to_mp3(wav)
                if mp3:
                    path = mp3
                    if single_file and out_dir.suffix.lower() == ".mp3":
                        wav.unlink()
            files.append(str(path))
            made.append({"name": k, "file": str(path), "seconds": round(len(x) / dsp.SR, 3), "pitch": round(vp, 3)})
    lines = [f"  {m['file']}  ({m['seconds']}s)" for m in made]
    out(args, {"ok": True, "files": files, "sounds": made}, f"Made {len(made)} sound effect(s):\n" + "\n".join(lines))
