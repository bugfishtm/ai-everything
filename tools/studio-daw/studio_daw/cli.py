"""studio-daw command line."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import __version__, registry
from .templates import PLUGIN_EFFECT, PLUGIN_INSTRUMENT, SONG_TEMPLATES

HELP = """studio-daw — make music from text (songs are YAML files, see: studio-daw docs)

  studio-daw new <file.song.yaml> [--template basic|gm|ambient|lofi|chiptune|house]
  studio-daw import <file.mid> [--out FILE] [--bars 4] [--quantize 16] [--synths]   MIDI file → song text
  studio-daw check <song>                      validate, list warnings (fast)
  studio-daw render <song> [--stems] [--midi] [--preview] [--from BAR --to BAR] [--out DIR] [--format wav,mp3]
  studio-daw midi <song> [--out FILE]          MIDI only (tempo map, GM programs, drums on channel 10)
  studio-daw export <song> --what wav,mp3,midi,stems [--zip]   everything for other DAWs, optionally as one zip
  studio-daw info <song>                       sections, instruments, length
  studio-daw instruments [words]               built-ins, project plugins and pack instruments
  studio-daw effects                           effects and their parameters
  studio-daw analyze <audio> [--preview]       loudness, peak, spectrum balance of any audio file
  studio-daw sfx [list | <name>[,<name>…] | all] [--pitch 1] [--dur 1] [--seed 1] [--variants N] [--mp3] [--out DIR|FILE]
                                               one-shot sound effects for games and videos (coin, jump, hit …)
  studio-daw plugin new <name> [--kind instrument|effect]   extend the DAW (plugins/daw/<name>.py)
  studio-daw docs                              full format reference
<song> may be "-" to read the YAML from stdin (with --path for its name/location).
Editor engine (used by the website DAW): studio-daw model <song> | catalog | sounds (JSON on stdin)
Add --json for machine readable output."""


def out(args, data, text: str) -> None:
    print(json.dumps(data, default=str) if args.json else text)


def fail(args, msg: str, code: int = 1) -> None:
    if getattr(args, "json", False) or getattr(args, "cmd", "") in ("model", "sounds"):
        print(json.dumps({"ok": False, "error": msg}), file=sys.__stdout__, flush=True)
    else:
        print(f"studio-daw: {msg}", file=sys.stderr)
    sys.exit(code)


def _song_text(args) -> tuple[str, Path]:
    """The song's YAML and its path; "-" reads stdin (unsaved text from the website DAW)."""
    if args.song == "-":
        return sys.stdin.read(), Path(getattr(args, "path", None) or "song.song.yaml")
    path = Path(args.song)
    try:
        return path.read_text("utf-8"), path
    except FileNotFoundError:
        fail(args, f"file not found: {path}")
    except UnicodeDecodeError:
        fail(args, f"{path} is not a text file")
    raise SystemExit(1)


def _load(args):
    from .song import SongError, load_song_text

    text, path = _song_text(args)
    try:
        return load_song_text(text, path)
    except SongError as e:
        fail(args, str(e))


def _base_name(args, song) -> str:
    name = getattr(args, "name", None) or Path(song.path).name.split(".")[0] or "song"
    if getattr(args, "from_bar", None) or getattr(args, "to_bar", None):
        a = f"{args.from_bar:g}" if args.from_bar else "1"
        b = f"{args.to_bar:g}" if args.to_bar else "end"
        name += f"-bars{a}-{b}"
    return name


class _Quiet:
    """Send plugin print() output to stderr so the JSON on stdout stays clean."""

    def __enter__(self):
        self.prev = sys.stdout
        sys.stdout = sys.stderr

    def __exit__(self, *exc):
        sys.stdout = self.prev


