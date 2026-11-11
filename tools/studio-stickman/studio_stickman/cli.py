"""studio-stickman command line."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from . import __version__, registry
from .templates import PLUGINS, SCENES

HELP = """studio-stickman — stick figure animation from text (scenes are YAML files, see: studio-stickman docs)

  studio-stickman new <file.stick.yaml> [--template fight|talk|dance|blank]
  studio-stickman check <scene>                 validate, list warnings (fast)
  studio-stickman render <scene> [--preview] [--draft] [--from T --to T] [--gif] [--webm] [--frames] [--no-audio] [--out DIR] [--name N]
                                                video → exports/<name>.mp4 (+ contact sheet PNG to look at with --preview)
  studio-stickman sheet <scene> [--count 12] [--from T --to T] [--at T,T,…]   contact sheet only (fast — look before a full render)
  studio-stickman still <scene> <t…> [--out DIR]   single frames as PNG (t: seconds or bar:beat)
  studio-stickman sprite <scene> --figure NAME [--from T --to T] [--frames 8] [--size 128]   sprite sheet PNG + JSON for games
  studio-stickman info <scene>                  who does what when
  studio-stickman list [poses|actions|fx|props|backdrops|sounds|particles|hats|expressions] [words]
  studio-stickman poses [words] [--preview]     pose catalogue (PNG with every pose and its name)
  studio-stickman plugin new <name> [--kind action|pose|prop|fx|backdrop|sound]   extend the tool (plugins/stickman/<name>.py)
  studio-stickman docs                          full format reference
