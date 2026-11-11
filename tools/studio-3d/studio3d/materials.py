"""PBR materials: built-in presets, scene definitions, pack materials, texture maps."""
from __future__ import annotations

import difflib
import json
import re
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial

from . import uv as uvmap
from .textures import MAPS, TextureError, TextureLib, gray_image, normal_from_height, pack_orm

PRESETS: dict[str, dict] = {
    "white": {"color": "#f2f2f2", "roughness": 0.6}, "black": {"color": "#1b1b1b", "roughness": 0.6},
    "gray": {"color": "#8c8c8c", "roughness": 0.7}, "red": {"color": "#c0392b", "roughness": 0.5},
    "green": {"color": "#3f9b4a", "roughness": 0.6}, "blue": {"color": "#2e6fd1", "roughness": 0.5},
    "yellow": {"color": "#f1c40f", "roughness": 0.5}, "orange": {"color": "#e67e22", "roughness": 0.5},
    "purple": {"color": "#8e44ad", "roughness": 0.5}, "pink": {"color": "#f48fb1", "roughness": 0.5},
    "wood": {"color": "#8b5a2b", "roughness": 0.8}, "dark-wood": {"color": "#4e3320", "roughness": 0.8},
    "bark": {"color": "#5a3d26", "roughness": 0.95}, "leaves": {"color": "#3d7a34", "roughness": 0.85},
    "grass": {"color": "#4f8a3a", "roughness": 0.95}, "dirt": {"color": "#6b4f36", "roughness": 1.0},
    "sand": {"color": "#d8c38f", "roughness": 0.95}, "snow": {"color": "#f4f7fb", "roughness": 0.7},
    "stone": {"color": "#8a8a86", "roughness": 0.9}, "rock": {"color": "#6f6a63", "roughness": 0.95},
    "concrete": {"color": "#9a9a96", "roughness": 0.95}, "brick": {"color": "#9c4a32", "roughness": 0.9},
    "marble": {"color": "#e8e4dc", "roughness": 0.3}, "metal": {"color": "#b4b8bd", "metallic": 1, "roughness": 0.35},
    "steel": {"color": "#9aa0a6", "metallic": 1, "roughness": 0.4}, "iron": {"color": "#5a5d61", "metallic": 1, "roughness": 0.6},
    "gold": {"color": "#ffcc4d", "metallic": 1, "roughness": 0.25}, "silver": {"color": "#d9d9d9", "metallic": 1, "roughness": 0.2},
    "copper": {"color": "#c8754b", "metallic": 1, "roughness": 0.3}, "chrome": {"color": "#e8e8e8", "metallic": 1, "roughness": 0.05},
    "plastic": {"color": "#e6e6e6", "roughness": 0.45}, "rubber": {"color": "#1e1e1e", "roughness": 0.95},
    "glass": {"color": "#cfe8ff", "roughness": 0.05, "opacity": 0.3}, "water": {"color": "#3b7dd8", "roughness": 0.1, "opacity": 0.7},
    "ice": {"color": "#bfe3ff", "roughness": 0.15, "opacity": 0.8}, "skin": {"color": "#e0ac8a", "roughness": 0.7},
    "fabric": {"color": "#8c3b3b", "roughness": 1.0}, "leather": {"color": "#6b3a1f", "roughness": 0.7},
    "lamp": {"color": "#fff3c4", "emissive": "#ffd27a"}, "lava": {"color": "#4a0d00", "emissive": "#ff5a00", "roughness": 0.9},
    "neon-blue": {"color": "#0b1d3a", "emissive": "#3fa9ff"}, "neon-pink": {"color": "#3a0b26", "emissive": "#ff3fb4"},
}

HEX = re.compile(r"^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$")


def parse_color(c) -> list[float]:
    if c is None:
        return [0.8, 0.8, 0.8, 1.0]
    if isinstance(c, (list, tuple)):
        vals = [float(x) for x in c]
        if any(v > 1 for v in vals):
            vals = [v / 255 for v in vals]
        return (vals + [1.0])[:4] if len(vals) == 3 else vals[:4]
    m = HEX.match(str(c).strip())
    if not m:
        raise ValueError(f'color "{c}" — use "#rrggbb", a name of a preset, or [r, g, b]')
    h = m.group(1)
    rgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    a = int(m.group(2), 16) / 255 if m.group(2) else 1.0
    return rgb + [a]