def cmd_new(args):
    path = Path(args.file)
    if not path.name.endswith((".song.yaml", ".song.yml")):
        path = path.with_name(path.name.split(".")[0] + ".song.yaml")
    if path.exists() and not args.force:
        fail(args, f"{path} exists (use --force to overwrite)")
    tpl = SONG_TEMPLATES.get(args.template)
    if not tpl:
        fail(args, f"unknown template {args.template} ({', '.join(SONG_TEMPLATES)})")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(tpl.replace("{{TITLE}}", path.name.split(".")[0].replace("-", " ").title()), "utf-8")
    out(args, {"ok": True, "file": str(path)}, f"Created {path} — render it with: studio-daw render {path} --preview")


def cmd_check(args):
    song = _load(args)
    data = {
        "ok": True,
        "title": song.title,
        "bpm": song.bpm,
        "time": f"{song.meter[0]}/{song.meter[1]}",
        "bars": song.total_bars,
        "seconds": round(song.duration, 2),
        "instruments": {k: v.describe() for k, v in song.instruments.items()},
        "patterns": {k: round(p.length / song.bar_len, 2) for k, p in song.patterns.items()},
        "warnings": song.warnings,
    }
    lines = [f"OK — {song.title}: {song.total_bars:g} bars, {song.duration:.1f}s at {song.bpm:g} bpm"]
    lines += [f"warning: {w}" for w in song.warnings]
    out(args, data, "\n".join(lines))


def cmd_info(args):
    song = _load(args)
    lines = [f"{song.title} — {song.bpm:g} bpm, {song.meter[0]}/{song.meter[1]}, {song.total_bars:g} bars, {song.duration:.1f}s"]
    lines.append("instruments:")
    for k, v in song.instruments.items():
        lines.append(f"  {k}: {v.describe()}")
    lines.append("patterns:")
    for k, p in song.patterns.items():
        lines.append(f"  {k}: {p.length / song.bar_len:g} bar(s) — {', '.join(f'{i} ({len(t.events)} notes)' for i, t in p.tracks.items())}")
    lines.append("arrangement:")
    for s in song.sections:
        lines.append(f"  {s.start_sec:7.2f}s  {s.name}: {s.bars:g} bars @ {s.bpm:g} bpm — {', '.join(p for p, _ in s.play)}")
    data = {
        "title": song.title, "bpm": song.bpm, "bars": song.total_bars, "seconds": song.duration,
        "sections": [{"name": s.name, "start": round(s.start_sec, 3), "bars": s.bars, "bpm": s.bpm, "play": [p for p, _ in s.play]} for s in song.sections],
        "instruments": {k: v.describe() for k, v in song.instruments.items()},
    }
    out(args, data, "\n".join(lines))


