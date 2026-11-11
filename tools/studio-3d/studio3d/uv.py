"""Shading (normals) and UV mapping: the last step before a mesh goes into the .glb.

A shape is only positions and triangles. Here it gets
  * normals — `shading: auto` keeps round surfaces smooth and edges sharper than `smooth_angle`
    hard (a cylinder is round with flat caps, a box has six flat sides), `flat` = faceted low-poly,
    `smooth` = everything round;
  * texture coordinates (UVs) by projection — box, planar, cylinder, sphere, fit — or the mesh's own.
"""
from __future__ import annotations

import difflib
import math

import numpy as np
import trimesh

PROJECTIONS = {
    "box": "six-sided projection, `scale` metres per repeat — walls, floors, rocks, anything (default)",
    "planar": "flat projection along `axis` (default y = from above), `scale` metres per repeat — ground, decals",
    "cylinder": "wrapped around `axis` (default y) — bark, labels, columns; `repeat: [around, up]`",
    "sphere": "wrapped like a globe around `axis` (default y) — planets, balls, eyes; `repeat: [around, up]`",
    "fit": "the picture exactly once over the object, seen along `axis` (default z = front) — signs, posters, screens",
    "mesh": "the UVs the model already has (imported models, plugins that make their own)",
}
ALIASES = {"triplanar": "box", "cube": "box", "flat": "planar", "plane": "planar", "cylindrical": "cylinder", "tube": "cylinder",
           "spherical": "sphere", "globe": "sphere", "stretch": "fit", "own": "mesh", "keep": "mesh", "none": "mesh"}
UV_KEYS = ("projection", "axis", "scale", "repeat", "offset", "rotation")
SHADING = ("auto", "flat", "smooth")
DEFAULT_ANGLE = 40.0
_AXES = {"x": 0, "y": 1, "z": 2}


class UVError(ValueError):
    pass


def _pair(v, name: str) -> list[float]:
    if isinstance(v, bool):
        raise UVError(f"{name}: expected a number or [u, v]")
    if isinstance(v, (int, float)):
        return [float(v), float(v)]
    try:
        out = [float(x) for x in v]
    except (TypeError, ValueError):
        raise UVError(f"{name}: expected a number or [u, v], got {v!r}") from None
    if len(out) != 2:
        raise UVError(f"{name}: expected a number or [u, v], got {v!r}")
    return out


def mapping(*layers) -> dict:
    """Merge UV settings (later wins). Each layer is None, a projection name or a mapping with UV_KEYS."""
    out: dict = {"projection": None, "axis": None, "scale": [1.0, 1.0], "repeat": None, "offset": [0.0, 0.0], "rotation": 0.0}
    for layer in layers:
        if layer is None or layer is False:
            continue
        if isinstance(layer, str):
            layer = {"projection": layer}
        if not isinstance(layer, dict):
            raise UVError(f"uv: expected a projection name or a mapping, got {layer!r}")
        for k, v in layer.items():
            if k not in UV_KEYS:
                close = difflib.get_close_matches(str(k), UV_KEYS, n=2)
                raise UVError(f'uv: unknown option "{k}"' + (f" — did you mean {', '.join(close)}?" if close else f" (options: {', '.join(UV_KEYS)})"))
            if v is None:
                continue
            if k == "projection":
                name = str(v).lower().strip()
                axis = None
                if "-" in name and name.rsplit("-", 1)[1] in _AXES:  # planar-x, fit-z, cylinder-x
                    name, axis = name.rsplit("-", 1)
                name = ALIASES.get(name, name)
                if name not in PROJECTIONS:
                    close = difflib.get_close_matches(name, list(PROJECTIONS), n=2)
                    raise UVError(f'uv: unknown projection "{v}"' + (f" — did you mean {', '.join(close)}?" if close else f" (one of {', '.join(PROJECTIONS)})"))
                out["projection"] = name
                if axis:
                    out["axis"] = axis
            elif k == "axis":
                a = str(v).lower()
                if a not in _AXES:
                    raise UVError(f'uv.axis: "{v}" — x, y or z')
                out["axis"] = a
            elif k == "rotation":
                try:
                    out["rotation"] = float(v)
                except (TypeError, ValueError):
                    raise UVError(f"uv.rotation: expected degrees, got {v!r}") from None
            elif k == "scale":
                s = _pair(v, "uv.scale")
                if min(abs(s[0]), abs(s[1])) < 1e-9:
                    raise UVError("uv.scale: must not be 0 (metres per repeat of the texture)")
                out["scale"] = s
            else:
                out[k] = _pair(v, f"uv.{k}")
    return out


# ---------------------------------------------------------------------------
# normals
# ---------------------------------------------------------------------------
def _unit(n: np.ndarray) -> np.ndarray:
    length = np.linalg.norm(n, axis=1, keepdims=True)
    out = np.divide(n, length, out=np.zeros_like(n, dtype=np.float64), where=length > 1e-12)
    out[(length <= 1e-12).ravel()] = [0.0, 1.0, 0.0]
    return out


