"""What the website's 3D editor needs from the engine (always JSON).

  scene_model   builds the (unsaved) scene text tolerantly: a .glb whose nodes carry the id of the object in
                the text (`extras.sid` = its YAML path, e.g. "objects.2.group.0"), what was built per object,
                the resolved materials, errors per object instead of one fatal error
  catalog       everything a scene can name: shapes and modifiers with parameters and UI hints, material
                presets, pack items, procedural textures (studio-image), UV projections, texture maps
  texture_preview  a small picture of any texture source (file, picture, procedural, inline layers)

The editor itself never guesses geometry: every change is written into the text and built here again —
so plugins (also the ones an AI wrote a minute ago) look in the editor exactly like in the export.
"""
from __future__ import annotations

import hashlib
import io
import os
import sys
import time
from pathlib import Path

from . import __version__, registry
from . import uv as uvmap
from .materials import MAT_KEYS, PRESETS, MaterialLib
from .scene import OBJ_KEYS, SceneError, build_text, export_glb, scene_stats
from .templates import SCENE_TEMPLATES
from .textures import IMAGE_EXT, MAPS, PICTURE_EXT, TextureError, TextureLib, cache_dir, kind_of, normal_from_height, plugin_errors, procedural, prune

# how the editor shows a parameter when the shape gives no hint of its own
GENERIC_UI: dict[str, dict] = {
    "radius": {"min": 0.001, "step": 0.05}, "radius_top": {"min": 0, "step": 0.05, "optional": True}, "height": {"min": 0.001, "step": 0.05},
    "tube": {"min": 0.001, "step": 0.01}, "segments": {"int": True, "min": 3, "max": 256}, "sides": {"int": True, "min": 3, "max": 128},
    "detail": {"int": True, "min": 0, "max": 5}, "resolution": {"int": True, "min": 4, "max": 256}, "seed": {"int": True, "min": 0},
    "octaves": {"int": True, "min": 1, "max": 8}, "roughness": {"min": 0, "max": 1, "step": 0.05}, "scale": {"min": 0.001, "step": 0.05},
    "flat": {"min": 0, "step": 0.5}, "smooth": {"int": True, "min": 0, "max": 64}, "round": {"min": 0.5, "max": 12, "step": 0.5},
    "blend": {"min": 0, "step": 0.01}, "axis": {"choices": ["x", "y", "z"]}, "iterations": {"int": True, "min": 0, "max": 50},
    "amount": {"step": 0.01}, "top": {"min": 0, "max": 4, "step": 0.05}, "degrees": {"min": -720, "max": 720, "step": 5},
    "count": {"int": True, "min": 1}, "size": {"min": 0.001, "step": 0.1},
}
GROUPS = {
    "box": "Basic", "sphere": "Basic", "cylinder": "Basic", "cone": "Basic", "capsule": "Basic", "torus": "Basic", "plane": "Basic", "disc": "Basic",
    "extrude": "From outlines", "lathe": "From outlines", "tube": "From outlines", "mesh": "From outlines",
    "loft": "Organic", "blob": "Organic", "terrain": "Landscape",
}
# a new object of these shapes needs data to exist at all
STARTERS: dict[str, dict] = {
    "extrude": {"points": [[-0.5, -0.4], [0.5, -0.4], [0.5, 0.2], [0, 0.6], [-0.5, 0.2]], "height": 0.4},
    "lathe": {"profile": [[0, 0], [0.3, 0], [0.38, 0.35], [0.2, 0.75], [0.26, 1.0], [0, 1.0]], "segments": 32},
    "tube": {"path": [[-1, 0.3, 0], [-0.3, 0.7, 0], [0.4, 0.3, 0], [1, 0.7, 0]], "radius": 0.07},
    "loft": {"sections": [[-0.6, 0.05, 0.05, 0.3], [-0.2, 0.36, 0.28, 0.3], [0.3, 0.3, 0.24, 0.3], [0.6, 0.04, 0.04, 0.3]], "axis": "x"},
    "blob": {"parts": [{"sphere": 0.35, "at": [0, 0.35, 0]}, {"sphere": 0.24, "at": [0.3, 0.62, 0]}], "blend": 0.15},
    "mesh": {"vertices": [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0, 0, 0.5], [0, 0.8, 0]], "faces": [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]]},
    "terrain": {"size": [10, 10], "height": 1.5, "resolution": 48},
    "plane": {"size": [4, 4]},
}


def _packs():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
    from studio_packs import all_packs

    return all_packs()


def _ui(entry: registry.Entry) -> dict:
    out = {}
    for k in entry.params:
        hint = {**GENERIC_UI.get(k, {}), **(entry.ui.get(k) or {})}
        if hint:
            out[k] = hint
    return out


def _entries(table: dict) -> list[dict]:
    return [{"name": e.name, "doc": e.doc.split("\n")[0], "help": e.doc, "params": e.params, "ui": _ui(e), "source": e.source,
             "group": GROUPS.get(e.name, "Plugins" if e.source != "built-in" else "More"), "starter": STARTERS.get(e.name)}
            for e in table.values()]