def cmd_render(args):
    from .render import preview_png, render_song, to_mp3, write_audio, write_midi

    song = _load(args)
    t0 = time.time()
    try:
        res = render_song(song, from_bar=args.from_bar, to_bar=args.to_bar)
    except Exception as e:  # noqa: BLE001
        fail(args, f"render failed: {type(e).__name__}: {e}")
    project = registry.project_dir()
    out_dir = Path(args.out) if args.out else project / "exports"
    name = _base_name(args, song)
    formats = [f.strip() for f in args.format.split(",") if f.strip()]
    wav = out_dir / f"{name}.wav"
    write_audio(wav, res["master"], song.sr)
    files = {"wav": str(wav)}
    if "mp3" in formats:
        mp3 = to_mp3(wav)
        if mp3:
            files["mp3"] = str(mp3)
    if "wav" not in formats and "mp3" in files:
        wav.unlink()
        del files["wav"]
    if args.stems:
        for k, x in res["stems"].items():
            write_audio(out_dir / f"{name}-stems" / f"{k}.wav", x, song.sr)
        files["stems"] = str(out_dir / f"{name}-stems")
    if args.midi:
        write_midi(out_dir / f"{name}.mid", song, song.events(args.from_bar, args.to_bar, humanize=False), args.from_bar)
        files["midi"] = str(out_dir / f"{name}.mid")
    if args.preview:
        png = project / ".studio" / "previews" / f"{name}.png"
        secs = [(s.name, s.start_sec) for s in song.sections] if not (args.from_bar or args.to_bar) else []
        preview_png(png, res["master"], song.sr, f"{song.title} — {res['lufs']:.1f} LUFS, peak {res['peak']:.1f} dBFS", secs)
        files["preview"] = str(png)
    from . import dsp

    tracks = [{"name": k, "notes": res["notes"].get(k, 0), "peak_dbfs": round(dsp.peak_db(x), 1), "rms_dbfs": round(dsp.rms_db(x), 1)} for k, x in res["stems"].items()]
    warns = song.warnings + res["warnings"]
    for tr in tracks:
        if tr["notes"] and tr["rms_dbfs"] < -60:
            warns.append(f'track "{tr["name"]}" is almost silent ({tr["rms_dbfs"]} dBFS RMS)')
    report = {
        "ok": True,
        "files": files,
        "seconds": round(len(res["master"]) / song.sr, 2),
        "lufs": round(res["lufs"], 1),
        "peak_dbfs": round(res["peak"], 1),
        "bpm": song.bpm,
        "sections": [{"name": s.name, "start": round(s.start_sec, 2), "bars": s.bars} for s in song.sections],
        "tracks": tracks,
        "warnings": warns,
        "render_seconds": round(time.time() - t0, 1),
    }
    lines = [f"Rendered {song.title}: {report['seconds']}s, {report['lufs']} LUFS, peak {report['peak_dbfs']} dBFS ({report['render_seconds']}s)"]
    lines += [f"  {k}: {v}" for k, v in files.items()]
    lines += ["tracks:"] + [f"  {t['name']:<12} {t['notes']:>4} notes  peak {t['peak_dbfs']:>6} dBFS  rms {t['rms_dbfs']:>6} dBFS" for t in tracks]
    lines += [f"warning: {w}" for w in warns]
    if args.preview:
        lines.append(f"Look at the spectrogram: read {files['preview']}")
    out(args, report, "\n".join(lines))


def cmd_instruments(args):
    registry.load_builtins()
    registry.load_project_plugins()
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
    from studio_packs import all_packs

    words = [w.lower() for w in (args.words or [])]

    def match(*parts):
        hay = " ".join(str(p) for p in parts).lower()
        return all(w in hay for w in words)

    voices = [{"use": "drums", "source": "built-in", "doc": "Synth drum kit: kick snare clap rim hat ohat tom1 tom2 tom3 crash ride shaker cowbell", "params": {}}]
    voices += [{"use": e.name, "source": e.source, "doc": e.doc.split("\n")[0], "params": e.params, "drum": e.drum} for e in registry.VOICES.values()]
    voices = [v for v in voices if match(v["use"], v["doc"], v["source"])]
    packs = []
    for p in all_packs():
        if p.type != "music":
            continue
        for it in p.items.values():
            if it.get("kind") in ("instrument", "drumkit", "sample", "kit", "preset", "plugin", "loop") and match(p.id, it["id"], it.get("name", ""), it.get("kind"), " ".join(it.get("tags", []))):
                packs.append({"use": f"{p.id}/{it['id']}", "kind": it.get("kind"), "name": it.get("name", it["id"]), "pack": p.manifest.get("name", p.id)})
    lines = ["Built-in and plugin instruments (use: <name>):"]
    lines += [f"  {v['use']:<12} {v['doc']}  [{v['source']}]" + (f"  params: {', '.join(f'{k}={val}' for k, val in v['params'].items())}" if v["params"] else "") for v in voices]
    lines.append(f"Pack instruments (use: <pack>/<item>) — {len(packs)} match(es):")
    lines += [f"  {x['use']:<44} {x['kind']:<10} {x['name']}" for x in packs[:300]]
    if len(packs) > 300:
        lines.append(f"  … {len(packs) - 300} more — narrow down: studio-daw instruments <words>")
    lines += [f"plugin error: {e['file']}: {e['error']}" for e in registry.PLUGIN_ERRORS]
    out(args, {"voices": voices, "packs": packs, "pluginErrors": registry.PLUGIN_ERRORS}, "\n".join(lines))