def corners(mesh: trimesh.Trimesh, shading: str = "auto", angle: float = DEFAULT_ANGLE):
    """Per-corner data after the shading rule: positions (3F, 3), normals (3F, 3), face normals (3F, 3), own UVs or None."""
    own_uv = getattr(getattr(mesh, "visual", None), "uv", None)
    if own_uv is not None and len(own_uv) != len(mesh.vertices):
        own_uv = None
    m = mesh
    if shading == "smooth":
        if own_uv is None:
            m = mesh.copy()
            m.merge_vertices()
    elif shading == "auto":
        try:
            m = trimesh.graph.smooth_shade(mesh, angle=math.radians(float(angle)), facet_minarea=None)
        except Exception:  # noqa: BLE001  (degenerate input: fall back to the mesh as it is)
            m = mesh
        own_uv = getattr(getattr(m, "visual", None), "uv", None) if own_uv is not None else None
        if own_uv is not None and len(own_uv) != len(m.vertices):
            own_uv = None
    idx = np.asarray(m.faces).reshape(-1)
    P = np.asarray(m.vertices, dtype=np.float64)[idx]
    FN = np.repeat(_unit(np.asarray(m.face_normals, dtype=np.float64)), 3, axis=0)
    N = FN if shading == "flat" else _unit(np.asarray(m.vertex_normals, dtype=np.float64)[idx])
    UV = np.asarray(own_uv, dtype=np.float64)[idx] if own_uv is not None else None
    return P, N, FN, UV


# ---------------------------------------------------------------------------
# UV projections (per corner, so seams never smear)
# ---------------------------------------------------------------------------
def _frame(P: np.ndarray, FN: np.ndarray, axis: str):
    """Coordinates with `axis` as the up direction: (a, up, b, face-normal up component)."""
    if axis == "y":
        return P[:, 0], P[:, 1], P[:, 2], FN[:, 1]
    if axis == "x":
        return P[:, 1], P[:, 0], P[:, 2], FN[:, 0]
    return P[:, 0], P[:, 2], -P[:, 1], FN[:, 2]


def _unwrap(u: np.ndarray, on_axis: np.ndarray) -> np.ndarray:
    """Fix the seam (a face must not run backwards through the whole texture) and corners on the axis."""
    t = u.reshape(-1, 3).copy()
    ax = on_axis.reshape(-1, 3)
    # the seam, judged by the corners that have an angle
    lo = np.where(ax, np.inf, t).min(axis=1)
    hi = np.where(ax, -np.inf, t).max(axis=1)
    lift = ((hi - lo) > 0.5)[:, None] & (t < 0.5) & ~ax
    t = np.where(lift, t + 1.0, t)
    # a corner on the axis has no angle: the mean of the others of its face
    if ax.any():
        count = (~ax).sum(axis=1)
        mean = np.where(count > 0, np.where(ax, 0.0, t).sum(axis=1) / np.maximum(count, 1), 0.5)
        t = np.where(ax, mean[:, None], t)
    return t.reshape(-1)


def project(P: np.ndarray, FN: np.ndarray, spec: dict) -> np.ndarray:
    """UVs (3F, 2) for per-corner positions P and face normals FN. v runs up (trimesh / OpenGL convention)."""
    proj = spec.get("projection") or "box"
    su, sv = spec.get("scale") or [1.0, 1.0]
    rep = spec.get("repeat")
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    if proj == "box":
        # every side starts at its own lower left corner (seen from outside), so a 1 m crate with a 1 m
        # texture shows the whole picture on each side instead of four quarters
        ax = np.argmax(np.abs(FN), axis=1)
        neg = np.take_along_axis(FN, ax[:, None], axis=1)[:, 0] < 0
        left_x, right_x = x - x.min(), x.max() - x
        left_z, right_z = z - z.min(), z.max() - z
        u = np.where(ax == 0, np.where(neg, left_z, right_z), np.where(ax == 1, left_x, np.where(neg, right_x, left_x)))
        v = np.where(ax == 1, np.where(neg, left_z, right_z), y - y.min())
        uv = np.stack([u / su, v / sv], axis=1)
    elif proj in ("planar", "fit"):
        axis = spec.get("axis") or ("y" if proj == "planar" else "z")
        if axis == "y":
            u, v = x - x.min(), z.max() - z
        elif axis == "x":
            u, v = z.max() - z, y - y.min()
        else:
            u, v = x - x.min(), y - y.min()
        if proj == "planar":
            uv = np.stack([u / su, v / sv], axis=1)
        else:
            ru, rv = rep or [1.0, 1.0]
            uv = np.stack([u / max(float(u.max()), 1e-9) * ru, v / max(float(v.max()), 1e-9) * rv], axis=1)
    elif proj in ("cylinder", "sphere"):
        axis = spec.get("axis") or "y"
        a, up, b, n_up = _frame(P, FN, axis)
        ca, cb = (a.max() + a.min()) / 2, (b.max() + b.min()) / 2
        a, b = a - ca, b - cb
        r = np.hypot(a, b)
        rmax = max(float(r.max()), 1e-9)
        frac = np.arctan2(a, b) / (2 * math.pi) + 0.5
        frac = _unwrap(frac, r < rmax * 1e-6)
        if proj == "cylinder":
            h = max(float(up.max() - up.min()), 1e-9)
            ru = rep[0] if rep else max(1.0, round(2 * math.pi * rmax / abs(su)))
            u = (frac - 0.5) * ru + 0.5  # the middle of a repeat faces the front (+z); the seam is at the back
            v = (up - up.min()) / h * rep[1] if rep else (up - up.min()) / sv
            # caps: seen along the axis with the picture centred, so they do not smear into a fan
            cap = np.abs(n_up) > 0.92
            u = np.where(cap, a / su + 0.5, u)
            v = np.where(cap, -b / sv * np.where(n_up < 0, -1.0, 1.0) + 0.5, v)
        else:
            cu = (up.max() + up.min()) / 2
            R = max(float(np.sqrt(a * a + b * b + (up - cu) ** 2).max()), 1e-9)
            lat = np.arcsin(np.clip((up - cu) / R, -1, 1)) / math.pi + 0.5
            ru = rep[0] if rep else max(1.0, round(2 * math.pi * R / abs(su)))
            rv = rep[1] if rep else max(1.0, round(math.pi * R / abs(sv)))
            u, v = (frac - 0.5) * ru + 0.5, lat * rv
        uv = np.stack([u, v], axis=1)
    else:
        raise UVError(f'unknown projection "{proj}"')
    return transform_uv(uv, spec)


