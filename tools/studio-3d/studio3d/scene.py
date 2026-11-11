"""Scene files (*.scene.yaml) → trimesh.Scene → .glb"""
from __future__ import annotations

import difflib
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import trimesh
import yaml
from trimesh.transformations import euler_matrix, translation_matrix

from . import __version__, registry
from . import uv as uvmap
from .materials import MaterialLib, apply_material

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
from studio_packs import PackError, is_ref, resolve  # noqa: E402

OBJ_KEYS = {"name", "shape", "model", "use", "group", "boolean", "params", "position", "rotation", "scale", "material",
            "modifiers", "repeat", "scatter", "visible", "note", "uv", "shading", "smooth_angle"}
TOP_KEYS = ("scene", "materials", "objects", "camera")
SCENE_KEYS = ("name", "note", "smooth_angle", "texture_max", "texture_format")
KINDS = ("group", "boolean", "shape", "use", "model")


class SceneError(Exception):
    pass


def _suggest(word, options) -> str:
    close = difflib.get_close_matches(str(word), list(options), n=3)
    return f" — did you mean {', '.join(close)}?" if close else ""


def _vec3(v, default) -> list[float]:
    if v is None:
        return list(default)
    if isinstance(v, bool):
        raise SceneError(f"expected [x, y, z] or a number, got {v}")
    if isinstance(v, (int, float)):
        return [float(v)] * 3
    try:
        v = [float(x) for x in v]
    except (TypeError, ValueError):
        raise SceneError(f"expected [x, y, z] or a number, got {v!r}") from None
    if len(v) != 3:
        raise SceneError(f"expected [x, y, z], got {v}")
    return v


def transform(position=None, rotation=None, scale=None) -> np.ndarray:
    t = translation_matrix(_vec3(position, (0, 0, 0)))
    rx, ry, rz = (math.radians(a) for a in _vec3(rotation, (0, 0, 0)))
    r = euler_matrix(rx, ry, rz, "sxyz")
    s = np.diag(_vec3(scale, (1, 1, 1)) + [1.0])
    return t @ r @ s


def kind_of(spec: dict) -> str:
    return next((k for k in KINDS if k in spec), "object")


def label_of(spec: dict) -> str:
    kind = kind_of(spec)
    return str(spec.get("name") or (spec.get(kind) if isinstance(spec.get(kind), str) else kind))


def sid_of(path) -> str | None:
    return ".".join(str(p) for p in path) if path is not None else None