def cmd_effects(args):
    registry.load_builtins()
    registry.load_project_plugins()
    effs = [{"use": e.name, "doc": e.doc.split("\n")[0], "params": e.params, "source": e.source} for e in registry.EFFECTS.values()]
    lines = ["Effects (mix: { <instrument>: { effects: [ {use: reverb, mix: 0.3} ] } }):"]
    lines += [f"  {e['use']:<11} {e['doc']}  params: {', '.join(f'{k}={v}' for k, v in e['params'].items())}  [{e['source']}]" for e in effs]
    lines += [f"plugin error: {e['file']}: {e['error']}" for e in registry.PLUGIN_ERRORS]
    out(args, {"effects": effs, "pluginErrors": registry.PLUGIN_ERRORS}, "\n".join(lines))


def cmd_analyze(args):
    import soundfile as sf

    from .render import analyze_audio, preview_png

    try:
        x, sr = sf.read(args.file, always_2d=True, dtype="float64")
    except Exception as e:  # noqa: BLE001
        fail(args, f"cannot read audio: {e}")
    info = analyze_audio(x, sr)
    if args.preview:
        png = registry.project_dir() / ".studio" / "previews" / f"{Path(args.file).stem}-analysis.png"
        preview_png(png, x, sr, f"{Path(args.file).name} — {info['lufs']} LUFS")
        info["preview"] = str(png)
    lines = [f"{args.file}: {info['duration']}s, {info['lufs']} LUFS, peak {info['peak_dbfs']} dBFS, rms {info['rms_dbfs']} dBFS, width {info['stereo_width']}"]
    lines.append("spectrum: " + ", ".join(f"{k} {v}%" for k, v in info["spectrum_balance"].items()))
    if info["clipped_samples"]:
        lines.append(f"warning: {info['clipped_samples']} clipped samples")
    if args.preview:
        lines.append(f"preview: {info['preview']}")
    out(args, info, "\n".join(lines))


def cmd_import(args):
    from .cli_extra import cmd_import as run

    run(args, out, fail, _Quiet)


def cmd_sfx(args):
    from .cli_extra import cmd_sfx as run

    run(args, out, fail, _Quiet)


def cmd_plugin(args):
    if args.action != "new":
        fail(args, "usage: studio-daw plugin new <name> [--kind instrument|effect]")
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    path = registry.project_dir() / "plugins" / "daw" / f"{name}.py"
    if path.exists():
        fail(args, f"{path} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    tpl = PLUGIN_EFFECT if args.kind == "effect" else PLUGIN_INSTRUMENT
    path.write_text(tpl.replace("{{NAME}}", name), "utf-8")
    out(args, {"ok": True, "file": str(path)}, f"Created {path}. Use it in a song: {'mix effects: [{use: ' + name + '}]' if args.kind == 'effect' else 'instruments: { x: { use: ' + name + ' } }'}")


def cmd_model(args):
    """Everything the website DAW needs to show and play the song (always JSON)."""
    from .editor import song_model
    from .song import SongError, load_song_text

    text, path = _song_text(args)
    with _Quiet():
        try:
            song = load_song_text(text, path)
            data = song_model(song)
        except SongError as e:
            data = {"ok": False, "error": str(e), "pluginErrors": registry.PLUGIN_ERRORS}
        except Exception as e:  # noqa: BLE001
            data = {"ok": False, "error": f"{type(e).__name__}: {e}", "pluginErrors": registry.PLUGIN_ERRORS}
    print(json.dumps(data, default=str))


def cmd_catalog(args):
    from .editor import catalog

    with _Quiet():
        data = catalog()
    if args.json:
        print(json.dumps(data, default=str))
        return
    print(f"{len(data['voices'])} instruments, {len(data['effects'])} effects, {len(data['packs'])} pack items")
    for e in data["pluginErrors"]:
        print(f"plugin error: {e['file']}: {e['error']}")


def cmd_sounds(args):
    """Render single notes of the song's instruments into the per-user sound cache (JSON in on stdin)."""
    from .editor import render_sounds
    from .song import SongError

    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "error": f"invalid JSON on stdin: {e}"}))
        return
    with _Quiet():
        try:
            data = render_sounds(req)
        except SongError as e:
            data = {"ok": False, "error": str(e)}
    print(json.dumps(data, default=str))