Times: seconds (2.5) or, with scene.bpm, bars and beats ("3:1" = bar 3, beat 1). Add --json for machine readable output."""


def out(args, data, text: str) -> None:
    print(json.dumps(data, default=str) if args.json else text)


def fail(args, msg: str, code: int = 1) -> None:
    if getattr(args, "json", False):
        print(json.dumps({"ok": False, "error": msg}), file=sys.__stdout__, flush=True)
    else:
        print(f"studio-stickman: {msg}", file=sys.stderr)
    sys.exit(code)


class _Quiet:
    """plugin print() output goes to stderr so JSON on stdout stays clean"""

    def __enter__(self):
        self.prev = sys.stdout
        sys.stdout = sys.stderr

    def __exit__(self, *exc):
        sys.stdout = self.prev


def _load(args):
    from .scene import SceneError, load_scene

    try:
        with _Quiet():
            return load_scene(args.scene)
    except SceneError as e:
        fail(args, str(e))


def _name(args) -> str:
    return getattr(args, "name", None) or Path(args.scene).name.split(".")[0] or "scene"


def _time(scene, v, where: str) -> float:
    from .scene import SceneError

    try:
        return scene.clock.at(v if not _is_num(v) else float(v), 0.0, where)
    except SceneError as e:
        raise SystemExit(f"studio-stickman: {e}") from None


def _is_num(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def _range(args, scene) -> tuple[float, float]:
    t0 = _time(scene, args.from_t, "--from") if getattr(args, "from_t", None) is not None else 0.0
    t1 = _time(scene, args.to_t, "--to") if getattr(args, "to_t", None) is not None else scene.duration
    t0 = max(0.0, min(t0, scene.duration))
    t1 = max(t0 + 1.0 / scene.fps, min(t1, scene.duration))
    return t0, t1


def cmd_new(args):
    path = Path(args.file)
    if not path.name.endswith((".stick.yaml", ".stick.yml")):
        path = path.with_name(path.name.split(".")[0] + ".stick.yaml")
    if path.exists() and not args.force:
        fail(args, f"{path} exists (use --force to overwrite)")
    tpl = SCENES.get(args.template)
    if not tpl:
        fail(args, f"unknown template {args.template} ({', '.join(SCENES)})")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(tpl.replace("{{TITLE}}", path.name.split(".")[0].replace("-", " ").replace("_", " ").title()), "utf-8")
    out(args, {"ok": True, "file": str(path)}, f"Created {path} — look at it first: studio-stickman sheet {path}   then: studio-stickman render {path} --preview")


def _summary(scene) -> dict:
    return {
        "ok": True,
        "title": scene.title,
        "seconds": scene.duration,
        "fps": scene.fps,
        "size": [scene.w, scene.h],
        "bpm": scene.clock.bpm,
        "figures": {f.name: {"keys": len(f.raw), "x": [round(min(k.x for k in f.keys)), round(max(k.x for k in f.keys))]} for f in scene.figures.values()},
        "props": len(scene.props),
        "events": len(scene.events),
        "warnings": scene.warnings + registry.WARNINGS,
    }


def cmd_check(args):
    scene = _load(args)
    data = _summary(scene)
    lines = [f"OK — {scene.title}: {scene.duration:g}s at {scene.fps} fps, {len(scene.figures)} figure(s), {len(scene.events)} event(s)"]
    lines += [f"warning: {w}" for w in data["warnings"]]
    out(args, data, "\n".join(lines))


def cmd_info(args):
    scene = _load(args)
    lines = [f"{scene.title} — {scene.duration:g}s, {scene.fps} fps, {scene.w}×{scene.h}" + (f", {scene.clock.bpm:g} bpm" if scene.clock.bpm else "")]
    rows = []
    for f in scene.figures.values():
        k = f.raw[0]
        rows.append((0.0, 0.0, f.name, f"starts: pose {k.get('pose')} at x {k['x']:g}, facing {'right' if k.get('face', 1) > 0 else 'left'}"))
    for it in scene.script:
        rows.append((it["t"], it["end"], it["who"], it["what"]))
    for ev in scene.events:
        v = ev["value"]
        if ev["_where"].startswith("timeline.") and ev["kind"] not in ("say", "text", "title", "caption"):
            continue                      # sounds and effects an action added by itself
        rows.append((ev["t"], ev["t"], "·" if ev["kind"] != "say" or not ev.get("who") else str(ev["who"]),
                     f'{ev["kind"]}: {ev.get("word") or (v if not isinstance(v, (dict, list)) else json.dumps(v))}'))
    for c in scene.camera:
        rows.append((c.t, c.t, "camera", f"zoom {c.zoom:g}" + (f", follows {c.follow}" if c.follow else "") + (f", at {c.x:g}/{c.y:g}" if c.x is not None and c.y is not None else "")))
    rows.sort(key=lambda r: r[0])
    for t, end, who, what in rows:
        span = scene.clock.label(t) + (f" → {end:.2f}s" if end - t > 0.01 else "")
        lines.append(f"  {span:<30} {who:<10} {what}")
    for w in scene.warnings:
        lines.append(f"warning: {w}")
    out(args, {**_summary(scene), "timeline": [{"t": round(t, 3), "end": round(e, 3), "who": w, "what": x} for t, e, w, x in rows]}, "\n".join(lines))


def cmd_render(args):
    from . import render as R
    from .scene import SceneError
    from .sfx import AudioError, build_audio, write_wav

    scene = _load(args)
    t_start = time.time()
    try:
        t0, t1 = _range(args, scene)
    except SystemExit as e:
        fail(args, str(e).replace("studio-stickman: ", ""))
    project = registry.project_dir()
    out_dir = Path(args.out) if args.out else project / "exports"
    name = _name(args)
    partial = t0 > 0 or t1 < scene.duration - 1e-6
    if partial:
        name += f"-{t0:g}-{t1:g}s"
    fps = int(args.fps) if args.fps else (15 if args.draft else scene.fps)
    scale = 0.5 if args.draft else 1.0
    ss = 1 if args.draft else 2
    files: dict[str, str] = {}
    warnings = list(scene.warnings) + list(registry.WARNINGS)
    audio_info = {"sfx": 0, "music": None, "peak_db": None}
    with _Quiet(), tempfile.TemporaryDirectory() as tmp:
        wav = None
        if not args.no_audio:
            try:
                buf, audio_info = build_audio(scene, t0, t1)
                if buf is not None:
                    wav = Path(tmp) / "audio.wav"
                    write_wav(wav, buf)
            except AudioError as e:
                warnings.append(f"no sound: {e}")
            except Exception as e:  # noqa: BLE001
                warnings.append(f"no sound: {type(e).__name__}: {e}")
        mp4 = out_dir / f"{name}.mp4"
        try:
            info = R.render_video(scene, mp4, t0=t0, t1=t1, fps=fps, scale=scale, ss=ss, jobs=int(args.jobs) if args.jobs else R.default_jobs(), audio_wav=wav,
                                  crf=26 if args.draft else 18,
                                  progress=None if args.json else (lambda i, n: R.log(f"  frame {i}/{n}")))
            files["mp4"] = str(mp4)
            if args.gif:
                R.convert(mp4, out_dir / f"{name}.gif", "gif", fps, info["width"])
                files["gif"] = str(out_dir / f"{name}.gif")
            if args.webm:
                R.convert(mp4, out_dir / f"{name}.webm", "webm", fps, info["width"])
                files["webm"] = str(out_dir / f"{name}.webm")
            if args.frames:
                fdir = out_dir / f"{name}-frames"
                fdir.mkdir(parents=True, exist_ok=True)
                r = R.Renderer(scene, ss=ss, scale=scale)
                for i, t in enumerate(R.frame_times(t0, t1, fps)):
                    r.frame(t).save(str(fdir / f"{i:05d}.png"))
                files["frames"] = str(fdir)
            if args.preview:
                png = project / ".studio" / "previews" / f"{name}.png"
                R.contact_sheet(scene, R.key_moments(scene, t0, t1, 12), png)
                files["preview"] = str(png)
        except (R.RenderError, SceneError) as e:
            fail(args, f"render failed: {e}")
        except Exception as e:  # noqa: BLE001
            fail(args, f"render failed: {type(e).__name__}: {e}")
    report = {
        "ok": True, "files": files, "seconds": round(t1 - t0, 3), "frames": info["frames"], "fps": fps, "size": [info["width"], info["height"]],
        "figures": list(scene.figures), "events": len(scene.events), "audio": audio_info, "draft": bool(args.draft),
        "warnings": warnings, "render_seconds": round(time.time() - t_start, 1),
    }
    lines = [f"Rendered {scene.title}: {report['seconds']}s, {info['frames']} frames at {fps} fps, {info['width']}×{info['height']} ({report['render_seconds']}s)"]
    lines += [f"  {k}: {v}" for k, v in files.items()]
    lines.append(f"  sound: {audio_info['sfx']} effect(s)" + (f", music {audio_info['music']['file']}" if audio_info.get("music") else "") if (audio_info["sfx"] or audio_info.get("music")) else "  sound: none")
    lines += [f"warning: {w}" for w in warnings]
    if args.preview:
        lines.append(f"Look at the contact sheet: read {files['preview']}")
    out(args, report, "\n".join(lines))


def cmd_sheet(args):
    from . import render as R

    scene = _load(args)
    try:
        t0, t1 = _range(args, scene)
        times = [_time(scene, v.strip(), "--at") for v in args.at.split(",")] if args.at else R.key_moments(scene, t0, t1, int(args.count))
    except SystemExit as e:
        fail(args, str(e).replace("studio-stickman: ", ""))
    times = [min(max(0.0, t), scene.duration) for t in times]
    png = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews" / f"{_name(args)}-sheet.png"
    try:
        with _Quiet():
            R.contact_sheet(scene, times, png, cols=int(args.cols))
    except Exception as e:  # noqa: BLE001
        fail(args, f"{type(e).__name__}: {e}")
    out(args, {"ok": True, "files": {"preview": str(png)}, "times": [round(t, 3) for t in times], "warnings": scene.warnings},
        f"Contact sheet with {len(times)} frames: {png}\nLook at it: read {png}" + "".join(f"\nwarning: {w}" for w in scene.warnings))


def cmd_still(args):
    from . import render as R

    scene = _load(args)
    out_dir = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews"
    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    try:
        with _Quiet():
            r = R.Renderer(scene, ss=2, scale=float(args.scale))
            for v in args.times:
                t = min(max(0.0, _time(scene, v, "time")), scene.duration)
                p = out_dir / f"{_name(args)}-{t:07.3f}.png"
                r.frame(t).save(str(p))
                files.append(str(p))
    except SystemExit as e:
        fail(args, str(e).replace("studio-stickman: ", ""))
    except Exception as e:  # noqa: BLE001
        fail(args, f"{type(e).__name__}: {e}")
    out(args, {"ok": True, "files": files}, "\n".join(files))


def cmd_sprite(args):
    from . import render as R

    scene = _load(args)
    if args.figure not in scene.figures:
        fail(args, f'unknown figure "{args.figure}" (figures: {", ".join(scene.figures)})')
    try:
        t0, t1 = _range(args, scene)
    except SystemExit as e:
        fail(args, str(e).replace("studio-stickman: ", ""))
    out_dir = Path(args.out) if args.out else registry.project_dir() / "exports"
    png = out_dir / f"{_name(args)}-{args.figure}-sprite.png"
    try:
        with _Quiet():
            meta = R.sprite_sheet(scene, args.figure, t0, t1, int(args.frames), int(args.size), png, int(args.cols) if args.cols else None)
    except Exception as e:  # noqa: BLE001
        fail(args, f"{type(e).__name__}: {e}")
    out(args, {"ok": True, "files": {"png": str(png), "json": str(png.with_suffix(".json"))}, **meta},
        f"Sprite sheet: {png} ({meta['columns']}×{meta['rows']} cells of {meta['cell']} px, {len(meta['frames'])} frames, {meta['fps']} fps)\nAtlas: {png.with_suffix('.json')}")


TABLES = {
    "poses": ("pose", "pose: <name>  (single angles can be changed next to it: { pose: guard, RS: 60 })"),
    "actions": ("action", "do: <name>  with its parameters"),
    "fx": ("motion", "fx: <name>  or  fx: { use: <name>, <param>: … }  — continuous movement while a pose is held"),
    "props": ("prop", "props: { name: { kind: <name>, x: …, <param>: … } }   (hand props: held_by: figure, hand: R|L)"),
    "backdrops": ("backdrop", "scene: { background: <name> }  or  background: { use: <name>, <param>: … }"),
    "sounds": ("sound", "events: [ { t: 2, sfx: <name> } ]  — also audio files (assets/x.wav) and pack items (pack/item)"),
    "particles": ("particle", "events: [ { t: 2, burst: <name>, x: 600, y: 400, n: 20 } ]"),
}


def cmd_list(args):
    from .draw import HATS
    from .scene import EVENT_DEFAULTS, EXPRESSIONS, LOOKS
    from .skeleton import EASES

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    what = (args.what or "all").lower()
    words = [w.lower() for w in (args.words or [])]
    if what not in TABLES and what not in ("all", "hats", "expressions", "eases", "events"):
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
        data[key] = [{"name": e.name, "doc": e.doc.split("\n")[0], "params": e.params, "source": e.source, **({"angles": e.data} if kind == "pose" else {})} for e in entries]
        lines.append(f"{key} — {usage}")
        for e in entries:
            params = ", ".join(f"{k}={json.dumps(v)}" for k, v in e.params.items())
            src = "" if e.source == "built-in" else f"  [{e.source}]"
            lines.append(f"  {e.name:<14} {e.doc.splitlines()[0] if e.doc else ''}{('  params: ' + params) if params else ''}{src}")
        lines.append("")
    if what in ("all", "hats") and not words:
        data["hats"] = HATS
        lines += [f"hats — figures: {{ hero: {{ hat: <name> }} }}: {', '.join(HATS)}  (more figure options: glasses, tie, badge, belt, scarf, cape, hair, skin, label)", ""]
    if what in ("all", "expressions") and not words:
        data["expressions"], data["looks"], data["eases"] = EXPRESSIONS, LOOKS, list(EASES)
        lines += [f"expressions — expr: {', '.join(EXPRESSIONS)}   look: {', '.join(LOOKS)}   ease: {', '.join(EASES)}", ""]
    if what in ("all", "events") and not words:
        data["events"] = {k: list(v) for k, v in EVENT_DEFAULTS.items()}
        lines += ["events — " + "; ".join(f"{k} ({', '.join(v)})" for k, v in EVENT_DEFAULTS.items()), ""]
    for err in registry.PLUGIN_ERRORS:
        lines.append(f"plugin error: {err['file']}: {err['error']}")
    data["pluginErrors"] = registry.PLUGIN_ERRORS
    if not lines:
        lines = [f"nothing matches: {' '.join(words)}"]
    out(args, data, "\n".join(lines).rstrip())


def cmd_poses(args):
    from . import render as R

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    words = [w.lower() for w in (args.words or [])]
    # several words = several poses: any of them may match (a name, or a word of the description)
    names = [e.name for e in registry.POSES.values() if not words or any(w in f"{e.name} {e.doc}".lower() for w in words)]
    if not names:
        fail(args, f"no pose matches: {' '.join(words)}{registry.suggest(words[0], registry.POSES)} (all poses: studio-stickman poses)")
    files = {}
    if args.preview:
        png = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews" / "poses.png"
        try:
            with _Quiet():
                R.pose_sheet(names, png)
        except Exception as e:  # noqa: BLE001
            fail(args, f"{type(e).__name__}: {e}")
        files["preview"] = str(png)
    lines = [f"  {e.name:<14} {e.doc}" + ("" if e.source == "built-in" else f"  [{e.source}]") for e in registry.POSES.values() if e.name in names]
    if args.preview:
        lines.append(f"Look at the catalogue: read {files['preview']}")
    else:
        lines.append("Add --preview for a picture of them.")
    out(args, {"ok": True, "poses": [{"name": n, "doc": registry.POSES[n].doc, "angles": registry.POSES[n].data} for n in names], "files": files}, "\n".join(lines))


def cmd_plugin(args):
    if args.action != "new":
        fail(args, "usage: studio-stickman plugin new <name> [--kind action|pose|prop|fx|backdrop|sound]")
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    if not name.isidentifier():
        fail(args, "the name must be a word (letters, digits, _)")
    path = registry.project_dir() / "plugins" / "stickman" / f"{name}.py"
    if path.exists():
        fail(args, f"{path} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(PLUGINS[args.kind].replace("{{NAME}}", name), "utf-8")
    use = {"action": f"do: {name}", "pose": f"pose: {name}", "prop": f"props: {{ x: {{ kind: {name} }} }}", "fx": f"fx: {name}", "backdrop": f"background: {name}",
           "sound": f"sfx: {name}"}[args.kind]
    out(args, {"ok": True, "file": str(path)}, f"Created {path}. Use it in a scene: {use}   (check it: studio-stickman list {name})")


def cmd_docs(args):
    print((Path(__file__).resolve().parents[1] / "README.md").read_text("utf-8"))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="studio-stickman", add_help=False)
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
    sp.add_argument("--template", default="fight")
    sp.add_argument("--force", action="store_true")
    for name, fn in (("check", cmd_check), ("info", cmd_info)):
        add(name, fn).add_argument("scene")
    sp = add("render", cmd_render)
    sp.add_argument("scene")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--preview", action="store_true")
    sp.add_argument("--draft", action="store_true", help="half size, 15 fps — fast")
    sp.add_argument("--gif", action="store_true")
    sp.add_argument("--webm", action="store_true")
    sp.add_argument("--frames", action="store_true", help="also a PNG sequence")
    sp.add_argument("--no-audio", action="store_true")
    sp.add_argument("--fps")
    sp.add_argument("--jobs")
    rng(sp)
    sp = add("sheet", cmd_sheet)
    sp.add_argument("scene")
    sp.add_argument("--count", default="12")
    sp.add_argument("--cols", default="4")
    sp.add_argument("--at")
    sp.add_argument("--out")
    sp.add_argument("--name")
    rng(sp)
    sp = add("still", cmd_still)
    sp.add_argument("scene")
    sp.add_argument("times", nargs="+")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--scale", default="1")
    sp = add("sprite", cmd_sprite)
    sp.add_argument("scene")
    sp.add_argument("--figure", required=True)
    sp.add_argument("--frames", default="8")
    sp.add_argument("--size", default="128")
    sp.add_argument("--cols")
    sp.add_argument("--out")
    sp.add_argument("--name")
    rng(sp)
    sp = add("list", cmd_list)
    sp.add_argument("what", nargs="?")
    sp.add_argument("words", nargs="*")
    sp = add("poses", cmd_poses)
    sp.add_argument("words", nargs="*")
    sp.add_argument("--preview", action="store_true")
    sp.add_argument("--out")
    sp = add("plugin", cmd_plugin)
    sp.add_argument("action")
    sp.add_argument("name")
    sp.add_argument("--kind", default="action", choices=list(PLUGINS))
    add("docs", cmd_docs)
    args = p.parse_args(argv)
    if args.version:
        print(f"studio-stickman {__version__}")
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
