"""studio-3d command line."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from . import __version__, registry
from .templates import PLUGIN_MODIFIER, PLUGIN_SHAPE, SCENE_TEMPLATES

HELP = """studio-3d — build 3D models from text (scenes are YAML files, see: studio-3d docs)

  studio-3d new <file.scene.yaml> [--template basic|props|terrain|organic|textured]
  studio-3d check <scene>                       validate fast (names, params, materials, textures)
  studio-3d build <scene> [--preview] [--out exports/x.glb] [--format glb,obj,stl,ply]
                                                → .glb + stats (+ 4-view PNG to look at); stl for 3D printing
  studio-3d preview <scene|model.glb> [--out x.png] [--size 512]
  studio-3d info <model.glb|.gltf|.obj|.stl>   triangles, size, materials, textures of any model
  studio-3d shapes [words]                      built-in, plugin and pack shapes with parameters
  studio-3d materials [words]                   material presets, pack materials, material options
  studio-3d textures [words]                    procedural textures, UV projections, texture maps, pictures of the project
  studio-3d plugin new <name> [--kind shape|modifier]   extend the tool (plugins/3d/<name>.py)
  studio-3d docs                                full format reference
<scene> may be "-" to read the YAML from stdin (with --path for its name/location).
Editor engine (used by the website's 3D editor): studio-3d model <scene> | catalog | texture (JSON on stdin)
Add --json for machine readable output."""

TOOL_DIR = Path(__file__).resolve().parents[1]
FORMATS = ("glb", "obj", "stl", "ply")


class _Quiet:
    """Engine output is one JSON line on stdout: whatever plugins print goes to stderr meanwhile."""

    def __enter__(self):
        self.out = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *exc):
        sys.stdout = self.out
        return False


def out(args, data, text: str) -> None:
    print(json.dumps(data, default=str) if args.json else text)


def fail(args, msg: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps({"ok": False, "error": msg}), file=sys.__stdout__, flush=True)
    else:
        print(f"studio-3d: {msg}", file=sys.stderr)
    sys.exit(1)


def render_preview(glb: Path, png: Path, size: int, camera=None) -> str | None:
    script = TOOL_DIR / "preview" / "render.js"
    env = dict(os.environ)
    env.setdefault("NODE_PATH", "/usr/local/lib/node_modules")
    try:
        r = subprocess.run(["node", str(script), str(glb), str(png), str(size), json.dumps(camera) if camera else "-"],
                           capture_output=True, text=True, env=env, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"{type(e).__name__}: {e}"
    if r.returncode != 0:
        return (r.stderr or r.stdout).strip()[:500] or "preview failed"
    return None


def _scene_text(args) -> tuple[str, Path]:
    """The scene's YAML and its path; "-" reads stdin (unsaved text from the website editor)."""
    if args.scene == "-":
        return sys.stdin.read(), Path(getattr(args, "path", None) or "scene.scene.yaml")
    path = Path(args.scene)
    try:
        return path.read_text("utf-8"), path
    except FileNotFoundError:
        fail(args, f"file not found: {path}")
    except IsADirectoryError:
        fail(args, f"{path} is a folder — give a .scene.yaml file")
    except UnicodeDecodeError:
        fail(args, f"{path} is not a text file")
    raise SystemExit(1)


def _built(args):
    from .scene import SceneError, build_text, scene_stats

    text, path = _scene_text(args)
    try:
        with _Quiet():
            built = build_text(text, path)
            stats = scene_stats(built.scene)
    except SceneError as e:
        fail(args, str(e))
    except Exception as e:  # noqa: BLE001
        fail(args, f"{type(e).__name__}: {e}")
    return built, stats, path


def _stats_lines(stats: dict) -> list[str]:
    b = stats["bounds"]
    lines = [f"  {stats['triangles']:,} triangles, {stats['meshes']} meshes, {stats['nodes']} placed"]
    if b:
        lines.append(f"  size {b['size'][0]:.2f} x {b['size'][1]:.2f} x {b['size'][2]:.2f} m (x y z), min y {b['min'][1]:.2f}")
    if stats["materials"]:
        tex = f" · {stats['textures']} texture map(s)" if stats.get("textures") else ""
        lines.append(f"  materials: {', '.join(stats['materials'])}{tex}")
    return lines


def cmd_new(args):
    path = Path(args.file)
    if not path.name.endswith((".scene.yaml", ".scene.yml")):
        path = path.with_name(path.name.split(".")[0] + ".scene.yaml")
    if path.exists() and not args.force:
        fail(args, f"{path} exists (use --force)")
    tpl = SCENE_TEMPLATES.get(args.template)
    if not tpl:
        fail(args, f"unknown template {args.template} ({', '.join(SCENE_TEMPLATES)})")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(tpl.replace("{{NAME}}", path.name.split(".")[0].replace("-", " ").title()), "utf-8")
    out(args, {"ok": True, "file": str(path)}, f"Created {path} — build it with: studio-3d build {path} --preview")


def cmd_check(args):
    built, stats, _path = _built(args)
    info, warnings = built.info, built.warnings
    out(args, {"ok": True, **info, "stats": stats, "warnings": warnings},
        "\n".join([f"OK — {info['name']}: {info['objects']} objects, {info['instances']} placed"] + _stats_lines(stats) + [f"warning: {w}" for w in warnings]))


def _source(path: Path, project: Path) -> str | None:
    try:
        return path.resolve().relative_to(project.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def cmd_build(args):
    from .scene import export_glb, flattened

    t0 = time.time()
    formats = [f.strip().lower().lstrip(".") for f in (args.format or "glb").split(",") if f.strip()]
    unknown = [f for f in formats if f not in FORMATS]
    if unknown:
        fail(args, f"unknown format {', '.join(unknown)} — one or more of {', '.join(FORMATS)} (comma separated)")
    built, stats, src = _built(args)
    info, warnings = built.info, built.warnings
    project = registry.project_dir()
    name = args.name or src.name.split(".")[0]
    target = Path(args.out) if args.out else project / "exports"
    if target.suffix.lower() in (".glb", ".obj", ".stl", ".ply"):
        if target.suffix.lower() != ".glb" and target.suffix.lower()[1:] not in formats:
            formats = [target.suffix.lower()[1:]]
        out_dir, name = target.parent, target.stem
    else:
        out_dir = target
    out_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    try:
        with _Quiet():
            data = export_glb(built, _source(src, project))
            glb = out_dir / f"{name}.glb"
            if "glb" in formats:
                glb.write_bytes(data)
                files["glb"] = str(glb)
            if "stl" in formats or "ply" in formats:
                flat = flattened(built.scene)
                for fmt in ("stl", "ply"):
                    if fmt in formats:
                        p = out_dir / f"{name}.{fmt}"
                        p.write_bytes(flat.export(file_type=fmt))
                        files[fmt] = str(p)
            if "obj" in formats:
                folder = out_dir / f"{name}-obj"
                folder.mkdir(parents=True, exist_ok=True)
                built.scene.export(str(folder / f"{name}.obj"))
                files["obj"] = str(folder / f"{name}.obj")
    except Exception as e:  # noqa: BLE001
        fail(args, f"export failed: {type(e).__name__}: {e}")
    if args.preview:
        import tempfile

        png = project / ".studio" / "previews" / f"{name}.png"
        src_glb = glb if "glb" in files else Path(tempfile.mkdtemp()) / "model.glb"
        if "glb" not in files:
            src_glb.write_bytes(data)
        err = render_preview(src_glb, png, args.size, info.get("camera"))
        if err:
            warnings.append(f"preview failed: {err}")
        else:
            files["preview"] = str(png)
    b = stats["bounds"]
    if b and b["min"][1] < -0.01:
        warnings.append(f"the model reaches below the ground (min y = {b['min'][1]:.2f})")
    first = files.get("glb") or next(iter(files.values()), "")
    try:
        size = Path(first).stat().st_size
    except OSError:
        size = len(data)
    report = {"ok": True, "files": files, "name": info["name"], "objects": info["objects"], "instances": info["instances"],
              "stats": stats, "bytes": size, "warnings": warnings, "build_seconds": round(time.time() - t0, 1)}
    lines = [f"Built {info['name']} → {first} ({size / 1024:.0f} KB, {report['build_seconds']}s)"] + _stats_lines(stats)
    lines += [f"  also: {v}" for k, v in files.items() if k not in ("glb", "preview") and v != first]
    if "preview" in files:
        lines.append(f"Look at it: read {files['preview']} (perspective, front, side, top)")
    lines += [f"warning: {w}" for w in warnings]
    out(args, report, "\n".join(lines))


def cmd_preview(args):
    import tempfile

    src = Path(args.file)
    project = registry.project_dir()
    png = Path(args.out) if args.out else project / ".studio" / "previews" / f"{src.name.split('.')[0]}.png"
    camera = None
    if args.file == "-" or src.name.endswith((".scene.yaml", ".scene.yml")):
        from .scene import export_glb

        args.scene = args.file
        built, _stats, path = _built(args)
        if args.file == "-" and not args.out:
            png = project / ".studio" / "previews" / f"{path.name.split('.')[0]}.png"
        camera = built.info.get("camera")
        glb = Path(tempfile.mkdtemp()) / "model.glb"
        glb.write_bytes(export_glb(built))
    elif not src.exists():
        fail(args, f"file not found: {src}")
    elif src.suffix.lower() in (".glb", ".gltf"):
        glb = src.resolve()
    else:
        import trimesh

        glb = Path(tempfile.mkdtemp()) / "model.glb"
        try:
            glb.write_bytes(trimesh.load(str(src), force="scene").export(file_type="glb", include_normals=True))
        except Exception as e:  # noqa: BLE001
            fail(args, f"cannot load {src}: {e}")
    err = render_preview(glb, png, args.size, camera)
    if err:
        fail(args, f"preview failed: {err}")
    out(args, {"ok": True, "preview": str(png)}, f"Preview: {png} — read it to look at the model")


def cmd_info(args):
    import trimesh

    from .scene import scene_stats

    try:
        scene = trimesh.load(args.file, force="scene")
    except Exception as e:  # noqa: BLE001
        fail(args, f"cannot load {args.file}: {e}")
    stats = scene_stats(scene)
    names = [str(n) for n in list(scene.graph.nodes_geometry)[:50]]
    source = _glb_source(Path(args.file))
    lines = [f"{args.file}:"] + _stats_lines(stats) + [f"  nodes: {', '.join(names[:20])}{' …' if len(names) > 20 else ''}"]
    if source:
        lines.append(f"  built from: {source} (edit that file and build again)")
    out(args, {**stats, "nodes_sample": names, "source": source}, "\n".join(lines))


def _glb_source(path: Path) -> str | None:
    """The scene file a .glb was built from (studio-3d writes it into the header)."""
    if path.suffix.lower() != ".glb":
        return None
    try:
        with open(path, "rb") as f:
            head = f.read(20)
            if head[:4] != b"glTF" or head[16:20] != b"JSON":
                return None
            tree = json.loads(f.read(int.from_bytes(head[12:16], "little")))
        src = (tree.get("asset") or {}).get("extras", {}).get("studio_source")
        return str(src) if src else None
    except (OSError, ValueError):
        return None


def _packs():
    sys.path.insert(0, str(TOOL_DIR.parent / "studio" / "python"))
    from studio_packs import all_packs

    return all_packs()


def _load_registry() -> None:
    registry.load_builtins()
    registry.load_project_plugins()


def cmd_shapes(args):
    with _Quiet():
        _load_registry()
    words = [w.lower() for w in (args.words or [])]

    def match(*parts):
        hay = " ".join(str(p) for p in parts).lower()
        return all(w in hay for w in words)

    shapes = [{"shape": e.name, "doc": e.doc.split("\n")[0], "params": {k: v for k, v in e.params.items()}, "source": e.source}
              for e in registry.SHAPES.values() if match(e.name, e.doc, e.source)]
    mods = [{"modifier": e.name, "doc": e.doc.split("\n")[0], "params": e.params, "source": e.source} for e in registry.MODIFIERS.values() if match(e.name, e.doc)]
    pack_items = []
    for p in _packs():
        if p.type != "3d":
            continue
        for it in p.items.values():
            if it.get("kind") in ("model", "prefab", "plugin") and match(p.id, it["id"], it.get("name", ""), it.get("kind"), " ".join(it.get("tags", []))):
                pack_items.append({"use": f"{p.id}/{it['id']}", "kind": it.get("kind"), "name": it.get("name", it["id"]), "params": (it.get("meta") or {}).get("params")})
    lines = ["Shapes (shape: <name>, params inline):"]
    lines += [f"  {s['shape']:<10} {s['doc']}  [{s['source']}]\n             params: {', '.join(f'{k}={v}' for k, v in s['params'].items())}" for s in shapes]
    lines.append("Modifiers (modifiers: [ {type: noise, amount: 0.1} ]):")
    lines += [f"  {m['modifier']:<14} {m['doc']}  params: {', '.join(f'{k}={v}' for k, v in m['params'].items()) or '-'}" for m in mods]
    lines.append(f"Pack models / prefabs / shape plugins (use: <pack>/<item>) — {len(pack_items)}:")
    lines += [f"  {x['use']:<36} {x['kind']:<8} {x['name']}" + (f"  params: {x['params']}" if x.get("params") else "") for x in pack_items[:300]]
    lines.append("Every object also takes: shading: auto|flat|smooth, smooth_angle, uv (studio-3d textures)")
    lines += [f"plugin error: {e['file']}: {e['error']}" for e in registry.PLUGIN_ERRORS]
    out(args, {"shapes": shapes, "modifiers": mods, "packs": pack_items, "pluginErrors": registry.PLUGIN_ERRORS}, "\n".join(lines))


def cmd_materials(args):
    from .materials import MAT_KEYS, PRESETS

    words = [w.lower() for w in (args.words or [])]
    presets = {k: v for k, v in PRESETS.items() if all(w in k for w in words)}
    pack_mats = []
    for p in _packs():
        for it in p.items.values():
            if it.get("kind") == "material" and all(w in f"{p.id} {it['id']} {it.get('name', '')} {' '.join(it.get('tags', []))}".lower() for w in words):
                pack_mats.append({"use": f"{p.id}/{it['id']}", "name": it.get("name", it["id"])})
    lines = ["Material presets (material: <name>):"]
    lines += [f"  {k:<11} {', '.join(f'{a}={b}' for a, b in v.items())}" for k, v in presets.items()]
    lines.append(f"Pack materials (materials: {{ x: <pack>/<item> }}) — {len(pack_mats)}:")
    lines += [f"  {m['use']:<36} {m['name']}" for m in pack_mats]
    lines.append('Own materials: materials: { hull: { color: "#335577", metallic: 0.3, roughness: 0.4, emissive: "#000000", opacity: 1 } }')
    lines.append('Built on another one: { use: wood, roughness: 0.5 }   ·   textured: { texture: { type: bricks }, bump: 1, texture_scale: 1.5 }')
    lines.append(f"Options: {', '.join(k for k in MAT_KEYS if k != 'name')}")
    lines.append("Textures, UV projections and maps: studio-3d textures")
    out(args, {"presets": presets, "packs": pack_mats, "options": list(MAT_KEYS)}, "\n".join(lines))


def cmd_textures(args):
    from . import uv as uvmap
    from .editor import project_textures
    from .textures import MAPS, plugin_errors, procedural

    with _Quiet():
        proc = procedural()
        files = project_textures(400)
    words = [w.lower() for w in (args.words or [])]
    if words:
        proc = [t for t in proc if all(w in f"{t['name']} {t['doc']} {t['source']}".lower() for w in words)]
        files = [f for f in files if all(w in f["path"].lower() for w in words)]
    lines = ["Procedural textures (made by studio-image; texture: { type: <name>, colors: [dark, light], size: 512, … }):"]
    for t in proc:
        params = ", ".join(f"{k}={json.dumps(v)}" for k, v in t["params"].items())
        src = "" if t["source"] == "built-in" else f"  [{t['source']}]"
        lines.append(f"  {t['name']:<10} {t['doc']}{('  params: ' + params) if params else ''}{src}")
    if not proc and not words:
        lines.append("  (studio-image is not installed — only image files work as textures)")
    lines.append("Pictures of this project (texture: <path>):")
    lines += [f"  {f['path']}" + ("   (studio-image picture, rendered when the scene is built)" if f["kind"] == "picture" else "") for f in files[:60]] or (
        ["  none match"] if words else ["  none yet — put images in assets/ or make one: studio-image new src/wall.image.yaml --template texture"])
    if not words:
        lines.append("UV projections (material: uv: <name> or { projection, axis, scale, repeat, offset, rotation }; per object: uv: …):")
        lines += [f"  {k:<9} {v}" for k, v in uvmap.PROJECTIONS.items()]
        lines.append("Maps of a material (each takes a file, a picture, a texture name or a mapping like `texture`):")
        lines += [f"  {k:<14} {v}" for k, v in MAPS.items()]
        lines.append("More: bump: 1 (relief from the texture itself), texture_scale / texture_repeat / texture_offset / texture_rotation,")
        lines.append("      texture_filter: nearest (pixel art), texture_wrap: repeat|clamp|mirror, alpha: opaque|blend|cutout")
    errs = plugin_errors()
    lines += [f"plugin error: {e['file']}: {e['error']}" for e in errs]
    out(args, {"procedural": proc, "files": files, "projections": uvmap.PROJECTIONS, "maps": MAPS, "pluginErrors": errs}, "\n".join(lines))


def cmd_plugin(args):
    if args.action != "new":
        fail(args, "usage: studio-3d plugin new <name> [--kind shape|modifier]")
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    if not name.isidentifier():
        fail(args, f'"{args.name}" cannot be a plugin name — letters, digits and _ only, not starting with a digit')
    path = registry.project_dir() / "plugins" / "3d" / f"{name}.py"
    if path.exists():
        fail(args, f"{path} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text((PLUGIN_MODIFIER if args.kind == "modifier" else PLUGIN_SHAPE).replace("{{NAME}}", name), "utf-8")
    use = f"modifiers: [ {{ type: {name} }} ]" if args.kind == "modifier" else f"objects: [ {{ shape: {name} }} ]"
    out(args, {"ok": True, "file": str(path)}, f"Created {path}. Use it: {use}")


def cmd_docs(args):
    print((TOOL_DIR / "README.md").read_text("utf-8"))


# ---- editor engine (always JSON) --------------------------------------------------------------
def cmd_model(args):
    from .editor import scene_model

    text, path = _scene_text(args)
    with _Quiet():
        try:
            data = scene_model(text, path)
        except Exception as e:  # noqa: BLE001
            data = {"ok": False, "error": f"{type(e).__name__}: {e}", "pluginErrors": registry.PLUGIN_ERRORS}
    print(json.dumps(data, default=str))


def cmd_catalog(args):
    from .editor import catalog

    with _Quiet():
        try:
            data = catalog()
        except Exception as e:  # noqa: BLE001
            data = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if args.json:
        print(json.dumps(data, default=str))
        return
    if not data.get("ok"):
        fail(args, data["error"])
    print(f"{len(data['shapes'])} shapes, {len(data['modifiers'])} modifiers, {len(data['presets'])} material presets, "
          f"{len(data['textures'])} procedural textures, {len(data['packs']['objects'])} pack objects, {len(data['packs']['materials'])} pack materials")
    for e in data["pluginErrors"]:
        print(f"plugin error: {e['file']}: {e['error']}")


def cmd_texture(args):
    from .editor import project_textures, texture_preview

    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "error": f"invalid JSON on stdin: {e}"}))
        return
    with _Quiet():
        try:
            data = {"ok": True, "files": project_textures()} if req.get("list") else texture_preview(req)
        except Exception as e:  # noqa: BLE001
            data = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(data, default=str))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="studio-3d", add_help=False)
    p.add_argument("-h", "--help", action="store_true")
    p.add_argument("--version", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    def add(name, fn):
        sp = sub.add_parser(name)
        sp.add_argument("--json", action="store_true")
        sp.set_defaults(fn=fn)
        return sp

    sp = add("new", cmd_new)
    sp.add_argument("file")
    sp.add_argument("--template", default="basic")
    sp.add_argument("--force", action="store_true")
    for name, fn in (("check", cmd_check), ("model", cmd_model)):
        sp = add(name, fn)
        sp.add_argument("scene")
        sp.add_argument("--path", help='name/location of the scene when it is read from stdin ("-")')
    sp = add("build", cmd_build)
    sp.add_argument("scene")
    sp.add_argument("--path")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--format", default="glb", help="glb,obj,stl,ply")
    sp.add_argument("--preview", action="store_true")
    sp.add_argument("--size", type=int, default=512)
    sp = add("preview", cmd_preview)
    sp.add_argument("file")
    sp.add_argument("--path")
    sp.add_argument("--out")
    sp.add_argument("--size", type=int, default=512)
    add("info", cmd_info).add_argument("file")
    add("shapes", cmd_shapes).add_argument("words", nargs="*")
    add("materials", cmd_materials).add_argument("words", nargs="*")
    add("textures", cmd_textures).add_argument("words", nargs="*")
    sp = add("plugin", cmd_plugin)
    sp.add_argument("action")
    sp.add_argument("name")
    sp.add_argument("--kind", default="shape", choices=["shape", "modifier"])
    add("docs", cmd_docs)
    add("catalog", cmd_catalog)
    add("texture", cmd_texture)
    args = p.parse_args(argv)
    if args.version:
        print(f"studio-3d {__version__}")
        return
    if args.help or not args.cmd:
        print(HELP)
        return
    args.fn(args)