def cmd_midi(args):
    from .render import write_midi

    with _Quiet():
        song = _load(args)
        project = registry.project_dir()
        if args.out and args.out.lower().endswith((".mid", ".midi")):
            target = Path(args.out)
        else:
            target = (Path(args.out) if args.out else project / "exports") / f"{_base_name(args, song)}.mid"
        events = song.events(args.from_bar, args.to_bar, humanize=False)
        write_midi(target, song, events, args.from_bar)
    notes = sum(len(v) for v in events.values())
    out(args, {"ok": True, "files": {"midi": str(target)}, "tracks": len(events), "notes": notes, "warnings": song.warnings},
        f"Wrote {target} ({len(events)} tracks, {notes} notes)")


def _project_files_used(song) -> list[Path]:
    """Project plugins and samples a song needs (so an export bundle can be opened elsewhere)."""
    from .instruments import KitInstrument, SampleInstrument, VoiceInstrument

    proj = registry.project_dir().resolve()
    found: set[Path] = set()

    def add(p) -> None:
        if not p:
            return
        try:
            rp = Path(p).resolve()
            rp.relative_to(proj)
        except (ValueError, OSError):
            return
        if rp.is_file():
            found.add(rp)

    def walk(inst, depth=0):
        if depth > 6:
            return
        if isinstance(inst, VoiceInstrument) and inst.entry.source.startswith("project:"):
            add(inst.entry.file)
        elif isinstance(inst, SampleInstrument):
            add(inst.path)
        elif isinstance(inst, KitInstrument):
            for part in inst.parts.values():
                walk(part, depth + 1)

    for inst in song.instruments.values():
        walk(inst)
    for m in [*song.mix.values(), song.master]:
        for eff in m.get("effects") or []:
            name = eff if isinstance(eff, str) else (eff or {}).get("use")
            entry = registry.EFFECTS.get(name)
            if entry and entry.source.startswith("project:"):
                add(entry.file)
    return sorted(found)