class Builder:
    """Builds the scene graph. `tolerant` (the website editor): an object that fails is reported and left out,
    the rest of the scene is still built."""

    def __init__(self, data: dict, project: Path, base_dir: Path, tolerant: bool = False):
        self.data = data
        self.project = project
        self.base_dir = base_dir
        self.tolerant = tolerant
        self.warnings: list[str] = []
        self.errors: list[dict] = []
        self.records: dict[str, dict] = {}
        opts = data.get("scene") if isinstance(data.get("scene"), dict) else {}
        for k in opts:
            if k not in SCENE_KEYS:
                self.warnings.append(f'scene: unknown option "{k}"{_suggest(k, SCENE_KEYS)}')
        self.angle = self._number(opts, "smooth_angle", uvmap.DEFAULT_ANGLE, 0, 180)
        fmt = str(opts.get("texture_format") or "png").lower()
        if fmt not in ("png", "jpg", "jpeg"):
            self.warnings.append(f'scene.texture_format: "{fmt}" — png (exact) or jpg (small files); using png')
        self.mats = MaterialLib(project, self.warnings, base_dir, int(self._number(opts, "texture_max", 2048, 16, 8192)), fmt in ("jpg", "jpeg"))
        self.scene = trimesh.Scene()
        self.names: set[str] = set()
        self.objects = 0
        self.instances = 0

    def _number(self, opts: dict, key: str, default: float, lo: float, hi: float) -> float:
        v = opts.get(key, default)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            self.warnings.append(f"scene.{key}: expected a number — using {default}")
            return float(default)
        return float(min(hi, max(lo, v)))

    def unique(self, name: str) -> str:
        base = name or "object"
        n, i = base, 2
        while n in self.names:
            n = f"{base}-{i}"
            i += 1
        self.names.add(n)
        return n

    # -- geometry of one object (local space, list of (mesh, material key)) ------------
    def parts(self, spec: dict, where: str, material, path=None) -> list[tuple[trimesh.Trimesh, object]]:
        if "boolean" in spec:
            return [(self.boolean(spec["boolean"], where, path), material)]
        if "shape" in spec or ("use" in spec and not is_ref(str(spec["use"]))):
            name = str(spec.get("shape") or spec.get("use"))
            return self.shape(name, spec, where, material)
        if "use" in spec:
            return self.pack_item(str(spec["use"]), spec, where, material)
        if "model" in spec:
            return self.model(Path(str(spec["model"])), where, material, explicit=False)
        raise SceneError(f"{where}: needs one of shape / use / model / group / boolean")

    def shape(self, name: str, spec: dict, where: str, material):
        entry = registry.SHAPES.get(name)
        if entry is None:
            raise SceneError(f'{where}: unknown shape "{name}"{_suggest(name, registry.SHAPES)} (studio-3d shapes)')
        given = spec.get("params")
        if given is not None and not isinstance(given, dict):
            raise SceneError(f"{where}.params must be a mapping, e.g. params: {{ height: 2 }}")
        params = dict(given or {})
        for k, v in spec.items():
            if k not in OBJ_KEYS:
                params[k] = v
        unknown = [k for k in params if k not in entry.params]
        if unknown:
            hint = "".join(_suggest(k, [*entry.params, *OBJ_KEYS]) for k in unknown[:1])
            self.warnings.append(f'{where}: unknown parameter(s) for {name}: {", ".join(map(str, unknown))}{hint} (known: {", ".join(entry.params)})')
        merged = {**entry.params, **params}
        try:
            result = entry.fn(merged)
        except Exception as e:  # noqa: BLE001
            raise SceneError(f"{where}: shape {name} failed: {type(e).__name__}: {e}") from None
        return self.normalize(result, material, where)

    def normalize(self, result, material, where):
        if isinstance(result, trimesh.Trimesh):
            return [(result, material)]
        if isinstance(result, trimesh.Scene):
            return [(g, material) for g in result.dump()]
        if isinstance(result, dict):
            result = list(result.values())
        out = []
        for part in result or []:
            if isinstance(part, trimesh.Trimesh):
                out.append((part, material))
            elif isinstance(part, (tuple, list)) and len(part) == 2 and isinstance(part[0], trimesh.Trimesh):
                # a part that names its material keeps it; the object's material is for the parts that name none
                out.append((part[0], part[1] if part[1] is not None else material))
            else:
                raise SceneError(f"{where}: a shape must return a mesh or (mesh, material) parts")
        if not out:
            raise SceneError(f"{where}: the shape returned no geometry")
        return out

    def pack_item(self, ref: str, spec: dict, where: str, material):
        try:
            pack, item, path = resolve(ref)
        except PackError as e:
            raise SceneError(f"{where}: {e}") from None
        kind = item.get("kind")
        meta = item.get("meta") or {}
        if kind == "plugin":
            if not pack.code_allowed:
                raise SceneError(f'{where}: pack "{pack.id}" contains plugin code that an admin has not reviewed yet')
            try:
                registry.load_file(path, f"pack:{pack.id}/{item['id']}")
            except ImportError as e:
                raise SceneError(f"{where}: {e}") from None
            name = meta.get("shape") or item["id"]
            return self.shape(name, spec, where, material)
        if kind in ("model", "prefab") and path is not None:
            if path.name.endswith((".scene.yaml", ".scene.yml")):
                # a prefab is a whole scene used as one object: build it with all features, then flatten
                sub = load_yaml(path)
                tmp = Builder(sub, self.project, path.parent)
                tmp.mats = self.mats
                tmp.angle = self.angle
                for mname, mspec in (sub.get("materials") or {}).items():
                    if mname not in self.mats.defs:
                        try:
                            self.mats.define(mname, mspec)
                        except (ValueError, PackError) as e:
                            raise SceneError(f"{ref}: materials.{mname}: {e}") from None
                for i, child in enumerate(sub.get("objects") or []):
                    tmp.add_object(child, tmp.scene.graph.base_frame, f"{ref}:objects[{i}]")
                self.warnings.extend(tmp.warnings)
                parts = []
                for node in tmp.scene.graph.nodes_geometry:
                    tf, gname = tmp.scene.graph[node]
                    m = tmp.scene.geometry[gname].copy(include_cache=True)
                    m.apply_transform(tf)
                    parts.append((m, "__keep__" if material is None else material))
                return parts
            return self.model(path, where, material, explicit=True)
        raise SceneError(f'{where}: "{ref}" is a {kind} — use materials for materials, `use:` for models/plugins/prefabs')

    def model(self, path: Path, where: str, material, explicit: bool):
        if not path.is_absolute():
            found = next((c for c in ((self.project / path), (self.base_dir / path)) if c.exists()), None)
            if found is None:
                raise SceneError(f"{where}: model file not found: {path} (paths are relative to the project folder)")
            path = found.resolve()
        if not path.exists():
            raise SceneError(f"{where}: model file not found: {path}")
        try:
            loaded = trimesh.load(str(path), force="scene")
        except Exception as e:  # noqa: BLE001
            raise SceneError(f"{where}: cannot load {path.name}: {e}") from None
        out = []
        for node in loaded.graph.nodes_geometry:
            tf, geom_name = loaded.graph[node]
            g = loaded.geometry[geom_name]
            if not isinstance(g, trimesh.Trimesh) or not len(g.faces):
                continue
            g = g.copy(include_cache=True)
            g.apply_transform(tf)
            # keep the model's own materials unless the object sets one
            out.append((g, material if material is not None else "__keep__"))
        if not out:
            raise SceneError(f"{where}: {path.name} contains no meshes")
        return out

    def boolean(self, spec, where: str, path=None) -> trimesh.Trimesh:
        if not isinstance(spec, dict):
            raise SceneError(f"{where}.boolean must be a mapping: {{ op: difference, objects: [ … ] }}")
        op = str(spec.get("op", "difference"))
        if op not in ("union", "difference", "intersection"):
            raise SceneError(f'{where}.boolean: op must be union, difference or intersection, not "{op}"')
        meshes = []
        for i, child in enumerate(spec.get("objects") or []):
            cwhere = f"{where}.boolean.objects[{i}]"
            if not isinstance(child, dict):
                raise SceneError(f"{cwhere} must be a mapping")
            cpath = [*path, "boolean", "objects", i] if path is not None else None
            parts = self.parts(child, cwhere, None, cpath)
            m = trimesh.util.concatenate([p for p, _ in parts])
            m = self.modified(m, child, cwhere)
            if cpath is not None:
                self.records[sid_of(cpath)] = {"kind": kind_of(child), "operand": True, "bounds": _bounds(m), "triangles": int(len(m.faces))}
            try:
                m.apply_transform(transform(child.get("position"), child.get("rotation"), child.get("scale")))
            except SceneError as e:
                raise SceneError(f"{cwhere}: {e}") from None
            meshes.append(m)
        if len(meshes) < 2:
            raise SceneError(f"{where}.boolean needs at least two objects")
        try:
            fn = {"union": trimesh.boolean.union, "difference": trimesh.boolean.difference, "intersection": trimesh.boolean.intersection}[op]
            out = fn(meshes, engine="manifold")
        except Exception as e:  # noqa: BLE001
            raise SceneError(f"{where}: boolean {op} failed ({e}) — operands should be closed volumes") from None
        if not len(out.faces):
            raise SceneError(f"{where}: boolean {op} left nothing — check the sizes and positions of the operands")
        return out

    def modified(self, mesh, spec: dict, where: str):
        mods = spec.get("modifiers") or []
        if not isinstance(mods, list):
            raise SceneError(f"{where}.modifiers must be a list, e.g. modifiers: [ {{ type: noise, amount: 0.1 }}, flat ]")
        for mod in mods:
            if isinstance(mod, str):
                name, params = mod, {}
            elif isinstance(mod, dict):
                name, params = mod.get("type") or mod.get("use"), {k: v for k, v in mod.items() if k not in ("type", "use")}
            else:
                raise SceneError(f"{where}: a modifier is a name or a mapping with type:, got {mod!r}")
            entry = registry.MODIFIERS.get(name)
            if entry is None:
                raise SceneError(f'{where}: unknown modifier "{name}"{_suggest(name, registry.MODIFIERS)}')
            unknown = [k for k in params if k not in entry.params]
            if unknown:
                self.warnings.append(f'{where}: modifier {name} has no option {", ".join(map(str, unknown))}{_suggest(unknown[0], entry.params)}')
            try:
                mesh = entry.fn(mesh, {**entry.params, **params})
            except Exception as e:  # noqa: BLE001
                raise SceneError(f"{where}: modifier {name} failed: {e}") from None
        return mesh

    def shading_of(self, spec: dict, inherited: str | None) -> str:
        s = spec.get("shading") or inherited
        if s is None:
            for mod in spec.get("modifiers") or []:
                name = mod if isinstance(mod, str) else (mod.get("type") or mod.get("use") if isinstance(mod, dict) else None)
                if name == "flat":
                    s = "flat"
                elif name == "smooth_shading":
                    s = "smooth"
        s = str(s or "auto").lower()
        if s not in uvmap.SHADING:
            raise SceneError(f'shading: "{s}"{_suggest(s, uvmap.SHADING)} — auto, flat or smooth')
        return s

    # -- placement ----------------------------------------------------------------------
    def instances_of(self, spec: dict) -> list[np.ndarray]:
        base = np.eye(4)
        out = [base]
        if spec.get("repeat"):
            r = spec["repeat"]
            if not isinstance(r, dict):
                raise SceneError("repeat must be a mapping: { count: 5, offset: [1, 0, 0] }")
            count = max(1, min(int(r.get("count", 2)), 100_000))
            step = transform(r.get("offset"), r.get("rotate"), r.get("scale"))
            out = []
            m = np.eye(4)
            for _ in range(count):
                out.append(m.copy())
                m = m @ step
        if spec.get("scatter"):
            s = spec["scatter"]
            if not isinstance(s, dict):
                raise SceneError("scatter must be a mapping: { count: 20, area: [10, 10], seed: 1 }")
            rng = np.random.default_rng(int(s.get("seed", 1)))
            area = s.get("area", [10, 10])
            w, d = (float(area), float(area)) if isinstance(area, (int, float)) else (float(area[0]), float(area[-1]))
            sc = s.get("scale", 1.0)
            lo, hi = (float(sc), float(sc)) if isinstance(sc, (int, float)) else (float(sc[0]), float(sc[1]))
            avoid = [tuple(a) for a in s.get("avoid", [])]
            min_d = float(s.get("min_distance", 0))
            pts: list[tuple[float, float]] = []
            tries = 0
            while len(pts) < int(s.get("count", 10)) and tries < 5000:
                tries += 1
                x, z = rng.uniform(-w / 2, w / 2), rng.uniform(-d / 2, d / 2)
                if any((x - a[0]) ** 2 + (z - a[1]) ** 2 < a[2] ** 2 for a in avoid):
                    continue
                if min_d and any((x - px) ** 2 + (z - pz) ** 2 < min_d**2 for px, pz in pts):
                    continue
                pts.append((x, z))
            out = []
            for x, z in pts:
                rot = rng.uniform(0, 360) if s.get("rotate", True) else 0
                k = rng.uniform(lo, hi)
                out.append(transform([x, 0, z], [0, rot, 0], k))
        return out

    def add_object(self, spec, parent: str, where: str, path=None, inherited: dict | None = None) -> None:
        """Add one object (and, for a group, its children). `path` is its place in the YAML — the id the editor uses."""
        sid = sid_of(path)
        if not self.tolerant:
            self._add(spec, parent, where, path, inherited or {})
            return
        try:
            self._add(spec, parent, where, path, inherited or {})
        except SceneError as e:
            self.errors.append({"id": sid, "where": where, "error": str(e)})
            if sid is not None:
                self.records.setdefault(sid, {})["error"] = str(e)
        except Exception as e:  # noqa: BLE001
            self.errors.append({"id": sid, "where": where, "error": f"{where}: {type(e).__name__}: {e}"})
            if sid is not None:
                self.records.setdefault(sid, {})["error"] = f"{type(e).__name__}: {e}"

    def _add(self, spec, parent: str, where: str, path, inherited: dict) -> None:
        if not isinstance(spec, dict):
            raise SceneError(f"{where} must be a mapping")
        sid = sid_of(path)
        kind = kind_of(spec)
        if spec.get("visible") is False:
            if sid is not None:
                self.records[sid] = {"kind": kind, "hidden": True}
            return
        self.objects += 1
        node = self.unique(label_of(spec))
        try:
            local = transform(spec.get("position"), spec.get("rotation"), spec.get("scale"))
            insts = self.instances_of(spec)
        except SceneError as e:
            raise SceneError(f"{where}: {e}") from None
        except (TypeError, ValueError, IndexError) as e:
            raise SceneError(f"{where}: repeat/scatter: {e}") from None
        material = spec.get("material", inherited.get("material"))
        try:
            shading = self.shading_of(spec, inherited.get("shading"))
        except SceneError as e:
            raise SceneError(f"{where}: {e}") from None
        angle = spec.get("smooth_angle", inherited.get("smooth_angle", self.angle))
        if isinstance(angle, bool) or not isinstance(angle, (int, float)):
            raise SceneError(f"{where}.smooth_angle: expected degrees, got {angle!r}")
        rec = {"kind": kind, "nodes": [], "instances": len(insts)}
        if sid is not None:
            self.records[sid] = rec
        meta = (lambda k: {"sid": sid, "inst": k}) if sid is not None else (lambda k: None)

        if "group" in spec:
            children = spec["group"] or []
            if not isinstance(children, list):
                raise SceneError(f"{where}.group must be a list of objects")
            passed = {"material": material, "smooth_angle": angle}
            if spec.get("shading"):
                passed["shading"] = shading
            for k, inst in enumerate(insts):
                gnode = node if k == 0 else self.unique(f"{node}#{k + 1}")
                self.scene.graph.update(frame_from=parent, frame_to=gnode, matrix=local @ inst if len(insts) > 1 else local, metadata=meta(k))
                rec["nodes"].append(gnode)
                for i, child in enumerate(children):
                    # only the first copy of a repeated group is editable; the others are built from the same text
                    self.add_object(child, gnode, f"{where}.group[{i}]", [*path, "group", i] if (path is not None and k == 0) else None, passed)
            return

        parts = self.parts(spec, where, material, path)
        geoms = []
        tris = 0
        lo, hi = None, None
        for j, (mesh, mat_key) in enumerate(parts):
            mesh = self.modified(mesh, spec, where)
            if not len(mesh.faces):
                continue
            b = np.asarray(mesh.bounds)
            lo = b[0] if lo is None else np.minimum(lo, b[0])
            hi = b[1] if hi is None else np.maximum(hi, b[1])
            if mat_key != "__keep__":
                try:
                    mat, mspec = self.mats.get(mat_key if mat_key is not None else "default", f"{node}-material")
                    mesh = apply_material(mesh, mat, mspec, spec.get("uv"), shading, float(angle), self.warnings, where)
                except PackError as e:
                    raise SceneError(f"{where}: material: {e}") from None
                except ValueError as e:
                    raise SceneError(f"{where}: {e}") from None
            else:
                mesh = uvmap.ensure_normals(mesh, float(angle))
            tris += len(mesh.faces)
            gname = self.unique(f"{node}.mesh{j}" if len(parts) > 1 else f"{node}.mesh")
            geoms.append((mesh, gname))
        if not geoms:
            raise SceneError(f"{where}: no geometry (the shape is empty)")
        rec["triangles"] = int(tris)
        rec["bounds"] = [[round(float(x), 5) for x in lo], [round(float(x), 5) for x in hi]]
        pos = translation_matrix(local[:3, 3])
        rs = local.copy()
        rs[:3, 3] = 0
        for k, inst in enumerate(insts):
            inode = node if k == 0 else self.unique(f"{node}#{k + 1}")
            # scatter: random spot around the object's position; repeat: steps in the object's own frame
            matrix = (pos @ inst @ rs) if spec.get("scatter") else (local @ inst)
            self.scene.graph.update(frame_from=parent, frame_to=inode, matrix=matrix, metadata=meta(k))
            rec["nodes"].append(inode)
            for mesh, gname in geoms:
                child = self.unique(f"{inode}/{gname.split('.')[-1]}")
                if k == 0:
                    self.scene.add_geometry(mesh, node_name=child, geom_name=gname, parent_node_name=inode)
                else:  # instance: reuse the same mesh
                    self.scene.graph.update(frame_from=inode, frame_to=child, matrix=np.eye(4), geometry=gname)
            self.instances += 1


