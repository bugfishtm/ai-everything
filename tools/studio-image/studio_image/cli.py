"""studio-image command line."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import __version__, registry
from .templates import PICTURES, PLUGINS

HELP = """studio-image — pictures from text (pictures are YAML files, see: studio-image docs)

  studio-image new <file.image.yaml> [--template poster|icon|pixel|texture|banner|blank]
  studio-image check <picture>                  validate fast: names, options, files, fonts
  studio-image render <picture> [--preview] [--scale 0.5] [--out DIR] [--name N]
                                                → exports/<name>.png (+ the picture's own export list) and a preview to look at
  studio-image info <image file>                size, transparency, brightness, main colors of ANY image
  studio-image palette <image file> [--colors 8] [--preview]     the main colors as hex
  studio-image convert <image file> [--to png|jpg|webp] [--width W] [--height H] [--scale S] [--fit cover|contain|stretch] [--pixel] [--out FILE]
  studio-image sheet <images…> [--cols N] [--gap G] [--out exports/sheet.png]   pack pictures into one sprite sheet + atlas JSON
  studio-image list [shapes|textures|filters|fonts|blends] [words]
  studio-image plugin new <name> [--kind shape|filter|texture]   extend the tool (plugins/image/<name>.py)
  studio-image docs                             full format reference
Add --json for machine readable output."""


def out(args, data, text: str) -> None:
    print(json.dumps(data, default=str) if args.json else text)


def fail(args, msg: str, code: int = 1) -> None:
    if getattr(args, "json", False):
        print(json.dumps({"ok": False, "error": msg}), file=sys.__stdout__, flush=True)
    else:
        print(f"studio-image: {msg}", file=sys.stderr)
    sys.exit(code)


class _Quiet:
    """plugin print() output goes to stderr so JSON on stdout stays clean"""

    def __enter__(self):
        self.prev = sys.stdout
        sys.stdout = sys.stderr

    def __exit__(self, *exc):
        sys.stdout = self.prev


def _load(args):
    from .compose import ImageError, load_doc

    try:
        with _Quiet():
            return load_doc(args.picture)
    except ImageError as e:
        fail(args, str(e))


def _name(args, path) -> str:
    return getattr(args, "name", None) or Path(path).name.split(".")[0] or "picture"


def _open(args, path: str):
    from PIL import Image

    try:
        im = Image.open(path)
        im.load()
        return im
    except FileNotFoundError:
        fail(args, f"file not found: {path}")
    except Exception as e:  # noqa: BLE001
        fail(args, f"cannot read {path}: {e}")


def analyze(img) -> dict:
    """Numbers that describe a picture — for an AI that wants to know what it made."""
    import numpy as np

    rgba = img.convert("RGBA")
    small = rgba.copy()
    small.thumbnail((256, 256))
    a = np.asarray(small).astype(np.float32)
    alpha = a[..., 3] / 255.0
    opaque = alpha > 0.03
    data: dict = {"transparent_percent": round(float(100 * (1 - opaque.mean())), 1)}
    if opaque.any():
        rgb = a[..., :3][opaque]
        lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        data["brightness"] = round(float(lum.mean() / 255), 3)
        data["contrast"] = round(float(lum.std() / 255), 3)
        data["mean_color"] = "#%02x%02x%02x" % tuple(int(v) for v in rgb.mean(0))
        data["colors"] = dominant_colors(small, 6)
    return data


def dominant_colors(img, n: int = 6) -> list[dict]:
    from PIL import Image

    rgba = img.convert("RGBA")
    flat = Image.new("RGB", rgba.size, (0, 0, 0))
    flat.paste(rgba, mask=rgba.getchannel("A"))
    visible = rgba.getchannel("A").point(lambda v: 255 if v > 8 else 0)
    q = flat.quantize(colors=max(2, min(32, n + 1)), method=Image.MEDIANCUT)
    pal = q.getpalette()[: 3 * 256]
    counts: dict[int, int] = {}
    qd, vd = q.getdata(), visible.getdata()
    for idx, vis in zip(qd, vd):
        if vis:
            counts[idx] = counts.get(idx, 0) + 1
    total = sum(counts.values()) or 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:n]
    return [{"hex": "#%02x%02x%02x" % tuple(pal[i * 3 : i * 3 + 3]), "percent": round(100 * c / total, 1)} for i, c in top]


def write_exports(doc, img, out_dir: Path, name: str) -> list[dict]:
    """Writes the picture's export list; returns one entry per file."""
    from PIL import Image

    import studio_gfx as gfx

    files = []
    W, H = img.size
    for e in doc.exports:
        fmt = e["format"]
        resample = Image.NEAREST if e.get("smooth") is False else Image.LANCZOS
        variants: list[tuple[str, tuple[int, int]]] = []
        if e.get("sizes") and fmt != "ico":
            for s in e["sizes"]:
                wh = (int(s[0]), int(s[1])) if isinstance(s, (list, tuple)) else (int(s), max(1, int(round(int(s) * H / W))))
                variants.append((str(wh[0]) if not isinstance(s, (list, tuple)) else f"{wh[0]}x{wh[1]}", wh))
        else:
            if e.get("size"):
                wh = (int(e["size"][0]), int(e["size"][1])) if isinstance(e["size"], (list, tuple)) else (int(e["size"]), int(e["size"]))
            elif e.get("width") or e.get("height"):
                f = (float(e["width"]) / W) if e.get("width") else (float(e["height"]) / H)
                wh = (max(1, int(round(W * f))), max(1, int(round(H * f))))
            elif e.get("scale"):
                wh = (max(1, int(round(W * float(e["scale"])))), max(1, int(round(H * float(e["scale"])))))
            else:
                wh = (W, H)
            variants.append((str(wh[0]), wh))
        pattern = str(e.get("name") or ("{name}-{size}" if len(variants) > 1 else "{name}"))
        for label, wh in variants:
            im = img if wh == (W, H) else (gfx.fit(img, wh, "contain") if resample != Image.NEAREST else img.resize(wh, Image.NEAREST))
            stem = pattern.replace("{name}", name).replace("{size}", label).replace("{w}", str(wh[0])).replace("{h}", str(wh[1]))
            stem = "".join(ch if ch.isalnum() or ch in "-_.@" else "-" for ch in stem) or name
            path = out_dir / f"{stem}.{fmt}"
            path.parent.mkdir(parents=True, exist_ok=True)
            if fmt == "jpg":
                bg = gfx.color(e.get("background", "#ffffff"), doc.palette)[:3]
                flat = Image.new("RGB", im.size, bg)
                flat.paste(im, mask=im.getchannel("A"))
                flat.save(str(path), "JPEG", quality=int(e.get("quality", 90)), optimize=True)
            elif fmt == "webp":
                im.save(str(path), "WEBP", quality=int(e.get("quality", 90)), method=4)
            elif fmt == "ico":
                side = max(im.size)
                sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
                sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
                sizes = [(int(s), int(s)) for s in (e.get("sizes") or [16, 32, 48]) if int(s) <= 256]
                sq.save(str(path), "ICO", sizes=sizes or [(32, 32)])
            elif fmt == "gif":
                im.convert("P", palette=Image.ADAPTIVE, colors=255).save(str(path), "GIF")
            elif fmt == "bmp":
                flat = Image.new("RGB", im.size, gfx.color(e.get("background", "#ffffff"), doc.palette)[:3])
                flat.paste(im, mask=im.getchannel("A"))
                flat.save(str(path), "BMP")
            else:
                im.save(str(path), "PNG", optimize=True)
            shown = [im.width, im.height] if fmt != "ico" else [max(x[0] for x in (sizes or [(32, 32)]))] * 2
            files.append({"file": str(path), "format": fmt, "size": shown, "bytes": path.stat().st_size})
    return files


def write_preview(img, path: Path) -> None:
    """The picture as the AI should look at it: on a checkerboard when transparent, small ones enlarged."""
    from PIL import Image

    import studio_gfx as gfx

    im = img
    big = max(im.size)
    if big > 1200:
        f = 1200 / big
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))), Image.LANCZOS)
    elif big < 320:
        f = max(2, 480 // big)
        im = im.resize((im.width * f, im.height * f), Image.NEAREST)
    path.parent.mkdir(parents=True, exist_ok=True)
    gfx.on_checker(im.convert("RGBA")).save(str(path))


def cmd_new(args):
    path = Path(args.file)
    if not path.name.endswith((".image.yaml", ".image.yml")):
        path = path.with_name(path.name.split(".")[0] + ".image.yaml")
    if path.exists() and not args.force:
        fail(args, f"{path} exists (use --force to overwrite)")
    tpl = PICTURES.get(args.template)
    if not tpl:
        fail(args, f"unknown template {args.template} ({', '.join(PICTURES)})")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(tpl.replace("{{TITLE}}", path.name.split(".")[0].replace("-", " ").replace("_", " ").title()), "utf-8")
    out(args, {"ok": True, "file": str(path)}, f"Created {path} — render it and look: studio-image render {path} --preview")


def _summary(doc) -> dict:
    return {"ok": True, "title": doc.title, "size": [doc.w, doc.h], "layers": doc.count, "exports": [e["format"] for e in doc.exports],
            "warnings": doc.warnings + registry.WARNINGS}


def cmd_check(args):
    doc = _load(args)
    data = _summary(doc)
    lines = [f"OK — {doc.title}: {doc.w}×{doc.h}, {doc.count} layer(s), exports: {', '.join(data['exports'])}"]
    lines += [f"warning: {w}" for w in data["warnings"]]
    out(args, data, "\n".join(lines))


def cmd_render(args):
    from .compose import ImageError

    doc = _load(args)
    t0 = time.time()
    try:
        scale = float(args.scale)
        if not 0.02 <= scale <= 4:
            raise ValueError
    except ValueError:
        fail(args, "--scale: a number between 0.02 and 4")
    try:
        with _Quiet():
            img = doc.render(scale)
    except ImageError as e:
        fail(args, str(e))
    except MemoryError:
        fail(args, "the picture is too large to render (lower image.size or image.antialias)")
    except Exception as e:  # noqa: BLE001
        fail(args, f"render failed: {type(e).__name__}: {e}")
    project = registry.project_dir()
    out_dir = Path(args.out) if args.out else project / "exports"
    name = _name(args, args.picture)
    try:
        exports = write_exports(doc, img, out_dir, name)
    except Exception as e:  # noqa: BLE001
        fail(args, f"writing the files failed: {type(e).__name__}: {e}")
    files = {"image": exports[0]["file"]}
    if args.preview:
        png = project / ".studio" / "previews" / f"{name}.png"
        write_preview(img, png)
        files["preview"] = str(png)
    warnings = doc.warnings + registry.WARNINGS
    info = analyze(img)
    if info.get("contrast") is not None and info["contrast"] < 0.04 and info["transparent_percent"] < 99:
        warnings.append("the picture has almost no contrast — everything has nearly the same brightness")
    report = {"ok": True, "files": files, "exports": exports, "title": doc.title, "size": [img.width, img.height], "layers": doc.count,
              "analysis": info, "warnings": warnings, "render_seconds": round(time.time() - t0, 2)}
    lines = [f"Rendered {doc.title}: {img.width}×{img.height}, {doc.count} layer(s) ({report['render_seconds']}s)"]
    lines += [f"  {e['file']}  ({e['size'][0]}×{e['size'][1]}, {e['bytes'] / 1024:.1f} KB)" for e in exports]
    if "brightness" in info:
        lines.append(f"  brightness {info['brightness']}, contrast {info['contrast']}, transparent {info['transparent_percent']}%, colors: " +
                     ", ".join(f"{c['hex']} {c['percent']}%" for c in info.get("colors", [])[:5]))
    else:
        lines.append("  the picture is completely transparent")
    lines += [f"warning: {w}" for w in warnings]
    if args.preview:
        lines.append(f"Look at it: read {files['preview']}")
    out(args, report, "\n".join(lines))


def cmd_info(args):
    im = _open(args, args.file)
    p = Path(args.file)
    data = {"ok": True, "file": str(p), "format": im.format, "size": [im.width, im.height], "mode": im.mode,
            "alpha": im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info, "bytes": p.stat().st_size,
            "frames": getattr(im, "n_frames", 1), **analyze(im)}
    lines = [f"{p.name}: {im.format} {im.width}×{im.height}, {im.mode}{', ' + str(data['frames']) + ' frames' if data['frames'] > 1 else ''}, {data['bytes'] / 1024:.1f} KB"]
    if "brightness" in data:
        lines.append(f"  brightness {data['brightness']}, contrast {data['contrast']}, transparent {data['transparent_percent']}%, mean color {data['mean_color']}")
        lines.append("  colors: " + ", ".join(f"{c['hex']} {c['percent']}%" for c in data["colors"]))
    else:
        lines.append("  completely transparent")
    out(args, data, "\n".join(lines))


def cmd_palette(args):
    from PIL import Image, ImageDraw

    im = _open(args, args.file)
    n = max(2, min(24, int(args.colors)))
    small = im.convert("RGBA")
    small.thumbnail((400, 400))
    cols = dominant_colors(small, n)
    data = {"ok": True, "file": args.file, "colors": cols}
    lines = [f"{c['hex']}  {c['percent']:>5}%" for c in cols]
    if args.preview:
        png = registry.project_dir() / ".studio" / "previews" / f"{Path(args.file).stem}-palette.png"
        sw = Image.new("RGB", (len(cols) * 96, 96), (0, 0, 0))
        d = ImageDraw.Draw(sw)
        for i, c in enumerate(cols):
            d.rectangle([i * 96, 0, i * 96 + 95, 95], fill=c["hex"])
        png.parent.mkdir(parents=True, exist_ok=True)
        sw.save(str(png))
        data["preview"] = str(png)
        lines.append(f"swatches: {png}")
    lines.append("as a palette for a picture:  palette: { " + ", ".join(f'c{i + 1}: "{c["hex"]}"' for i, c in enumerate(cols)) + " }")
    out(args, data, "\n".join(lines))


def cmd_convert(args):
    from PIL import Image

    import studio_gfx as gfx

    im = _open(args, args.file).convert("RGBA")
    src = Path(args.file)
    fmt = (args.to or (Path(args.out).suffix.lstrip(".") if args.out else src.suffix.lstrip("."))).lower()
    fmt = "jpg" if fmt == "jpeg" else fmt
    if fmt not in ("png", "jpg", "webp", "gif", "bmp"):
        fail(args, f'cannot write "{fmt}" — one of png, jpg, webp, gif, bmp')
    W, H = im.size
    try:
        if args.width and args.height:
            wh = (int(args.width), int(args.height))
        elif args.width or args.height:
            f = int(args.width) / W if args.width else int(args.height) / H
            wh = (max(1, round(W * f)), max(1, round(H * f)))
        elif args.scale:
            wh = (max(1, round(W * float(args.scale))), max(1, round(H * float(args.scale))))
        else:
            wh = (W, H)
    except ValueError:
        fail(args, "--width, --height and --scale are numbers")
    if wh != (W, H):
        im = im.resize(wh, Image.NEAREST) if args.pixel else gfx.fit(im, wh, args.fit)
    dest = Path(args.out) if args.out else registry.project_dir() / "exports" / f"{src.stem}{'' if (wh == (W, H) and fmt != src.suffix.lstrip('.').lower()) else f'-{wh[0]}x{wh[1]}'}.{fmt}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if fmt in ("jpg", "bmp"):
        flat = Image.new("RGB", im.size, gfx.color(args.background)[:3])
        flat.paste(im, mask=im.getchannel("A"))
        flat.save(str(dest), "JPEG" if fmt == "jpg" else "BMP", **({"quality": int(args.quality), "optimize": True} if fmt == "jpg" else {}))
    elif fmt == "webp":
        im.save(str(dest), "WEBP", quality=int(args.quality))
    elif fmt == "gif":
        im.convert("P", palette=Image.ADAPTIVE, colors=255).save(str(dest), "GIF")
    else:
        im.save(str(dest), "PNG", optimize=True)
    out(args, {"ok": True, "file": str(dest), "size": list(im.size), "bytes": dest.stat().st_size}, f"{dest}  ({im.width}×{im.height}, {dest.stat().st_size / 1024:.1f} KB)")


def cmd_sheet(args):
    from PIL import Image

    ims = []
    for f in args.files:
        ims.append((Path(f).stem, _open(args, f).convert("RGBA")))
    cw, ch = max(i.width for _, i in ims), max(i.height for _, i in ims)
    cols = int(args.cols) if args.cols else min(len(ims), 8)
    gap = int(args.gap)
    rows = -(-len(ims) // cols)
    sheet = Image.new("RGBA", (cols * cw + (cols - 1) * gap, rows * ch + (rows - 1) * gap), (0, 0, 0, 0))
    frames = []
    for i, (name, im) in enumerate(ims):
        x, y = (i % cols) * (cw + gap), (i // cols) * (ch + gap)
        sheet.paste(im, (x + (cw - im.width) // 2, y + (ch - im.height) // 2))
        frames.append({"name": name, "frame": i, "x": x, "y": y, "w": cw, "h": ch})
    dest = Path(args.out) if args.out else registry.project_dir() / "exports" / "sheet.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(dest))
    atlas = {"image": dest.name, "cell": [cw, ch], "columns": cols, "rows": rows, "gap": gap, "frames": frames}
    dest.with_suffix(".json").write_text(json.dumps(atlas, indent=1), "utf-8")
    out(args, {"ok": True, "files": {"png": str(dest), "json": str(dest.with_suffix(".json"))}, **atlas},
        f"Sprite sheet: {dest} ({cols}×{rows} cells of {cw}×{ch} px, {len(ims)} pictures)\nAtlas: {dest.with_suffix('.json')}")


TABLES = {
    "shapes": ("shape", "layers: [ { <shape>: […], fill: …, stroke: …, <param>: … } ]"),
    "textures": ("texture", "layers: [ { texture: <name>, colors: [dark, light], <param>: … } ]   or   fill: { texture: <name>, … }"),
    "filters": ("filter", "filters: [ { <name>: value } ]   — on the whole picture, or inside a layer"),
}


def cmd_list(args):
    import studio_gfx as gfx

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    what = (args.what or "all").lower()
    words = [w.lower() for w in (args.words or [])]
    if what not in TABLES and what not in ("all", "fonts", "blends", "kinds"):
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
        lines += ["more layer kinds — text, image, pixels, texture, group, repeat, scatter (studio-image docs)", ""]
    if what in ("all", "fonts") and not words:
        data["fonts"] = list(gfx.FONTS)
        lines += [f"fonts — font: {', '.join(gfx.FONTS)}  (or a .ttf / .otf file of the project, or a pack item)", ""]
    if what in ("all", "blends") and not words:
        data["blends"] = gfx.BLENDS
        lines += [f"blends — blend: {', '.join(gfx.BLENDS)}", ""]
    for err in registry.PLUGIN_ERRORS:
        lines.append(f"plugin error: {err['file']}: {err['error']}")
    data["pluginErrors"] = registry.PLUGIN_ERRORS
    if not lines:
        lines = [f"nothing matches: {' '.join(words)}"]
    out(args, data, "\n".join(lines).rstrip())


def cmd_plugin(args):
    if args.action != "new":
        fail(args, "usage: studio-image plugin new <name> [--kind shape|filter|texture]")
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    if not name.isidentifier():
        fail(args, "the name must be a word (letters, digits, _)")
    path = registry.project_dir() / "plugins" / "image" / f"{name}.py"
    if path.exists():
        fail(args, f"{path} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(PLUGINS[args.kind].replace("{{NAME}}", name), "utf-8")
    use = {"shape": f"{{ {name}: [400, 300, 120], fill: \"#ffcc00\" }}", "filter": f"filters: [ {{ {name}: 0.4 }} ]", "texture": f"{{ texture: {name} }}"}[args.kind]
    out(args, {"ok": True, "file": str(path)}, f"Created {path}. Use it in a picture: {use}   (check it: studio-image list {name})")


def cmd_docs(args):
    print((Path(__file__).resolve().parents[1] / "README.md").read_text("utf-8"))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="studio-image", add_help=False)
    p.add_argument("-h", "--help", action="store_true")
    p.add_argument("--version", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    def add(name, fn):
        sp = sub.add_parser(name, add_help=True)
        sp.add_argument("--json", action="store_true")
        sp.set_defaults(fn=fn)
        return sp

    sp = add("new", cmd_new)
    sp.add_argument("file")
    sp.add_argument("--template", default="poster")
    sp.add_argument("--force", action="store_true")
    add("check", cmd_check).add_argument("picture")
    sp = add("render", cmd_render)
    sp.add_argument("picture")
    sp.add_argument("--out")
    sp.add_argument("--name")
    sp.add_argument("--scale", default="1")
    sp.add_argument("--preview", action="store_true")
    add("info", cmd_info).add_argument("file")
    sp = add("palette", cmd_palette)
    sp.add_argument("file")
    sp.add_argument("--colors", default="8")
    sp.add_argument("--preview", action="store_true")
    sp = add("convert", cmd_convert)
    sp.add_argument("file")
    sp.add_argument("--to")
    sp.add_argument("--width")
    sp.add_argument("--height")
    sp.add_argument("--scale")
    sp.add_argument("--fit", default="cover", choices=["cover", "contain", "stretch"])
    sp.add_argument("--pixel", action="store_true", help="no smoothing (pixel art)")
    sp.add_argument("--quality", default="90")
    sp.add_argument("--background", default="#ffffff", help="behind transparent parts (jpg, bmp)")
    sp.add_argument("--out")
    sp = add("sheet", cmd_sheet)
    sp.add_argument("files", nargs="+")
    sp.add_argument("--cols")
    sp.add_argument("--gap", default="0")
    sp.add_argument("--out")
    sp = add("list", cmd_list)
    sp.add_argument("what", nargs="?")
    sp.add_argument("words", nargs="*")
    sp = add("plugin", cmd_plugin)
    sp.add_argument("action")
    sp.add_argument("name")
    sp.add_argument("--kind", default="shape", choices=list(PLUGINS))
    add("docs", cmd_docs)
    args = p.parse_args(argv)
    if args.version:
        print(f"studio-image {__version__}")
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