def cmd_export(args):
    """Exports for people and other DAWs: wav, mp3, midi, stems, and a zip with all of it + the song text."""
    import zipfile

    from . import dsp
    from .render import preview_png, render_song, to_mp3, write_audio, write_midi
    from .song import SongError, load_song_text

    t0 = time.time()
    text, src_path = _song_text(args)
    what = {w.strip().lower() for w in (args.what or "wav,mp3").split(",") if w.strip()}
    unknown = what - {"wav", "mp3", "midi", "stems", "yaml"}
    if unknown:
        fail(args, f"unknown export kind(s): {', '.join(sorted(unknown))} (wav, mp3, midi, stems, yaml)")
    with _Quiet():
        try:
            song = load_song_text(text, src_path)
        except SongError as e:
            fail(args, str(e))
        project = registry.project_dir()
        out_dir = Path(args.out) if args.out else project / "exports"
        name = _base_name(args, song)
        files: dict[str, str] = {}
        report: dict = {"ok": True, "title": song.title, "bpm": song.bpm, "warnings": list(song.warnings)}
        res = None
        if what & {"wav", "mp3", "stems"} or args.preview:
            try:
                res = render_song(song, from_bar=args.from_bar, to_bar=args.to_bar)
            except Exception as e:  # noqa: BLE001
                fail(args, f"render failed: {type(e).__name__}: {e}")
            wav = out_dir / f"{name}.wav"
            write_audio(wav, res["master"], song.sr)
            files["wav"] = str(wav)
            if "mp3" in what:
                mp3 = to_mp3(wav)
                if mp3:
                    files["mp3"] = str(mp3)
                else:
                    report["warnings"].append("mp3 skipped: ffmpeg is not available")
            if "stems" in what:
                stem_dir = out_dir / f"{name}-stems"
                if stem_dir.is_dir():
                    for old in stem_dir.glob("*.wav"):
                        old.unlink()
                for k, x in res["stems"].items():
                    write_audio(stem_dir / f"{k}.wav", x, song.sr)
                files["stems"] = str(stem_dir)
            if args.preview:
                png = project / ".studio" / "previews" / f"{name}.png"
                secs = [(s.name, s.start_sec) for s in song.sections] if not (args.from_bar or args.to_bar) else []
                preview_png(png, res["master"], song.sr, f"{song.title} — {res['lufs']:.1f} LUFS, peak {res['peak']:.1f} dBFS", secs)
                files["preview"] = str(png)
            tracks = [{"name": k, "notes": res["notes"].get(k, 0), "peak_dbfs": round(dsp.peak_db(x), 1), "rms_dbfs": round(dsp.rms_db(x), 1)}
                      for k, x in res["stems"].items()]
            for tr in tracks:
                if tr["notes"] and tr["rms_dbfs"] < -60:
                    report["warnings"].append(f'track "{tr["name"]}" is almost silent ({tr["rms_dbfs"]} dBFS RMS)')
            report.update(seconds=round(len(res["master"]) / song.sr, 2), lufs=round(res["lufs"], 1), peak_dbfs=round(res["peak"], 1),
                          tracks=tracks, sections=[{"name": s.name, "start": round(s.start_sec, 3), "bars": s.bars} for s in song.sections])
            report["warnings"] += res["warnings"]
        if "midi" in what:
            events = song.events(args.from_bar, args.to_bar, humanize=False)  # the notes as written
            mid = out_dir / f"{name}.mid"
            write_midi(mid, song, events, args.from_bar)
            files["midi"] = str(mid)
        if "yaml" in what:
            y = out_dir / f"{name}.song.yaml"
            y.parent.mkdir(parents=True, exist_ok=True)
            y.write_text(text, "utf-8")
            files["yaml"] = str(y)
        if args.zip:
            z = out_dir / f"{name}-export.zip"
            z.parent.mkdir(parents=True, exist_ok=True)
            extra = _project_files_used(song)
            with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr(f"{name}/{name}.song.yaml", text)
                for kind in ("wav", "mp3", "midi"):
                    if kind in files and (kind in what or kind == "wav"):
                        zf.write(files[kind], f"{name}/{Path(files[kind]).name}",
                                 compress_type=zipfile.ZIP_STORED if kind == "mp3" else zipfile.ZIP_DEFLATED)
                if "stems" in files:
                    for f in sorted(Path(files["stems"]).glob("*.wav")):
                        zf.write(f, f"{name}/stems/{f.name}")
                for f in extra:
                    zf.write(f, f"{name}/{f.relative_to(project.resolve()).as_posix()}")
                secs = report.get("seconds", round(song.duration, 2))
                zf.writestr(f"{name}/README.txt", "\n".join([
                    f"{song.title} - exported from Everything Studio (studio-daw)",
                    f"{song.bpm:g} bpm, {song.meter[0]}/{song.meter[1]}, {song.total_bars:g} bars, {secs}s",
                    "",
                    f"{name}.song.yaml   the song as text: open it in the Studio DAW (or edit it by hand)",
                    *([f"{name}.mid         MIDI: one track per instrument, drums on channel 10, tempo map"] if "midi" in files else []),
                    *([f"{name}.wav / .mp3  the mixdown"] if "wav" in files else []),
                    *(["stems/*.wav         one file per instrument, all starting at 0:00 - drop them into any DAW"] if "stems" in files else []),
                    *(["plugins/, assets/   project instruments, effects and samples this song uses"] if extra else []),
                    "",
                ]))
            files["zip"] = str(z)
        if "wav" not in what and "wav" in files:
            Path(files.pop("wav")).unlink(missing_ok=True)
    report["files"] = files
    report["render_seconds"] = round(time.time() - t0, 1)
    lines = [f"Exported {song.title} ({report['render_seconds']}s)"] + [f"  {k}: {v}" for k, v in files.items()]
    lines += [f"warning: {w}" for w in report["warnings"]]
    out(args, report, "\n".join(lines))