def _bounds(mesh) -> list | None:
    if not len(mesh.vertices):
        return None
    b = np.asarray(mesh.bounds)
    return [[round(float(x), 5) for x in b[0]], [round(float(x), 5) for x in b[1]]]


def parse_text(text: str, name: str = "scene") -> dict:
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise SceneError(f"{name}: YAML syntax error: {e}") from None
    if not isinstance(data, dict):
        raise SceneError("a scene file must be a mapping with scene/materials/objects")
    return data


def load_yaml(path: Path) -> dict:
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        raise SceneError(f"file not found: {path}") from None
    except UnicodeDecodeError:
        raise SceneError(f"{path} is not a text file") from None
    return parse_text(text, path.name)


@dataclass
class Built:
    scene: trimesh.Scene
    info: dict
    warnings: list[str]
    builder: Builder
    data: dict


def build_text(text: str, path: str | Path, tolerant: bool = False) -> Built:
    """Build the scene written in `text`; `path` is where the file is (or will be) — its name and folder."""
    path = Path(path)
    data = parse_text(text, path.name)
    registry.load_builtins()
    registry.load_project_plugins()
    project = registry.project_dir()
    b = Builder(data, project, path.parent.resolve(), tolerant)
    for err in registry.PLUGIN_ERRORS:
        b.warnings.append(f'plugin {err["file"]} failed to load: {err["error"]}')
    unknown = [k for k in data if k not in TOP_KEYS]
    if unknown:
        b.warnings.append(f"ignored top-level keys: {', '.join(sorted(map(str, unknown)))}{_suggest(unknown[0], TOP_KEYS)}")
    mats = data.get("materials") or {}
    if not isinstance(mats, dict):
        raise SceneError("materials: must be a mapping of name → definition")
    for name, spec in mats.items():
        try:
            b.mats.define(str(name), spec)
        except (ValueError, PackError) as e:
            if not tolerant:
                raise SceneError(f"materials.{name}: {e}") from None
            b.errors.append({"id": f"materials.{name}", "where": f"materials.{name}", "error": f"materials.{name}: {e}"})
    objects = data.get("objects") or []
    if not isinstance(objects, list):
        raise SceneError("objects: must be a list, e.g.  objects: [ { shape: box, size: [1, 1, 1] } ]")
    if not objects and not tolerant:
        raise SceneError("objects: add at least one object, e.g.  objects: [ { shape: box, size: [1, 1, 1] } ]")
    for i, spec in enumerate(objects):
        b.add_object(spec, b.scene.graph.base_frame, f"objects[{i}]", ["objects", i])
    scene_opts = data.get("scene") if isinstance(data.get("scene"), dict) else {}
    info = {
        "name": str(scene_opts.get("name") or path.name.split(".")[0]),
        "objects": b.objects,
        "instances": b.instances,
        "camera": data.get("camera") if isinstance(data.get("camera"), dict) else None,
    }
    return Built(b.scene, info, b.warnings + [w for w in registry.WARNINGS if w not in b.warnings], b, data)


