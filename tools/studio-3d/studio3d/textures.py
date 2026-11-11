"""Texture sources of materials — studio-3d works together with studio-image here.

A texture (the `texture:` of a material and every map: normal_map, bump_map, roughness_map,
metallic_map, emissive_map, occlusion_map) is one of

  assets/wall.png                    an image file of the project (png, jpg, webp …)
  src/wall.image.yaml                a studio-image picture — rendered while the scene is built
  some-pack/planks                   a pack item (an image or a picture)
  bricks                             a procedural texture of studio-image by name (studio-3d textures)
  { type: bricks, colors: ["#5b2a1e", "#b5563c"], resolution: 512, seed: 2, mortar: 6, filters: [...] }
  { layers: [...], size: [512, 256] }   a whole picture written inline (studio-image layers)

`resolution` is the size of the generated picture in pixels (a number or [width, height], default 512);
every other option of a procedural texture is one of its own parameters.

Procedural textures and pictures are made by studio-image itself (its plugins in plugins/image/
included), so everything that tool learns is a 3D texture as well.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TOOLS = Path(__file__).resolve().parents[2]
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tga", ".tif", ".tiff")
PICTURE_EXT = (".image.yaml", ".image.yml")
LAYER_KEYS = {"layers", "size", "resolution", "background", "palette", "seed", "filters", "use", "antialias"}
MAPS = {
    "texture": "the color of the surface (multiplied with `color`)",
    "normal_map": "fine relief as a tangent-space normal map (bluish picture)",
    "bump_map": "relief from a height picture (white = high) — turned into a normal map; strength: `bump`",
    "roughness_map": "where the surface is rough (white) or glossy (black)",
    "metallic_map": "where the surface is metal (white)",
    "emissive_map": "what glows (colors; black = no glow)",
    "occlusion_map": "baked soft shadows in crevices (black = dark)",
}


class TextureError(Exception):
    pass


def cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return Path(base) / "studio-3d"


def prune(folder: Path, keep: int) -> None:
    """Keep the newest `keep` files of a cache folder."""
    try:
        files = sorted((f for f in folder.iterdir() if f.is_file()), key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return
    for f in files[keep:]:
        try:
            f.unlink()
        except OSError:
            pass


def studio_image():
    """The sibling tool (procedural textures, pictures). Raises TextureError when it is missing."""
    p = str(TOOLS / "studio-image")
    if p not in sys.path:
        sys.path.insert(0, p)
    try:
        from studio_image import compose, registry
    except Exception as e:  # noqa: BLE001
        raise TextureError(f"procedural textures and pictures need studio-image ({type(e).__name__}: {e})") from None
    return compose, registry


_proc_cache: list[dict] | None = None


def procedural() -> list[dict]:
    """Every procedural texture studio-image knows (built-in + plugins/image/*.py of the project)."""
    global _proc_cache
    if _proc_cache is None:
        try:
            _compose, registry = studio_image()
            registry.load_builtins()
            registry.load_project_plugins()
            _proc_cache = [{"name": e.name, "doc": e.doc.split("\n")[0], "params": dict(e.params), "source": e.source} for e in registry.TEXTURES.values()]
        except Exception:  # noqa: BLE001
            _proc_cache = []
    return _proc_cache


def plugin_errors() -> list[dict]:
    try:
        _compose, registry = studio_image()
        return list(registry.PLUGIN_ERRORS)
    except TextureError:
        return []


def kind_of(src) -> str:
    """file | picture | pack | procedural | layers | none — what a texture source is (for listings and the editor)."""
    if src in (None, "", False):
        return "none"
    if isinstance(src, dict):
        return "layers" if "layers" in src else "procedural"
    s = str(src)
    low = s.lower()
    if low.endswith(PICTURE_EXT):
        return "picture"
    if low.endswith(IMAGE_EXT):
        return "file"
    if "/" not in s and "." not in s:
        return "procedural"
    return "pack" if "/" in s and "." not in s.rsplit("/", 1)[-1] else "file"


class _Jpeg(Image.Image):
    """An image the .glb exporter writes as a JPEG of good quality (it calls save() without options)."""

    def save(self, fp, format=None, **params):  # noqa: A002
        params.setdefault("quality", 90)
        return super().save(fp, format, **params)


def as_jpeg(img: Image.Image) -> Image.Image:
    out = img.convert("RGB")
    out.__class__ = _Jpeg
    out.format = "JPEG"
    return out


def _simple(v) -> bool:
    """True when a value cannot point at a file (so the result only depends on the text of the spec)."""
    if isinstance(v, (bool, int, float)) or v is None:
        return True
    if isinstance(v, str):
        return "/" not in v and "\\" not in v and not v.lower().endswith(IMAGE_EXT + PICTURE_EXT + (".ttf", ".otf"))
    if isinstance(v, (list, tuple)):
        return all(_simple(x) for x in v)
    if isinstance(v, dict):
        return all(_simple(x) for x in v.values())
    return False


class TextureLib:
    def __init__(self, project: Path, warnings: list[str], base_dir: Path | None = None, max_size: int = 2048, jpeg: bool = False):
        self.project = Path(project)
        self.base_dir = Path(base_dir) if base_dir else self.project
        self.warnings = warnings
        self.max_size = max(16, int(max_size))
        self.jpeg = jpeg
        self.cache: dict[str, Image.Image] = {}

    # -- public ---------------------------------------------------------------------
    def image(self, src, where: str, base: Path | None = None) -> Image.Image:
        """The picture of a texture source. Raises TextureError with a message that says what to change."""
        key = json.dumps([src, str(base or "")], sort_keys=True, default=str)
        if key not in self.cache:
            img = self._load(src, where, base)
            if max(img.size) > self.max_size:
                k = self.max_size / max(img.size)
                was = img.size
                fmt = img.format
                img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
                if fmt == "JPEG":
                    img = as_jpeg(img)
                self.warnings.append(f"{where}: the texture is {was[0]}×{was[1]} px — scaled to {img.width}×{img.height} (scene: texture_max: {self.max_size})")
            self.cache[key] = img
        return self.cache[key]

    def color(self, src, where: str, base: Path | None = None, pixel: bool = False) -> Image.Image:
        """A color map: RGB when nothing is transparent, RGBA otherwise; JPEG when the scene asks for small files."""
        img = self.image(src, where, base)
        if img.format == "JPEG" and img.mode in ("RGB", "L"):
            return img
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if ("A" in img.mode or "transparency" in img.info) else "RGB")
        if img.mode == "RGBA" and img.getextrema()[3][0] == 255:
            img = img.convert("RGB")
        if self.jpeg and img.mode == "RGB" and not pixel and min(img.size) >= 64:
            return as_jpeg(img)
        return img

    def gray(self, src, where: str, base: Path | None = None) -> np.ndarray:
        """A map read as one value per pixel, 0 … 1 (brightness)."""
        img = self.image(src, where, base)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
            img = Image.alpha_composite(bg, img)
        return np.asarray(img.convert("L"), dtype=np.float32) / 255.0

    # -- sources --------------------------------------------------------------------
    def _load(self, src, where: str, base: Path | None) -> Image.Image:
        if isinstance(src, dict):
            return self._inline(src, where)
        if not isinstance(src, str) or not src.strip():
            raise TextureError(f"{where}: expected a file, a texture name or a mapping, got {src!r}")
        s = src.strip()
        p = Path(s)
        candidates = [p] if p.is_absolute() else [(base / s) if base else None, self.project / s, self.base_dir / s]
        for c in candidates:
            if c is not None and c.is_file():
                return self._file(c.resolve(), where)
        if "/" not in s and "." not in s:
            return self._inline({"type": s}, where)
        from studio_packs import PackError, is_ref, resolve

        if is_ref(s) and not s.lower().endswith(IMAGE_EXT + PICTURE_EXT):
            try:
                _pack, item, path = resolve(s)
            except PackError as e:
                raise TextureError(f"{where}: {e}") from None
            if path is None or not path.is_file():
                raise TextureError(f'{where}: pack item "{s}" has no file')
            if item.get("kind") == "material":
                raise TextureError(f'{where}: "{s}" is a material — use it as the material itself (material: {s}), not as a texture')
            return self._file(path, where)
        raise TextureError(f"{where}: file not found: {s} (paths are relative to the project folder; procedural textures: studio-3d textures)")

    def _file(self, path: Path, where: str) -> Image.Image:
        if path.name.lower().endswith(PICTURE_EXT):
            compose, _registry = studio_image()
            try:
                doc = compose.load_doc(path)
                img = doc.render()
            except compose.ImageError as e:
                raise TextureError(f"{where}: {path.name}: {e}") from None
            for w in doc.warnings:
                if not w.startswith("plugin "):
                    self.warnings.append(f"{where}: {path.name}: {w}")
            return img
        try:
            img = Image.open(path)
            img.load()
        except Exception as e:  # noqa: BLE001
            raise TextureError(f"{where}: cannot read the picture {path.name}: {e}") from None
        if img.format == "JPEG" and img.mode in ("RGB", "L"):
            return img
        return img.convert("RGBA") if (img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info) else img.convert("RGB")

    def _inline(self, spec: dict, where: str) -> Image.Image:
        spec = dict(spec)
        if "texture" in spec and "type" not in spec:  # the spelling studio-image uses for a layer
            spec["type"] = spec.pop("texture")
        # the pixel size: `resolution` (a procedural texture may have a parameter called size); an inline picture also takes `size`
        key = "resolution" if ("resolution" in spec or "layers" not in spec) else "size"
        size = spec.pop(key, 512)
        try:
            w, h = (int(size), int(size)) if isinstance(size, (int, float)) and not isinstance(size, bool) else (int(size[0]), int(size[1]))
        except (TypeError, ValueError, IndexError):
            raise TextureError(f"{where}.{key}: a number of pixels or [width, height], got {size!r}") from None
        if not (4 <= w <= 8192 and 4 <= h <= 8192):
            raise TextureError(f"{where}.{key}: between 4 and 8192 px")
        if "layers" in spec:
            spec.pop("size", None)
            bad = set(spec) - LAYER_KEYS
            if bad:
                raise TextureError(f'{where}: unknown option "{sorted(bad)[0]}" for an inline picture (options: {", ".join(sorted(LAYER_KEYS))})')
            image = {"size": [w, h], **{k: spec[k] for k in ("background", "palette", "seed", "antialias") if k in spec}}
            doc = {"image": image, "layers": spec["layers"]}
            if spec.get("filters"):
                doc["filters"] = spec["filters"]
        else:
            name = spec.pop("type", None)
            if not name:
                raise TextureError(f"{where}: a texture mapping needs `type:` (a procedural texture, see: studio-3d textures) or `layers:`")
            known = {t["name"]: t for t in procedural()}
            if known and str(name) not in known:
                close = difflib.get_close_matches(str(name), list(known), n=3)
                raise TextureError(f'{where}: unknown texture "{name}"' + (f" — did you mean {', '.join(close)}?" if close else "") + " (studio-3d textures)")
            if known:
                own = known[str(name)]["params"]
                for k in spec:
                    if k not in own and k not in ("colors", "seed", "filters", "use", "opacity", "blur"):
                        close = difflib.get_close_matches(str(k), [*own, "colors", "seed", "resolution", "filters"], n=2)
                        hint = f" — did you mean {', '.join(close)}?" if close else ""
                        if k == "size":
                            hint = " — the size of the picture in pixels is `resolution:`"
                        raise TextureError(f'{where}: texture "{name}" has no option "{k}"{hint} (it has: {", ".join(own) or "none"}; plus colors, seed, resolution, filters)')
            layer = {"texture": str(name), **{k: v for k, v in spec.items() if k != "use"}}
            doc = {"image": {"size": [w, h], "antialias": 1}, "layers": [layer]}
        if spec.get("use"):
            doc["use"] = spec["use"] if isinstance(spec["use"], list) else [spec["use"]]
        cached = self._disk_key(doc) if _simple(doc) else None
        if cached and cached.is_file():
            try:
                img = Image.open(cached)
                img.load()
                return img.convert("RGBA") if "A" in img.mode else img.convert("RGB")
            except Exception:  # noqa: BLE001
                pass
        compose, _registry = studio_image()
        try:
            d = compose.Doc(doc, self.project / "texture.image.yaml")
            img = d.render()
        except compose.ImageError as e:
            msg = str(e).replace("layers[0]: ", "").replace("layers[0].", "")
            if 'has no parameter "size"' in msg:
                msg += " — the size of the picture in pixels is `resolution:`"
            raise TextureError(f"{where}: {msg}") from None
        warned = False
        for wmsg in d.warnings:
            if not wmsg.startswith("plugin "):
                self.warnings.append(f"{where}: {wmsg}")
                warned = True
        if img.getextrema()[3][0] == 255:
            img = img.convert("RGB")
        if cached and not warned:  # a picture with a warning is made again next time, so the warning stays visible
            try:
                cached.parent.mkdir(parents=True, exist_ok=True)
                tmp = cached.with_suffix(f".{os.getpid()}.tmp")
                img.save(tmp, format="PNG")
                os.replace(tmp, cached)
                if int(cached.stat().st_mtime) % 20 == 0:
                    prune(cached.parent, 400)
            except OSError:
                pass
        return img

    def _disk_key(self, doc: dict) -> Path | None:
        """Where a purely procedural texture is kept between builds (it only depends on its text and the plugins)."""
        try:
            sig = []
            folder = self.project / "plugins" / "image"
            if folder.is_dir():
                for f in sorted(folder.glob("*.py")):
                    st = f.stat()
                    sig.append([f.name, st.st_mtime_ns, st.st_size])
            version = ""
            try:
                import studio_image

                version = getattr(studio_image, "__version__", "")
            except Exception:  # noqa: BLE001
                pass
            h = hashlib.sha1(json.dumps([doc, sig, version, 2], sort_keys=True, default=str).encode()).hexdigest()
            return cache_dir() / "textures" / f"{h[:24]}.png"
        except OSError:
            return None


# ---------------------------------------------------------------------------
# derived maps
# ---------------------------------------------------------------------------
def normal_from_height(height: np.ndarray, strength: float = 1.0) -> Image.Image:
    """A tangent-space normal map (glTF: +Y up) from a height picture (0 … 1, white = high). Tiles like the input."""
    h = np.asarray(height, dtype=np.float32)
    # a little smoothing first: hard steps (bricks, checkers) become bevels instead of one-pixel cliffs
    h = (h * 4 + np.roll(h, 1, 0) + np.roll(h, -1, 0) + np.roll(h, 1, 1) + np.roll(h, -1, 1)) / 8
    k = float(strength) * 6.0 * (h.shape[1] / 512.0)
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * k
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * k  # rows run down, v runs up
    n = np.stack([-dx, dy, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8), "RGB")


def pack_orm(rough: np.ndarray | None, metal: np.ndarray | None) -> Image.Image:
    """glTF metallicRoughnessTexture: G = roughness, B = metallic."""
    ref = rough if rough is not None else metal
    h, w = ref.shape
    out = np.full((h, w, 3), 255, dtype=np.uint8)

    def fit(a: np.ndarray) -> np.ndarray:
        if a.shape != (h, w):
            a = np.asarray(Image.fromarray((a * 255).astype(np.uint8), "L").resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0
        return np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)

    if rough is not None:
        out[..., 1] = fit(rough)
    if metal is not None:
        out[..., 2] = fit(metal)
    return Image.fromarray(out, "RGB")


def gray_image(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8), "L").convert("RGB")