def cmd_docs(args):
    print((Path(__file__).resolve().parents[1] / "README.md").read_text("utf-8"))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="studio-daw", add_help=False)
    p.add_argument("-h", "--help", action="store_true")
    p.add_argument("--version", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    def add(name, fn, *a):
        sp = sub.add_parser(name, add_help=True)
        sp.add_argument("--json", action="store_true")
        sp.set_defaults(fn=fn)
        return sp

    sp = add("new", cmd_new)
    sp.add_argument("file")
    sp.add_argument("--template", default="basic")
    sp.add_argument("--force", action="store_true")
    for name, fn in (("check", cmd_check), ("info", cmd_info), ("model", cmd_model)):
        sp = add(name, fn)
        sp.add_argument("song")
        sp.add_argument("--path", help='name/location of the song when it is read from stdin ("-")')
    sp = add("render", cmd_render)
    sp.add_argument("song")
    sp.add_argument("--path")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--format", default="wav,mp3")
    sp.add_argument("--stems", action="store_true")
    sp.add_argument("--midi", action="store_true")
    sp.add_argument("--preview", action="store_true")
    sp.add_argument("--from", dest="from_bar", type=float)
    sp.add_argument("--to", dest="to_bar", type=float)
    sp = add("midi", cmd_midi)
    sp.add_argument("song")
    sp.add_argument("--path")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--from", dest="from_bar", type=float)
    sp.add_argument("--to", dest="to_bar", type=float)
    sp = add("export", cmd_export)
    sp.add_argument("song")
    sp.add_argument("--path")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--what", default="wav,mp3", help="wav,mp3,midi,stems,yaml")
    sp.add_argument("--zip", action="store_true", help="also bundle everything (+ the song text, used plugins/samples) as one zip")
    sp.add_argument("--preview", action="store_true")
    sp.add_argument("--from", dest="from_bar", type=float)
    sp.add_argument("--to", dest="to_bar", type=float)
    sp = add("import", cmd_import)
    sp.add_argument("file")
    sp.add_argument("--out")
    sp.add_argument("--bars", default="4", help="bars per section (0 = one section)")
    sp.add_argument("--quantize", default="16", help="grid: 16 = sixteenths, 32, 48 … (0 = keep the timing)")
    sp.add_argument("--max-bars", dest="max_bars")
    sp.add_argument("--synths", action="store_true", help="built-in synths instead of the General MIDI pack")
    sp.add_argument("--force", action="store_true")
    sp = add("sfx", cmd_sfx)
    sp.add_argument("kind", nargs="?")
    sp.add_argument("--out")
    sp.add_argument("--pitch", default="1")
    sp.add_argument("--dur", default="1")
    sp.add_argument("--seed", default="1")
    sp.add_argument("--variants", default="1")
    sp.add_argument("--mp3", action="store_true")
    add("catalog", cmd_catalog)
    add("sounds", cmd_sounds)
    add("instruments", cmd_instruments).add_argument("words", nargs="*")
    add("effects", cmd_effects)
    sp = add("analyze", cmd_analyze)
    sp.add_argument("file")
    sp.add_argument("--preview", action="store_true")
    sp = add("plugin", cmd_plugin)
    sp.add_argument("action")
    sp.add_argument("name")
    sp.add_argument("--kind", default="instrument", choices=["instrument", "effect"])
    add("docs", cmd_docs)
    args = p.parse_args(argv)
    if args.version:
        print(f"studio-daw {__version__}")
        return
    if args.help or not args.cmd:
        print(HELP)
        return
    try:
        args.fn(args)
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as e:  # noqa: BLE001  (a JSON error instead of a traceback)
        fail(args, f"{type(e).__name__}: {e}")
