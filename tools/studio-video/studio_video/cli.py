"""studio-video command line."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from . import __version__, registry
from .templates import PLUGINS, VIDEOS

HELP = """studio-video — videos from text timelines (videos are YAML files, see: studio-video docs)

  studio-video new <file.video.yaml> [--template trailer|slideshow|social|blank]
  studio-video check <video>                    validate fast: files, times, names
  studio-video info <video>                     the timeline as a table: what is shown and heard when
  studio-video sheet <video> [--count 12] [--at T,T,…]      contact sheet PNG of the key moments — look before rendering
  studio-video render <video> [--preview] [--draft] [--from T --to T] [--gif] [--webm] [--no-audio] [--out DIR] [--name N]
                                                → exports/<name>.mp4 (+ .srt when it has subtitles, + contact sheet with --preview)
  studio-video still <video> <t…>               single frames as PNG
  studio-video probe <media file>               length, size, frame rate and sound of ANY video / audio / image file
  studio-video frames <media file> [--count 12] [--at T,T,…]   contact sheet of a video file — to see what footage contains
  studio-video list [transitions|generators|fonts] [words]
  studio-video plugin new <name> [--kind transition|generator]   extend the tool (plugins/video/<name>.py)
  studio-video docs                             full format reference
Times: seconds (12.5) or minutes:seconds ("1:23"). Add --json for machine readable output."""


def out(args, data, text: str) -> None:
    print(json.dumps(data, default=str) if args.json else text)


def fail(args, msg: str, code: int = 1) -> None:
    if getattr(args, "json", False):
        print(json.dumps({"ok": False, "error": msg}), file=sys.__stdout__, flush=True)
    else:
        print(f"studio-video: {msg}", file=sys.stderr)
    sys.exit(code)


class _Quiet:
    """plugin print() output goes to stderr so JSON on stdout stays clean"""

    def __enter__(self):
        self.prev = sys.stdout
        sys.stdout = sys.stderr

    def __exit__(self, *exc):
        sys.stdout = self.prev


def _load(args):
    from .timeline import VideoError, load_timeline

    try:
        with _Quiet():
            return load_timeline(args.video)
    except VideoError as e:
        fail(args, str(e))


def _name(args) -> str:
    return getattr(args, "name", None) or Path(args.video).name.split(".")[0] or "video"


def _t(args, v, where: str) -> float:
    from .timeline import VideoError, parse_time

    try:
        return parse_time(v, where)
    except VideoError as e:
        fail(args, str(e))
    return 0.0


def _range(args, tl) -> tuple[float, float]:
    t0 = _t(args, args.from_t, "--from") if getattr(args, "from_t", None) is not None else 0.0
    t1 = _t(args, args.to_t, "--to") if getattr(args, "to_t", None) is not None else tl.duration
    t0 = max(0.0, min(t0, tl.duration))
    t1 = max(t0 + 1.0 / tl.fps, min(t1, tl.duration))
    return t0, t1


def cmd_new(args):
    path = Path(args.file)
    if not path.name.endswith((".video.yaml", ".video.yml")):
        path = path.with_name(path.name.split(".")[0] + ".video.yaml")
    if path.exists() and not args.force:
        fail(args, f"{path} exists (use --force to overwrite)")
    tpl = VIDEOS.get(args.template)
    if not tpl:
        fail(args, f"unknown template {args.template} ({', '.join(VIDEOS)})")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(tpl.replace("{{TITLE}}", path.name.split(".")[0].replace("-", " ").replace("_", " ").title()), "utf-8")
    out(args, {"ok": True, "file": str(path)}, f"Created {path} — look at it first: studio-video sheet {path}   then: studio-video render {path} --preview")


def _summary(tl) -> dict:
    return {"ok": True, "title": tl.title, "seconds": tl.duration, "fps": tl.fps, "size": [tl.w, tl.h], "clips": len(tl.clips), "overlays": len(tl.overlays),
            "subtitles": len(tl.subtitles), "sounds": len(tl.sounds), "warnings": tl.warnings + registry.WARNINGS}


def cmd_check(args):
    tl = _load(args)
    data = _summary(tl)
    lines = [f"OK — {tl.title}: {tl.duration:g}s at {tl.fps} fps, {tl.w}×{tl.h}, {len(tl.clips)} clip(s), {len(tl.overlays)} overlay(s), {len(tl.sounds)} sound(s)"]
    lines += [f"warning: {w}" for w in data["warnings"]]
    out(args, data, "\n".join(lines))


def cmd_info(args):
    from .timeline import fmt_time

    tl = _load(args)
    rows = []
    for c in tl.clips:
        src = c.path.name if c.path else (str(c.spec.get(c.kind))[:40] if c.kind in ("title", "color", "generator") else "")
        tr = f"  ⇄ {c.trans} {c.trans_dur:g}s" if c.trans_dur > 0 else ""
        cut = f"  [{fmt_time(c.src_from)} → {fmt_time(c.src_from + c.dur * c.speed)}{' ×' + format(c.speed, 'g') if c.speed != 1 else ''}]" if c.kind in ("file", "scene") else ""
        rows.append((c.start, c.end, "clip", f"{c.name}: {c.kind} {src}{cut}{tr}"))
    for o in tl.overlays:
        what = str(o.spec.get("text") or (o.path.name if o.path else o.kind))[:50]
        rows.append((o.t0, o.t1, "overlay", f"{o.kind}: {what}"))
    for s in tl.subtitles:
        rows.append((s["t0"], s["t1"], "subtitle", s["text"][:60]))
    for s in tl.sounds:
        what = s.path.name if s.path else str(s.spec.get(s.kind))
        rows.append((s.t, s.t, "sound", f"{s.kind}: {what}{' ' + format(s.gain, '+g') + ' dB' if s.gain else ''}{' (loop)' if s.loop else ''}"))
    rows.sort(key=lambda r: (r[0], r[2]))
    lines = [f"{tl.title} — {fmt_time(tl.duration)} ({tl.duration:g}s), {tl.fps} fps, {tl.w}×{tl.h}"]
    for a, b, kind, what in rows:
        span = f"{fmt_time(a)} → {fmt_time(b)}" if b > a else fmt_time(a)
        lines.append(f"  {span:<22} {kind:<9} {what}")
    lines += [f"warning: {w}" for w in tl.warnings]
    out(args, {**_summary(tl), "timeline": [{"t": round(a, 3), "end": round(b, 3), "kind": k, "what": w} for a, b, k, w in rows]}, "\n".join(lines))


def _write_srt(tl, path: Path, t0: float, t1: float) -> bool:
    lines = []
    n = 0
    for s in tl.subtitles:
        if s["t1"] <= t0 or s["t0"] >= t1:
            continue
        n += 1

        def stamp(t: float) -> str:
            t = max(0.0, t - t0)
            return f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}:{int(t % 60):02d},{int(round(t % 1 * 1000)) % 1000:03d}"

        lines += [str(n), f"{stamp(s['t0'])} --> {stamp(min(s['t1'], t1))}", s["text"], ""]
    if n:
        path.write_text("\n".join(lines), "utf-8")
    return bool(n)


def cmd_render(args):
    from . import render as R
    from .media import MediaError
    from .timeline import VideoError

    tl = _load(args)
    t_start = time.time()
    t0, t1 = _range(args, tl)
    project = registry.project_dir()
    out_dir = Path(args.out) if args.out else project / "exports"
    name = _name(args)
    if t0 > 0 or t1 < tl.duration - 1e-6:
        name += f"-{t0:g}-{t1:g}s"
    fps = int(args.fps) if args.fps else (15 if args.draft else tl.fps)
    scale = 0.5 if args.draft else 1.0
    files: dict[str, str] = {}
    audio_info: dict = {"clips": 0, "sounds": 0, "peak_db": None}
    progress = None if args.json else (lambda i, n: R.log(f"  frame {i}/{n}"))
    try:
        with _Quiet(), tempfile.TemporaryDirectory() as tmp:
            tl.prepare(None if args.json else R.log)
            wav = None
            if not args.no_audio:
                buf, audio_info = R.build_audio(tl, t0, t1)
                if buf is not None:
                    wav = Path(tmp) / "audio.wav"
                    R.write_wav(wav, buf)
            mp4 = out_dir / f"{name}.mp4"
            thumbs_at = R.key_times(tl, t0, t1, 12) if args.preview else []
            info = R.render_video(tl, mp4, t0, t1, fps, scale, wav, crf=26 if args.draft else 18, progress=progress, thumbs_at=thumbs_at)
            files["mp4"] = str(mp4)
            if _write_srt(tl, out_dir / f"{name}.srt", t0, t1):
                files["srt"] = str(out_dir / f"{name}.srt")
            if args.gif:
                R.convert(mp4, out_dir / f"{name}.gif", "gif", fps, info["width"])
                files["gif"] = str(out_dir / f"{name}.gif")
            if args.webm:
                R.convert(mp4, out_dir / f"{name}.webm", "webm", fps, info["width"])
                files["webm"] = str(out_dir / f"{name}.webm")
            if args.preview and info["thumbs"]:
                png = project / ".studio" / "previews" / f"{name}.png"
                R.contact_sheet(tl, info["thumbs"], png)
                files["preview"] = str(png)
    except (VideoError, MediaError, R.RenderError) as e:
        fail(args, f"render failed: {e}")
    except Exception as e:  # noqa: BLE001
        fail(args, f"render failed: {type(e).__name__}: {e}")
    warnings = tl.warnings + registry.WARNINGS
    if not audio_info["clips"] and not audio_info["sounds"] and not args.no_audio:
        warnings.append("the video has no sound — add music or effects under audio: (e.g. { sfx: swoosh, t: 1 } or { file: exports/song.mp3 })")
    report = {"ok": True, "files": files, "title": tl.title, "seconds": round(t1 - t0, 3), "frames": info["frames"], "fps": fps, "size": [info["width"], info["height"]],
              "clips": len(tl.clips), "audio": audio_info, "draft": bool(args.draft), "warnings": warnings, "render_seconds": round(time.time() - t_start, 1)}
    lines = [f"Rendered {tl.title}: {report['seconds']}s, {info['frames']} frames at {fps} fps, {info['width']}×{info['height']} ({report['render_seconds']}s)"]
    lines += [f"  {k}: {v}" for k, v in files.items()]
    lines.append(f"  sound: {audio_info['clips']} clip(s) with sound, {audio_info['sounds']} extra sound(s)" + (f", peak {audio_info['peak_db']} dB" if audio_info["peak_db"] is not None else ""))
    lines += [f"warning: {w}" for w in warnings]
    if files.get("preview"):
        lines.append(f"Look at the contact sheet: read {files['preview']}")
    out(args, report, "\n".join(lines))


def cmd_sheet(args):
    from . import render as R
    from .media import MediaError
    from .timeline import VideoError

    tl = _load(args)
    t0, t1 = _range(args, tl)
    times = [_t(args, v.strip(), "--at") for v in args.at.split(",")] if args.at else R.key_times(tl, t0, t1, int(args.count))
    times = [min(max(0.0, t), tl.duration) for t in times]
    png = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews" / f"{_name(args)}-sheet.png"
    try:
        with _Quiet():
            tl.prepare(None if args.json else R.log)
            R.contact_sheet(tl, R.stills(tl, times, 0.5 if max(tl.w, tl.h) > 900 else 1.0), png, cols=int(args.cols))
    except (VideoError, MediaError, R.RenderError) as e:
        fail(args, str(e))
    except Exception as e:  # noqa: BLE001
        fail(args, f"{type(e).__name__}: {e}")
    out(args, {"ok": True, "files": {"preview": str(png)}, "times": [round(t, 3) for t in times], "warnings": tl.warnings},
        f"Contact sheet with {len(times)} frames: {png}\nLook at it: read {png}" + "".join(f"\nwarning: {w}" for w in tl.warnings))


def cmd_still(args):
    from . import render as R
    from .media import MediaError
    from .timeline import VideoError

    tl = _load(args)
    out_dir = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews"
    out_dir.mkdir(parents=True, exist_ok=True)
    times = [min(max(0.0, _t(args, v, "time")), tl.duration) for v in args.times]
    files = []
    try:
        with _Quiet():
            tl.prepare(None)
            for t, im in R.stills(tl, times, float(args.scale)):
                p = out_dir / f"{_name(args)}-{t:07.3f}.png"
                im.save(str(p))
                files.append(str(p))
    except (VideoError, MediaError, R.RenderError) as e:
        fail(args, str(e))
    out(args, {"ok": True, "files": files}, "\n".join(files))


def cmd_probe(args):
    from .media import MediaError, probe
    from .timeline import fmt_time

    try:
        info = probe(args.file)
    except MediaError as e:
        fail(args, str(e))
    v, a = info["video"], info["audio"]
    still = bool(v) and info["duration"] <= 0.05 and not a
    lines = [f"{Path(args.file).name}: " + ("picture" if still else f"{fmt_time(info['duration'])} ({info['duration']:g}s)") + f", {info['bytes'] / 1048576:.2f} MB"]
    if v:
        lines.append(f"  picture: {v['width']}×{v['height']}" + ("" if still else f", {v['fps']:g} fps") + f", {v['codec']}")
    lines.append(f"  sound: {a['channels']} channel(s), {a['rate']} Hz, {a['codec']}" if a else "  sound: none")
    out(args, {"ok": True, **info, "still": still}, "\n".join(lines))


def cmd_frames(args):
    """A contact sheet of any video file — to see what a piece of footage contains."""
    import studio_gfx as gfx

    from .media import MediaError, VideoReader, probe
    from .timeline import fmt_time

    try:
        info = probe(args.file)
    except MediaError as e:
        fail(args, str(e))
    v = info["video"]
    if not v:
        fail(args, f"{Path(args.file).name} has no picture")
    dur = max(info["duration"], 0.04)
    if args.at:
        times = [min(max(0.0, _t(args, x.strip(), "--at")), dur) for x in args.at.split(",")]
    else:
        n = max(1, int(args.count))
        times = [dur * (i + 0.5) / n for i in range(n)]
    w = 480
    h = max(2, int(round(w * v["height"] / max(1, v["width"]) / 2)) * 2)
    fps = v["fps"] or 25
    reader = VideoReader(Path(args.file), (w, h), fps, 0.0, 1.0, "stretch")
    cells = []
    try:
        for t in sorted(times):
            cells.append((fmt_time(t), reader.frame(t).copy()))
    except MediaError as e:
        fail(args, str(e))
    finally:
        reader.close()
    png = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews" / f"{Path(args.file).stem}-frames.png"
    gfx.contact_sheet(cells, png, f"{Path(args.file).name} — {fmt_time(dur)}, {v['width']}×{v['height']}, {fps:g} fps", cols=int(args.cols), cell_w=420)
    out(args, {"ok": True, "files": {"preview": str(png)}, "times": [round(t, 3) for t in sorted(times)], "seconds": dur},
        f"Contact sheet with {len(cells)} frames of {Path(args.file).name}: {png}\nLook at it: read {png}")


TABLES = {
    "transitions": ("transition", "clips: [ …, { file: b.mp4, transition: <name> } ]   or   transition: { type: <name>, dur: 0.8, <param>: … }"),
    "generators": ("generator", "clips: [ { generator: <name>, dur: 4, <param>: … } ]   — a clip that is computed"),
}


def cmd_list(args):
    import studio_gfx as gfx

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    what = (args.what or "all").lower()
    words = [w.lower() for w in (args.words or [])]
    if what not in TABLES and what not in ("all", "fonts", "kinds"):
        words.insert(0, what)
        what = "all"
    data: dict = {}
    lines: list[str] = []
    for key, (kind, usage) in TABLES.items():
        if what not in ("all", key):
            continue
        entries = [e for e in registry.TABLES[kind].values() if not words or any(w in f"{e.name} {e.doc} {e.source}".lower() for w in words)]
        if not entries and words:
            continue
        data[key] = [{"name": e.name, "doc": e.doc.split("\n")[0], "params": e.params, "source": e.source} for e in entries]
        lines.append(f"{key} — {usage}")
        for e in entries:
            params = ", ".join(f"{k}={json.dumps(v)}" for k, v in e.params.items())
            src = "" if e.source == "built-in" else f"  [{e.source}]"
            lines.append(f"  {e.name:<12} {e.doc.splitlines()[0] if e.doc else ''}{('  params: ' + params) if params else ''}{src}")
        lines.append("")
    if what in ("all", "kinds") and not words:
        lines += ["clip kinds — file (video), image, title, color, scene (*.stick.yaml), picture (*.image.yaml), generator",
                  "overlay kinds — text, image, picture, rect      sound kinds — file, song (*.song.yaml), sfx (studio-daw sfx list)", ""]
    if what in ("all", "fonts") and not words:
        data["fonts"] = list(gfx.FONTS)
        lines += [f"fonts — font: {', '.join(gfx.FONTS)}  (or a .ttf / .otf file of the project)", ""]
    for err in registry.PLUGIN_ERRORS:
        lines.append(f"plugin error: {err['file']}: {err['error']}")
    data["pluginErrors"] = registry.PLUGIN_ERRORS
    if not lines:
        lines = [f"nothing matches: {' '.join(words)}"]
    out(args, data, "\n".join(lines).rstrip())


def cmd_plugin(args):
    if args.action != "new":
        fail(args, "usage: studio-video plugin new <name> [--kind transition|generator]")
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    if not name.isidentifier():
        fail(args, "the name must be a word (letters, digits, _)")
    path = registry.project_dir() / "plugins" / "video" / f"{name}.py"
    if path.exists():
        fail(args, f"{path} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(PLUGINS[args.kind].replace("{{NAME}}", name), "utf-8")
    use = {"transition": f"transition: {{ type: {name}, dur: 0.8 }}", "generator": f"{{ generator: {name}, dur: 4 }}"}[args.kind]
    out(args, {"ok": True, "file": str(path)}, f"Created {path}. Use it in a video: {use}   (check it: studio-video list {name})")


def cmd_docs(args):
    print((Path(__file__).resolve().parents[1] / "README.md").read_text("utf-8"))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="studio-video", add_help=False)
    p.add_argument("-h", "--help", action="store_true")
    p.add_argument("--version", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    def add(name, fn):
        sp = sub.add_parser(name, add_help=True)
        sp.add_argument("--json", action="store_true")
        sp.set_defaults(fn=fn)
        return sp

    def rng(sp):
        sp.add_argument("--from", dest="from_t")
        sp.add_argument("--to", dest="to_t")

    sp = add("new", cmd_new)
    sp.add_argument("file")
    sp.add_argument("--template", default="trailer")
    sp.add_argument("--force", action="store_true")
    for name, fn in (("check", cmd_check), ("info", cmd_info)):
        add(name, fn).add_argument("video")
    sp = add("render", cmd_render)
    sp.add_argument("video")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--preview", action="store_true")
    sp.add_argument("--draft", action="store_true", help="half size, 15 fps — fast")
    sp.add_argument("--gif", action="store_true")
    sp.add_argument("--webm", action="store_true")
    sp.add_argument("--no-audio", action="store_true")
    sp.add_argument("--fps")
    rng(sp)
    sp = add("sheet", cmd_sheet)
    sp.add_argument("video")
    sp.add_argument("--count", default="12")
    sp.add_argument("--cols", default="4")
    sp.add_argument("--at")
    sp.add_argument("--out")
    sp.add_argument("--name")
    rng(sp)
    sp = add("still", cmd_still)
    sp.add_argument("video")
    sp.add_argument("times", nargs="+")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--scale", default="1")
    add("probe", cmd_probe).add_argument("file")
    sp = add("frames", cmd_frames)
    sp.add_argument("file")
    sp.add_argument("--count", default="12")
    sp.add_argument("--cols", default="4")
    sp.add_argument("--at")
    sp.add_argument("--out")
    sp = add("list", cmd_list)
    sp.add_argument("what", nargs="?")
    sp.add_argument("words", nargs="*")
    sp = add("plugin", cmd_plugin)
    sp.add_argument("action")
    sp.add_argument("name")
    sp.add_argument("--kind", default="transition", choices=list(PLUGINS))
    add("docs", cmd_docs)
    args = p.parse_args(argv)
    if args.version:
        print(f"studio-video {__version__}")
        return
    if args.help or not args.cmd:
        print(HELP)
        return
    try:
        args.fn(args)
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as e:  # noqa: BLE001  (a clean error instead of a traceback)
        fail(args, f"{type(e).__name__}: {e}")