def transform_uv(uv: np.ndarray, spec: dict) -> np.ndarray:
    rot = float(spec.get("rotation") or 0.0)
    if rot:
        c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
        uv = np.stack([uv[:, 0] * c - uv[:, 1] * s, uv[:, 0] * s + uv[:, 1] * c], axis=1)
    off = spec.get("offset") or [0.0, 0.0]
    if off[0] or off[1]:
        uv = uv + np.array([float(off[0]), float(off[1])])
    return uv


# ---------------------------------------------------------------------------
# welding: corners with the same position, normal and UV become one vertex again
# ---------------------------------------------------------------------------
def weld(P: np.ndarray, N: np.ndarray, UV: np.ndarray | None = None):
    cols = [np.round(P * 1e5), np.round(N * 1e3)]
    if UV is not None:
        cols.append(np.round(UV * 1e5))
    key = np.ascontiguousarray(np.hstack(cols).astype(np.int64))
    rows = key.view(np.dtype((np.void, key.dtype.itemsize * key.shape[1]))).ravel()
    _, first, inverse = np.unique(rows, return_index=True, return_inverse=True)
    faces = inverse.reshape(-1, 3)
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    return P[first], N[first], (UV[first] if UV is not None else None), faces


def finish(mesh: trimesh.Trimesh, material=None, uv_spec: dict | None = None, shading: str = "auto", angle: float = DEFAULT_ANGLE,
           warnings: list[str] | None = None, where: str = "") -> trimesh.Trimesh:
    """The final mesh of an object: normals by the shading rule, UVs when `uv_spec` is given, the material attached."""
    if shading not in SHADING:
        raise UVError(f'shading: "{shading}" — one of {", ".join(SHADING)}')
    if not len(mesh.faces):
        return mesh
    P, N, FN, own = corners(mesh, shading, angle)
    UV = None
    if uv_spec is not None:
        proj = uv_spec.get("projection") or ("mesh" if own is not None else "box")
        if proj == "mesh":
            if own is None:
                if warnings is not None and uv_spec.get("projection") == "mesh":
                    warnings.append(f"{where}: uv: mesh — this shape has no UVs of its own, using the box projection")
                UV = project(P, FN, {**uv_spec, "projection": "box"})
            else:
                UV = transform_uv(own, uv_spec)
        else:
            UV = project(P, FN, {**uv_spec, "projection": proj})
    V, VN, VUV, faces = weld(P, N, UV)
    out = trimesh.Trimesh(vertices=V, faces=faces, vertex_normals=VN, process=False, validate=False)
    if material is not None:
        out.visual = trimesh.visual.TextureVisuals(uv=VUV, material=material)
    return out


def ensure_normals(mesh: trimesh.Trimesh, angle: float = DEFAULT_ANGLE) -> trimesh.Trimesh:
    """A model that keeps its own look (materials, UVs): give it normals when it has none."""
    if "vertex_normals" in mesh._cache.cache or not len(mesh.faces):  # noqa: SLF001
        return mesh
    try:
        m = trimesh.graph.smooth_shade(mesh, angle=math.radians(angle), facet_minarea=None)
        m.vertex_normals  # noqa: B018  (computes and caches them: the exporter writes cached normals)
        return m
    except Exception:  # noqa: BLE001
        return mesh