def srgb_to_linear(c: float) -> float:
    """glTF stores colour factors in linear space; designers think in sRGB hex."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


MAT_KEYS = (
    "name", "use", "color", "roughness", "metallic", "emissive", "emissive_strength", "opacity", "alpha", "alpha_cutoff", "double_sided",
    "texture", "normal_map", "bump_map", "bump", "roughness_map", "metallic_map", "emissive_map", "occlusion_map", "occlusion",
    "uv", "texture_scale", "texture_repeat", "texture_offset", "texture_rotation", "texture_filter", "texture_wrap",
)
MAP_KEYS = tuple(MAPS)
ALPHA = {"opaque": "OPAQUE", "blend": "BLEND", "cutout": "MASK", "mask": "MASK"}
WRAP = {"repeat": 10497, "clamp": 33071, "mirror": 33648}
DEFAULT = {"color": "#cfd3da", "roughness": 0.6}


def _merge(base: dict, spec: dict) -> dict:
    """A material built on another one: its own texture replaces the inherited plain color (give both to tint)."""
    out = {**base, **spec}
    if "texture" in spec and "color" not in spec and "texture" not in base:
        out.pop("color", None)
    return out


def _num(spec: dict, key: str, default: float, lo: float | None = None, hi: float | None = None) -> float:
    v = spec.get(key)
    if v is None:
        return float(default)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{key}: expected a number, got {v!r}")
    v = float(v)
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def has_maps(spec: dict) -> bool:
    return any(spec.get(k) not in (None, "", False) for k in MAP_KEYS)


def flat_uv(spec: dict) -> dict:
    """The texture_* options of a material as UV settings."""
    return {"scale": spec.get("texture_scale"), "repeat": spec.get("texture_repeat"), "offset": spec.get("texture_offset"),
            "rotation": spec.get("texture_rotation")}


def to_hex(c) -> str:
    r, g, b = (max(0, min(255, int(round(x * 255)))) for x in parse_color(c)[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


class MaterialLib:
    def __init__(self, project: Path, warnings: list[str], base_dir: Path | None = None, texture_max: int = 2048, jpeg: bool = False):
        self.project = project
        self.warnings = warnings
        self.defs: dict[str, dict] = {}
        self.cache: dict[str, tuple[PBRMaterial, dict]] = {}
        self.options: dict[str, dict] = {}  # material name -> what the exporter adds (sampler, strengths)
        self.used: dict[str, dict] = {}  # material name -> resolved spec (for the editor)
        self.tex = TextureLib(project, warnings, base_dir, texture_max, jpeg)
        self._warned: set[str] = set()

    def define(self, name: str, spec) -> None:
        self.defs[name] = self._resolve_spec(spec, name, self.project)

    def _resolve_spec(self, spec, name: str, base: Path, depth: int = 0) -> dict:
        if depth > 5:
            raise ValueError(f'material "{name}": too many nested references')
        if isinstance(spec, str):
            spec = {"use": spec} if not HEX.match(spec) else {"color": spec}
        if spec is not None and not isinstance(spec, dict):
            raise ValueError(f'material "{name}": expected a mapping, a preset name or a "#rrggbb" color, got {spec!r}')
        spec = dict(spec or {})
        use = spec.pop("use", None)
        if use:
            use = str(use)
            if use in PRESETS:
                return _merge(PRESETS[use], spec)
            from studio_packs import is_ref, resolve

            if is_ref(use):
                pack, item, path = resolve(use)
                if item.get("kind") != "material":
                    raise ValueError(f'"{use}" is a {item.get("kind")}, not a material')
                data = json.loads(path.read_text("utf-8")) if path else dict(item.get("meta") or {})
                data.pop("name", None)  # the scene's name for it counts (the pack file's name is only its id)
                resolved = self._resolve_spec(data, name, path.parent if path else base, depth + 1)
                if path and has_maps(resolved):
                    resolved.setdefault("_dir", str(path.parent))  # files of the pack material are relative to it
                return _merge(resolved, spec)
            if use in self.defs:
                return _merge(self.defs[use], spec)
            close = difflib.get_close_matches(use, [*self.defs, *PRESETS], n=3)
            hint = f" — did you mean {', '.join(close)}?" if close else f" (presets: {', '.join(sorted(PRESETS))}; or pack-id/item-id)"
            raise ValueError(f'material "{name}": unknown "{use}"{hint}')
        return spec

    def lookup(self, name_or_spec, name_hint: str = "material") -> tuple[str, dict, str]:
        """(cache key, resolved spec, display name) of a material reference."""
        if isinstance(name_or_spec, dict):
            spec = self._resolve_spec(name_or_spec, "inline", self.project)
            return "inline:" + json.dumps(spec, sort_keys=True, default=str), spec, str(spec.get("name") or name_hint)
        key = str(name_or_spec or "default")
        if key in self.defs:
            spec = self.defs[key]
        elif key in PRESETS:
            spec = PRESETS[key]
        elif HEX.match(key):
            spec = {"color": key}
        elif key == "default":
            spec = DEFAULT
        elif "/" in key:  # pack material used directly: material: basic-3d/granite
            try:
                spec = self._resolve_spec({"use": key}, key, self.project)
            except Exception as e:  # noqa: BLE001
                self.warnings.append(f'material "{key}": {e} — using default gray')
                spec = DEFAULT
            self.defs[key] = spec
            return key, spec, str(spec.get("name") or key.rsplit("/", 1)[-1])
        else:
            close = difflib.get_close_matches(key, [*self.defs, *PRESETS], n=3)
            hint = f" — did you mean {', '.join(close)}?" if close else " (define it under materials: or use a preset: studio-3d materials)"
            msg = f'unknown material "{key}"{hint} — using default gray'
            if msg not in self._warned:
                self._warned.add(msg)
                self.warnings.append(msg)
            spec = DEFAULT
        return key, spec, str(spec.get("name") or key)

    def get(self, name_or_spec, name_hint: str = "material") -> tuple[PBRMaterial, dict]:
        key, spec, label = self.lookup(name_or_spec, name_hint)
        if key in self.cache:
            return self.cache[key]
        try:
            mat = self._build(spec, label)
        except TextureError as e:
            raise ValueError(str(e)) from None
        except (ValueError, TypeError) as e:
            raise ValueError(f'material "{label}": {e}') from None
        self.cache[key] = (mat, spec)
        self.used[label] = spec
        return mat, spec

    # -- one material -----------------------------------------------------------------
    def _color_map(self, spec: dict, key: str, where: str, base: Path | None, pixel: bool = False):
        src = spec.get(key)
        if src in (None, "", False):
            return None
        try:
            return self.tex.color(src, f"{where}: {key}", base, pixel)
        except TextureError as e:
            self.warnings.append(f"{e} — the material is built without it")
            return None

    def _gray_map(self, spec: dict, key: str, where: str, base: Path | None, src=None):
        src = spec.get(key) if src is None else src
        if src in (None, "", False):
            return None
        try:
            return self.tex.gray(src, f"{where}: {key}", base)
        except TextureError as e:
            self.warnings.append(f"{e} — the material is built without it")
            return None

    def _build(self, spec: dict, label: str) -> PBRMaterial:
        where = f'material "{label}"'
        base = Path(spec["_dir"]) if spec.get("_dir") else None
        for k in spec:
            if k not in MAT_KEYS and not str(k).startswith("_"):
                close = difflib.get_close_matches(str(k), MAT_KEYS, n=2)
                msg = f'{where}: unknown option "{k}"' + (f" — did you mean {', '.join(close)}?" if close else " (studio-3d docs: Materials)")
                if msg not in self._warned:
                    self._warned.add(msg)
                    self.warnings.append(msg)
        filt = str(spec.get("texture_filter") or "linear").lower()
        if filt == "pixel":
            filt = "nearest"
        if filt not in ("linear", "nearest"):
            raise ValueError(f'texture_filter: "{filt}" — linear (smooth) or nearest (pixel art)')
        uvs = uvmap.mapping(flat_uv(spec), spec.get("uv"))  # raises on a wrong projection / option
        wrap = spec.get("texture_wrap")
        if wrap is None and uvs["projection"] == "fit" and not uvs["repeat"]:
            wrap = "clamp"
        if wrap is not None and str(wrap).lower() not in WRAP:
            raise ValueError(f'texture_wrap: "{wrap}" — repeat, clamp or mirror')

        tex = self._color_map(spec, "texture", where, base, filt == "nearest")
        color = parse_color(spec.get("color") if (spec.get("color") is not None or tex is None) else "#ffffff")
        opacity = _num(spec, "opacity", color[3], 0, 1)
        alpha = spec.get("alpha")
        if alpha is None:
            mode = "OPAQUE"
            if opacity < 0.999:
                mode = "BLEND"
            elif tex is not None and tex.mode == "RGBA":
                a = np.asarray(tex.getchannel("A"))
                soft = float(((a > 16) & (a < 240)).mean())
                mode = "BLEND" if soft > 0.02 else "MASK"
        else:
            mode = ALPHA.get(str(alpha).lower())
            if mode is None:
                raise ValueError(f'alpha: "{alpha}" — opaque, blend (see-through) or cutout (holes with hard edges)')

        normal = self._color_map(spec, "normal_map", where, base)
        if normal is not None:
            normal = normal.convert("RGB")
        else:
            strength = spec.get("bump")
            if isinstance(strength, bool):
                strength = 1.0 if strength else 0.0
            if strength is not None and not isinstance(strength, (int, float)):
                raise ValueError(f"bump: expected a strength (0 = flat, 1 = normal, 3 = deep), got {strength!r}")
            src = spec.get("bump_map") or (spec.get("texture") if strength else None)
            if src and (strength is None or float(strength) != 0):
                height = self._gray_map(spec, "bump_map", where, base, src)
                if height is not None:
                    normal = normal_from_height(height, 1.0 if strength is None else float(strength))

        rough = self._gray_map(spec, "roughness_map", where, base)
        metal = self._gray_map(spec, "metallic_map", where, base)
        orm = pack_orm(rough, metal) if (rough is not None or metal is not None) else None
        occl = self._gray_map(spec, "occlusion_map", where, base)
        glow = self._color_map(spec, "emissive_map", where, base)
        if spec.get("emissive"):
            emissive = [srgb_to_linear(c) for c in parse_color(spec["emissive"])[:3]]
        else:
            emissive = [1.0, 1.0, 1.0] if glow is not None else [0.0, 0.0, 0.0]

        linear = [srgb_to_linear(c) for c in color[:3]]
        mat = PBRMaterial(
            name=label,
            baseColorFactor=[int(round(c * 255)) for c in linear] + [int(round(opacity * 255))],
            metallicFactor=_num(spec, "metallic", 1.0 if metal is not None else 0.0, 0, 1),
            roughnessFactor=_num(spec, "roughness", 1.0 if rough is not None else 0.6, 0, 1),
            emissiveFactor=emissive,
            alphaMode=mode,
            alphaCutoff=_num(spec, "alpha_cutoff", 0.5, 0, 1) if mode == "MASK" else None,
            doubleSided=bool(spec.get("double_sided", mode != "OPAQUE")),
            baseColorTexture=tex,
            normalTexture=normal,
            metallicRoughnessTexture=orm,
            occlusionTexture=gray_image(occl) if occl is not None else None,
            emissiveTexture=glow.convert("RGB") if glow is not None else None,
        )
        opts: dict = {}
        sampler: dict = {}
        if filt == "nearest":
            sampler.update(magFilter=9728, minFilter=9728)
        if wrap is not None and WRAP[str(wrap).lower()] != 10497:
            sampler.update(wrapS=WRAP[str(wrap).lower()], wrapT=WRAP[str(wrap).lower()])
        if sampler:
            opts["sampler"] = sampler
        strength = _num(spec, "emissive_strength", 1.0, 0, 1000)
        if strength != 1.0:
            opts["emissive_strength"] = strength
        if occl is not None and spec.get("occlusion") is not None:
            opts["occlusion_strength"] = _num(spec, "occlusion", 1.0, 0, 1)
        if opts:
            self.options[label] = opts
        return mat

    def summary(self, spec: dict) -> dict:
        """What the editor shows of a resolved material (swatch, sliders, which maps it has)."""
        out: dict = {"maps": [k for k in MAP_KEYS if spec.get(k) not in (None, "", False)]}
        try:
            out["color"] = to_hex(spec.get("color") if (spec.get("color") is not None or "texture" not in out["maps"]) else "#ffffff")
        except ValueError:
            out["color"] = "#cfd3da"
        for k, d in (("roughness", 0.6), ("metallic", 0.0), ("opacity", 1.0)):
            v = spec.get(k)
            out[k] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else d
        if spec.get("emissive"):
            try:
                out["emissive"] = to_hex(spec["emissive"])
            except ValueError:
                pass
        return out


def is_textured(mat) -> bool:
    return any(getattr(mat, k, None) is not None for k in ("baseColorTexture", "normalTexture", "metallicRoughnessTexture", "occlusionTexture", "emissiveTexture"))


def apply_material(mesh: trimesh.Trimesh, mat: PBRMaterial, spec: dict, uv_override=None, shading: str = "auto",
                   angle: float = uvmap.DEFAULT_ANGLE, warnings: list[str] | None = None, where: str = "") -> trimesh.Trimesh:
    """The final mesh of an object part: normals, UVs (when the material has a texture or the object asks for them), material."""
    uvs = None
    if is_textured(mat) or uv_override not in (None, False):
        uvs = uvmap.mapping(flat_uv(spec), spec.get("uv"), uv_override if uv_override is not True else None)
    return uvmap.finish(mesh, mat, uvs, shading, angle, warnings, where)