def build_scene(path: str | Path) -> tuple[trimesh.Scene, dict, list[str]]:
    path = Path(path)
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        raise SceneError(f"file not found: {path}") from None
    except UnicodeDecodeError:
        raise SceneError(f"{path} is not a text file") from None
    built = build_text(text, path)
    return built.scene, built.info, built.warnings


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------
def export_glb(built: Built, source: str | None = None) -> bytes:
    """Binary glTF with normals; samplers, strengths and where the model came from are added to the header."""
    options = built.builder.mats.options

    def post(tree: dict) -> None:
        samplers: dict[str, int] = {}
        used: set[str] = set()
        for m in tree.get("materials", []):
            opt = options.get(m.get("name"))
            if not opt:
                continue
            pbr = m.get("pbrMetallicRoughness", {})
            refs = [pbr.get("baseColorTexture"), pbr.get("metallicRoughnessTexture"), m.get("normalTexture"), m.get("emissiveTexture"), m.get("occlusionTexture")]
            if opt.get("sampler"):
                key = repr(sorted(opt["sampler"].items()))
                if key not in samplers:
                    samplers[key] = len(tree.setdefault("samplers", []))
                    tree["samplers"].append(dict(opt["sampler"]))
                for ref in refs:
                    if ref is not None:
                        tree["textures"][ref["index"]]["sampler"] = samplers[key]
            if "occlusion_strength" in opt and m.get("occlusionTexture"):
                m["occlusionTexture"]["strength"] = opt["occlusion_strength"]
            if "emissive_strength" in opt:
                m.setdefault("extensions", {})["KHR_materials_emissive_strength"] = {"emissiveStrength": opt["emissive_strength"]}
                used.add("KHR_materials_emissive_strength")
        if used:
            tree["extensionsUsed"] = sorted(set(tree.get("extensionsUsed", [])) | used)
        asset = tree.setdefault("asset", {"version": "2.0"})
        asset["generator"] = f"studio-3d {__version__}"
        if source:
            asset.setdefault("extras", {})["studio_source"] = source

    return built.scene.export(file_type="glb", include_normals=True, tree_postprocessor=post)