def catalog() -> dict:
    registry.load_builtins()
    registry.load_project_plugins()
    objects, materials, textures = [], [], []
    lib = MaterialLib(registry.project_dir(), [])
    for p in _packs():
        for it in p.items.values():
            kind = it.get("kind")
            ref = f"{p.id}/{it['id']}"
            meta = it.get("meta") or {}
            base = {"use": ref, "name": it.get("name", it["id"]), "pack": p.id, "tags": it.get("tags", [])}
            if kind in ("model", "prefab", "plugin") and p.type == "3d" and (kind != "plugin" or meta.get("target", "studio-3d") == "studio-3d"):
                objects.append({**base, "kind": kind, "params": meta.get("params"), "locked": kind == "plugin" and not p.code_allowed})
            elif kind == "material":
                entry = dict(base)
                try:
                    entry.update(lib.summary(lib._resolve_spec({"use": ref}, ref, registry.project_dir())))  # noqa: SLF001
                except Exception:  # noqa: BLE001
                    pass
                materials.append(entry)
            elif kind in ("image", "texture", "picture"):
                textures.append({**base, "kind": kind})
    return {
        "ok": True,
        "version": __version__,
        "shapes": _entries(registry.SHAPES),
        "modifiers": _entries(registry.MODIFIERS),
        "presets": {k: lib.summary(v) | {"spec": v} for k, v in PRESETS.items()},
        "packs": {"objects": objects, "materials": materials, "textures": textures},
        "textures": procedural(),
        "projections": uvmap.PROJECTIONS,
        "maps": MAPS,
        "materialKeys": list(MAT_KEYS),
        "objectKeys": sorted(OBJ_KEYS),
        "shading": list(uvmap.SHADING),
        "templates": list(SCENE_TEMPLATES),
        "pluginErrors": registry.PLUGIN_ERRORS + plugin_errors(),
    }


def scene_model(text: str, path: Path) -> dict:
    t0 = time.time()
    try:
        built = build_text(text, path, tolerant=True)
    except SceneError as e:
        return {"ok": False, "error": str(e), "pluginErrors": registry.PLUGIN_ERRORS}
    b = built.builder
    glb, size = None, 0
    if len(built.scene.geometry):
        data = export_glb(built)
        folder = cache_dir() / "edit"
        folder.mkdir(parents=True, exist_ok=True)
        glb = hashlib.sha1(data).hexdigest()[:24] + ".glb"
        target = folder / glb
        if not target.exists():
            tmp = folder / f"{glb}.{os.getpid()}.tmp"
            tmp.write_bytes(data)
            os.replace(tmp, target)
            prune(folder, 24)
        else:
            os.utime(target)
        size = len(data)
    defined = built.data.get("materials") if isinstance(built.data.get("materials"), dict) else {}
    mats: dict[str, dict] = {}
    for name in defined:
        spec = b.mats.defs.get(str(name))
        mats[str(name)] = ({**b.mats.summary(spec), "defined": True} if spec is not None else {"defined": True, "error": True, "color": "#cfd3da", "maps": []})
    for label, spec in b.mats.used.items():
        mats.setdefault(label, {**b.mats.summary(spec), "defined": False})
    return {
        "ok": True,
        "name": built.info["name"],
        "glb": glb,
        "bytes": size,
        "objects": b.records,
        "errors": b.errors,
        "materials": mats,
        "stats": scene_stats(built.scene),
        "counts": {"objects": built.info["objects"], "instances": built.info["instances"]},
        "camera": built.info["camera"],
        "warnings": [w for w in built.warnings if not w.startswith("plugin ")],  # plugin failures are in pluginErrors
        "pluginErrors": registry.PLUGIN_ERRORS + plugin_errors(),
        "seconds": round(time.time() - t0, 2),
    }


def texture_preview(req: dict) -> dict:
    """{source, size?, as?: color|normal, strength?, path?} → a small PNG in the per-user cache."""
    src = req.get("source")
    if src in (None, "", False):
        return {"ok": False, "error": "no texture"}
    project = registry.project_dir()
    scene_path = Path(str(req.get("path") or "scene.scene.yaml"))
    warnings: list[str] = []
    lib = TextureLib(project, warnings, (project / scene_path).parent, max_size=2048)
    side = max(16, min(int(req.get("size") or 160), 1024))
    try:
        if req.get("as") == "normal":
            strength = req.get("strength")
            img = normal_from_height(lib.gray(src, "texture"), float(strength) if isinstance(strength, (int, float)) else 1.0)
        else:
            img = lib.color(src, "texture")
    except TextureError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    full = list(img.size)
    from PIL import Image

    thumb = img.convert("RGBA" if "A" in img.mode else "RGB")
    if max(thumb.size) > side:
        thumb.thumbnail((side, side), Image.NEAREST if req.get("pixel") else Image.LANCZOS)
    buf = io.BytesIO()
    thumb.save(buf, format="PNG")
    data = buf.getvalue()
    folder = cache_dir() / "thumbs"
    folder.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha1(data).hexdigest()[:24] + ".png"
    if not (folder / name).exists():
        tmp = folder / f"{name}.{os.getpid()}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, folder / name)
        prune(folder, 300)
    return {"ok": True, "file": name, "size": list(thumb.size), "full": full, "kind": kind_of(src), "warnings": warnings}


def project_textures(limit: int = 200) -> list[dict]:
    """Image files and studio-image pictures of the project (what a material can use as a texture)."""
    project = registry.project_dir()
    out = []
    skip = {"node_modules", ".git", ".studio", "dist", "build", "__pycache__", ".venv", "exports"}
    for base, dirs, files in os.walk(project):
        dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith("."))
        for f in sorted(files):
            low = f.lower()
            if low.endswith(PICTURE_EXT) or low.endswith(IMAGE_EXT):
                rel = (Path(base) / f).relative_to(project).as_posix()
                out.append({"path": rel, "kind": "picture" if low.endswith(PICTURE_EXT) else "file"})
                if len(out) >= limit:
                    return out
    return out