def flattened(scene: trimesh.Scene) -> trimesh.Trimesh:
    """Everything as one mesh with the placements applied (for formats without a scene graph)."""
    meshes = []
    for node in scene.graph.nodes_geometry:
        tf, gname = scene.graph[node]
        m = scene.geometry[gname].copy()
        m.apply_transform(tf)
        meshes.append(trimesh.Trimesh(vertices=m.vertices, faces=m.faces, process=False))
    return trimesh.util.concatenate(meshes)


def scene_stats(scene: trimesh.Scene) -> dict:
    tris = 0
    verts = 0
    mats = set()
    textures = 0
    seen = set()
    for node in scene.graph.nodes_geometry:
        _, gname = scene.graph[node]
        g = scene.geometry[gname]
        tris += len(g.faces)
        verts += len(g.vertices)
        mat = getattr(getattr(g, "visual", None), "material", None)
        if mat is not None and getattr(mat, "name", None):
            mats.add(mat.name)
            if id(mat) not in seen:
                seen.add(id(mat))
                textures += sum(1 for k in ("baseColorTexture", "normalTexture", "metallicRoughnessTexture", "occlusionTexture", "emissiveTexture")
                                if getattr(mat, k, None) is not None)
    if len(scene.geometry):
        b = scene.bounds
        size = (b[1] - b[0]).tolist()
        bounds = {"min": [round(x, 3) + 0.0 for x in b[0]], "max": [round(x, 3) + 0.0 for x in b[1]], "size": [round(x, 3) + 0.0 for x in size]}
    else:
        bounds = None
    return {"triangles": int(tris), "vertices": int(verts), "meshes": len(scene.geometry), "nodes": len(scene.graph.nodes_geometry),
            "materials": sorted(mats), "textures": textures, "bounds": bounds}
