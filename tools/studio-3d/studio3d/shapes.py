"""Built-in shapes. Convention: Y up, metres, every shape sits on y = 0 centred on x/z."""
from __future__ import annotations

import math

import numpy as np
import trimesh
from trimesh.transformations import rotation_matrix, translation_matrix

from .registry import register

Z_TO_Y = rotation_matrix(-math.pi / 2, [1, 0, 0])


def _up(m: trimesh.Trimesh) -> trimesh.Trimesh:
    m.apply_transform(Z_TO_Y)
    return m


def _ground(m: trimesh.Trimesh, center: bool = True) -> trimesh.Trimesh:
    b = m.bounds
    dx = -(b[0][0] + b[1][0]) / 2 if center else 0
    dz = -(b[0][2] + b[1][2]) / 2 if center else 0
    m.apply_translation([dx, -b[0][1], dz])
    return m


def _vec3(v, default=1.0) -> list[float]:
    if v is None:
        return [default] * 3
    if isinstance(v, (int, float)):
        return [float(v)] * 3
    v = list(v)
    if len(v) == 2:
        return [float(v[0]), default, float(v[1])]
    return [float(x) for x in v[:3]]


# --- helpers for plugins --------------------------------------------------------
def place(mesh: trimesh.Trimesh, x: float = 0, y: float = 0, z: float = 0, rotation=None, scale=None) -> trimesh.Trimesh:
    """Copy of `mesh` scaled, rotated (degrees XYZ) and moved."""
    m = mesh.copy()
    if scale is not None:
        m.apply_scale(scale if isinstance(scale, (int, float)) else np.array(_vec3(scale)))
    if rotation is not None:
        rx, ry, rz = (math.radians(a) for a in _vec3(rotation, 0.0))
        m.apply_transform(trimesh.transformations.euler_matrix(rx, ry, rz, "sxyz"))
    m.apply_translation([x, y, z])
    return m


def merge(meshes) -> trimesh.Trimesh:
    return trimesh.util.concatenate([m for m in meshes if m is not None and len(m.faces)])


def noise2(x: np.ndarray, z: np.ndarray, seed: int = 1, octaves: int = 4, roughness: float = 0.5, scale: float = 0.15) -> np.ndarray:
    """Smooth value noise in [-1, 1] for arrays of coordinates."""
    rng = np.random.default_rng(seed)
    out = np.zeros_like(x, dtype=np.float64)
    amp, freq, total = 1.0, scale, 0.0
    for _ in range(int(octaves)):
        grid = rng.uniform(-1, 1, (257, 257))
        gx, gz = x * freq + 128.5, z * freq + 128.5
        x0, z0 = np.floor(gx).astype(int) % 256, np.floor(gz).astype(int) % 256
        fx, fz = gx - np.floor(gx), gz - np.floor(gz)
        sx, sz = fx * fx * (3 - 2 * fx), fz * fz * (3 - 2 * fz)
        a = grid[x0, z0] * (1 - sx) + grid[x0 + 1, z0] * sx
        b = grid[x0, z0 + 1] * (1 - sx) + grid[x0 + 1, z0 + 1] * sx
        out += (a * (1 - sz) + b * sz) * amp
        total += amp
        amp *= roughness
        freq *= 2
    return out / total


# --- shapes ---------------------------------------------------------------------
def box(size=1.0, **_):
    s = _vec3(size)
    m = trimesh.creation.box(extents=s)
    m.apply_translation([0, s[1] / 2, 0])
    return m


def sphere(radius=0.5, detail=3, **_):
    m = trimesh.creation.icosphere(subdivisions=int(detail), radius=float(radius))
    m.apply_translation([0, float(radius), 0])
    return m


def cylinder(radius=0.5, height=1.0, segments=32, radius_top=None, **_):
    if radius_top is not None and float(radius_top) != float(radius):
        return lathe(profile=[[0, 0], [radius, 0], [radius_top, height], [0, height]], segments=segments)
    m = _up(trimesh.creation.cylinder(radius=float(radius), height=float(height), sections=int(segments)))
    return _ground(m)


def cone(radius=0.5, height=1.0, segments=32, **_):
    return _ground(_up(trimesh.creation.cone(radius=float(radius), height=float(height), sections=int(segments))))


def capsule(radius=0.3, height=1.2, segments=24, **_):
    cyl = max(float(height) - 2 * float(radius), 0.001)
    return _ground(_up(trimesh.creation.capsule(height=cyl, radius=float(radius), count=[int(segments), int(segments)])))


def torus(radius=0.5, tube=0.15, segments=48, sides=16, **_):
    m = trimesh.creation.torus(major_radius=float(radius), minor_radius=float(tube), major_sections=int(segments), minor_sections=int(sides))
    return _ground(_up(m))


def plane(size=1.0, **_):
    w, _, d = _vec3(size)
    v = np.array([[-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2]])
    return trimesh.Trimesh(vertices=v, faces=[[0, 2, 1], [0, 3, 2]], process=False)


def disc(radius=0.5, segments=32, **_):
    a = np.linspace(0, 2 * math.pi, int(segments), endpoint=False)
    v = np.vstack([[0, 0, 0], np.stack([np.cos(a) * radius, np.zeros_like(a), np.sin(a) * radius], axis=1)])
    n = int(segments)
    f = [[0, 1 + (i + 1) % n, 1 + i] for i in range(n)]
    return trimesh.Trimesh(vertices=v, faces=f, process=False)


def extrude(points=None, height=1.0, holes=None, **_):
    """Extrude a 2D outline [[x, z], …] upwards by `height`."""
    from shapely.geometry import Polygon

    if not points or len(points) < 3:
        raise ValueError("extrude needs points: [[x, z], …] (at least 3)")
    poly = Polygon([(x, -z) for x, z in points], holes=[[(x, -z) for x, z in h] for h in (holes or [])])
    if not poly.is_valid:
        poly = poly.buffer(0)
    return _up(trimesh.creation.extrude_polygon(poly, float(height)))


def lathe(profile=None, segments=32, **_):
    """Revolve a profile [[radius, y], …] around the Y axis (vases, columns, bottles)."""
    if not profile or len(profile) < 2:
        raise ValueError("lathe needs profile: [[radius, y], …]")
    pts = np.array(profile, dtype=np.float64)
    return _up(trimesh.creation.revolve(pts, sections=int(segments)))


def tube(path=None, radius=0.05, segments=12, caps=True, **_):
    """Round tube along a 3D path [[x, y, z], …] (pipes, branches, rails, cables)."""
    p = np.array(path or [], dtype=np.float64)
    if len(p) < 2:
        raise ValueError("tube needs path: [[x, y, z], …] (at least 2 points)")
    n = int(segments)
    tangents = np.gradient(p, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1, keepdims=True) + 1e-12
    ref = np.array([0, 1, 0]) if abs(tangents[0][1]) < 0.9 else np.array([1, 0, 0])
    normal = np.cross(tangents[0], ref)
    normal /= np.linalg.norm(normal)
    radii = np.broadcast_to(np.asarray(radius, dtype=np.float64), (len(p),))
    verts, rings = [], []
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    for i, (pt, t) in enumerate(zip(p, tangents)):
        normal = normal - t * np.dot(normal, t)  # parallel transport
        normal /= np.linalg.norm(normal) + 1e-12
        binorm = np.cross(t, normal)
        ring = pt + radii[i] * (np.outer(np.cos(ang), normal) + np.outer(np.sin(ang), binorm))
        rings.append(len(verts))
        verts.extend(ring)
    faces = []
    for i in range(len(p) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(n):
            j2 = (j + 1) % n
            faces += [[a + j, b + j, b + j2], [a + j, b + j2, a + j2]]
    if caps:
        for idx, flip in ((0, True), (len(p) - 1, False)):
            c = len(verts)
            verts.append(p[idx])
            base = rings[idx]
            for j in range(n):
                j2 = (j + 1) % n
                faces.append([c, base + j2, base + j] if flip else [c, base + j, base + j2])
    m = trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces))
    m.fix_normals()
    return m


def terrain(size=20.0, resolution=64, height=2.0, seed=1, octaves=4, roughness=0.5, scale=0.15, flat=0.0, **_):
    """Rolling terrain (value noise). `flat` (metres) keeps a flat area around the centre."""
    w, _, d = _vec3(size)
    res = int(resolution)
    xs = np.linspace(-w / 2, w / 2, res + 1)
    zs = np.linspace(-d / 2, d / 2, res + 1)
    X, Z = np.meshgrid(xs, zs, indexing="ij")
    H = (noise2(X, Z, int(seed), int(octaves), float(roughness), float(scale)) * 0.5 + 0.5) * float(height)
    if flat:
        r = np.sqrt(X**2 + Z**2)
        H *= np.clip((r - float(flat)) / max(float(flat), 1e-6), 0, 1)
    v = np.stack([X.ravel(), H.ravel(), Z.ravel()], axis=1)
    faces = []
    for i in range(res):
        for j in range(res):
            a = i * (res + 1) + j
            b = a + res + 1
            faces += [[a, a + 1, b], [b, a + 1, b + 1]]
    m = trimesh.Trimesh(vertices=v, faces=np.array(faces))
    m.fix_normals()
    return m


def mesh_shape(vertices=None, faces=None, **_):
    if not vertices or not faces:
        raise ValueError("mesh needs vertices: [[x,y,z], …] and faces: [[a,b,c], …]")
    return trimesh.Trimesh(vertices=np.array(vertices, dtype=np.float64), faces=np.array(faces, dtype=np.int64))


# --- organic shapes -------------------------------------------------------------
def loft(sections=None, axis="z", segments=32, smooth=8, round=2.0, caps=True, absolute=False, **_):  # noqa: A002
    """Smooth body through cross-sections along an axis — fish, bottles, fuselages, limbs, boats.

    sections: [[at, width, height], …] or [[at, width, height, y], …] or {at, width, height, y, round}
      at = position along the axis (m), width/height = size of the section, y = its vertical centre.
    round: section shape — 2 ellipse, 4 rounded box, 1 diamond (per section via `round`).
    smooth: interpolated sections between two given ones (Catmull-Rom).
    """
    if not sections or len(sections) < 2:
        raise ValueError("loft needs sections: [[at, width, height(, y)], …] (at least 2)")
    rows = []
    for s in sections:
        if isinstance(s, dict):
            w = float(s.get("width", s.get("size", 0.1)))
            rows.append([float(s.get("at", 0)), w, float(s.get("height", w)), float(s.get("y", 0)), float(s.get("round", round))])
        else:
            s = list(s)
            if len(s) < 3:
                raise ValueError("each loft section needs at least [at, width, height]")
            rows.append([float(s[0]), float(s[1]), float(s[2]), float(s[3]) if len(s) > 3 else 0.0, float(s[4]) if len(s) > 4 else float(round)])
    rows.sort(key=lambda r: r[0])
    K = np.array(rows, dtype=np.float64)
    steps = max(1, int(smooth))
    dense = []
    for i in range(len(K) - 1):
        p0, p1, p2, p3 = K[max(i - 1, 0)], K[i], K[i + 1], K[min(i + 2, len(K) - 1)]
        for j in range(steps):
            u = j / steps
            v = 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u**3)
            v[0] = p1[0] + (p2[0] - p1[0]) * u
            dense.append(v)
    dense.append(K[-1].copy())
    D = np.array(dense)
    D[:, 1:3] = np.maximum(D[:, 1:3], 1e-4)
    D[:, 4] = np.clip(D[:, 4], 0.5, 12)
    n = max(3, int(segments))
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    ca, sa = np.cos(ang), np.sin(ang)
    rings = []
    for at, w, h, yc, r in D:
        e = 2.0 / r
        rings.append(np.stack([(w / 2) * np.sign(ca) * np.abs(ca) ** e, yc + (h / 2) * np.sign(sa) * np.abs(sa) ** e, np.full(n, at)], axis=1))
    V = np.concatenate(rings)
    faces = []
    for i in range(len(D) - 1):
        a0, b0 = i * n, (i + 1) * n
        for j in range(n):
            j2 = (j + 1) % n
            faces += [[a0 + j, b0 + j, b0 + j2], [a0 + j, b0 + j2, a0 + j2]]
    if caps:
        extra = []
        for ring, flip in ((0, True), (len(D) - 1, False)):
            c = len(V) + len(extra)
            extra.append(V[ring * n:(ring + 1) * n].mean(axis=0))
            for j in range(n):
                j2 = (j + 1) % n
                faces.append([c, ring * n + j2, ring * n + j] if flip else [c, ring * n + j, ring * n + j2])
        V = np.vstack([V, np.array(extra)])
    m = trimesh.Trimesh(vertices=V, faces=np.array(faces))
    m.fix_normals()
    if axis == "x":
        m.apply_transform(rotation_matrix(math.pi / 2, [0, 1, 0]))  # length z → x, width → z
    elif axis == "y":
        m.apply_transform(rotation_matrix(-math.pi / 2, [1, 0, 0]))  # length z → y
    elif axis != "z":
        raise ValueError('loft axis must be "x", "y" or "z"')
    return m if absolute else _ground(m)


def _rot3(rotation) -> np.ndarray:
    if rotation is None:
        return np.eye(3)
    rx, ry, rz = (math.radians(a) for a in _vec3(rotation, 0.0))
    return trimesh.transformations.euler_matrix(rx, ry, rz, "sxyz")[:3, :3]


_BLOB_KINDS = ("sphere", "ellipsoid", "capsule", "box", "torus")


def _blob_kind(part: dict) -> str:
    kind = next((k for k in _BLOB_KINDS if k in part), None)
    if kind is None:
        raise ValueError(f"blob part needs one of {', '.join(_BLOB_KINDS)}: {part}")
    return kind


def _blob_bounds(part: dict) -> tuple[np.ndarray, np.ndarray]:
    kind = _blob_kind(part)
    if kind == "capsule":
        a, b = np.array(_vec3(part.get("from", [0, 0, 0]), 0.0)), np.array(_vec3(part.get("to", [0, 1, 0]), 0.0))
        r = part["capsule"]
        rr = max(float(x) for x in r) if isinstance(r, (list, tuple)) else float(r)
        return np.minimum(a, b) - rr, np.maximum(a, b) + rr
    c = np.array(_vec3(part.get("at", [0, 0, 0]), 0.0))
    v = part[kind]
    if kind == "sphere":
        e = float(v)
    elif kind == "torus":
        e = float(v[0]) + float(v[1])
    elif kind == "box":
        e = float(np.linalg.norm(np.array(_vec3(v)) / 2))
    else:
        e = max(_vec3(v))
    return c - e, c + e


def _blob_sdf(P: np.ndarray, part: dict) -> np.ndarray:
    kind = _blob_kind(part)
    if kind == "capsule":
        a, b = np.array(_vec3(part.get("from", [0, 0, 0]), 0.0)), np.array(_vec3(part.get("to", [0, 1, 0]), 0.0))
        r = part["capsule"]
        r1, r2 = (float(r[0]), float(r[1])) if isinstance(r, (list, tuple)) else (float(r), float(r))
        pa, ba = P - a, b - a
        h = np.clip((pa @ ba) / max(float(ba @ ba), 1e-12), 0, 1)
        return np.linalg.norm(pa - h[:, None] * ba, axis=1) - (r1 + (r2 - r1) * h)
    c = np.array(_vec3(part.get("at", [0, 0, 0]), 0.0))
    L = (P - c) @ _rot3(part.get("rotation"))
    v = part[kind]
    if kind == "sphere":
        return np.linalg.norm(L, axis=1) - float(v)
    if kind == "ellipsoid":
        r = np.array(_vec3(v), dtype=np.float64)
        k0 = np.linalg.norm(L / r, axis=1)
        k1 = np.linalg.norm(L / (r * r), axis=1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-12)
    if kind == "box":
        half = np.array(_vec3(v)) / 2
        rr = min(float(part.get("round", 0.0)), float(half.min()))
        q = np.abs(L) - (half - rr)
        return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(q.max(axis=1), 0) - rr
    big, small = float(v[0]), float(v[1])
    qx = np.linalg.norm(L[:, [0, 2]], axis=1) - big
    return np.sqrt(qx * qx + L[:, 1] ** 2) - small


def _smin(a: np.ndarray, b: np.ndarray, k: float) -> np.ndarray:
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def blob(parts=None, blend=0.1, resolution=96, smooth=4, absolute=False, **_):
    """Sculpted organic surface: primitives melted together (signed distance + marching cubes).

    parts: list of {sphere: r, at: [x,y,z]}, {ellipsoid: [rx,ry,rz], at, rotation},
      {capsule: r | [r_from, r_to], from: [x,y,z], to: [x,y,z]}, {box: [x,y,z], at, rotation, round},
      {torus: [R, r], at, rotation}; add `subtract: true` to carve, `blend:` per part.
    blend: how far parts melt into each other (m). resolution: cells along the longest side
      (detail: 64 draft, 96 default, 160+ high poly). smooth: Taubin smoothing passes.
    """
    from skimage.measure import marching_cubes

    if not parts:
        raise ValueError("blob needs parts: [{sphere: 0.3, at: [0, 0.3, 0]}, …]")
    parts = [dict(p) for p in parts]
    adds = [p for p in parts if not p.get("subtract")]
    subs = [p for p in parts if p.get("subtract")]
    if not adds:
        raise ValueError("blob needs at least one part that is not subtract: true")
    k = float(blend)
    bounds = [_blob_bounds(p) for p in adds]
    lo = np.min([b[0] for b in bounds], axis=0)
    hi = np.max([b[1] for b in bounds], axis=0)
    res = max(16, min(int(resolution), 256))
    step = float((hi - lo).max()) / res
    margin = k + 3 * step
    lo, hi = lo - margin, hi + margin
    nx, ny, nz = (np.ceil((hi - lo) / step).astype(int) + 1).tolist()
    xs, ys, zs = (lo[i] + np.arange(cnt) * step for i, cnt in enumerate((nx, ny, nz)))
    Y, Z = np.meshgrid(ys, zs, indexing="ij")
    vol = np.empty((nx, ny, nz), dtype=np.float32)
    slab = max(1, 1_500_000 // (ny * nz))
    for i0 in range(0, nx, slab):
        X = xs[i0:i0 + slab]
        P = np.stack(np.broadcast_arrays(X[:, None, None], Y[None], Z[None]), axis=-1).reshape(-1, 3)
        d = None
        for p in adds:
            s = _blob_sdf(P, p)
            d = s if d is None else _smin(d, s, float(p.get("blend", k)))
        for p in subs:
            d = -_smin(-d, _blob_sdf(P, p), float(p.get("blend", k)))
        vol[i0:i0 + len(X)] = d.reshape(len(X), ny, nz)
    if vol.min() >= 0:
        raise ValueError("blob produced no surface — check sizes and positions of the parts")
    verts, faces, _normals, _values = marching_cubes(vol, level=0.0, spacing=(step, step, step), gradient_direction="ascent")
    m = trimesh.Trimesh(vertices=verts + lo, faces=faces)
    m.fix_normals()
    if int(smooth) > 0:
        trimesh.smoothing.filter_taubin(m, iterations=int(smooth))
    return m if absolute else _ground(m)


SHAPE_DEFS = {
    "box": (box, {"size": [1, 1, 1]}, "Box; size [x, y, z] or a number."),
    "sphere": (sphere, {"radius": 0.5, "detail": 3}, "Ico sphere (detail 1-5)."),
    "cylinder": (cylinder, {"radius": 0.5, "height": 1.0, "segments": 32, "radius_top": None}, "Cylinder (radius_top for a frustum)."),
    "cone": (cone, {"radius": 0.5, "height": 1.0, "segments": 32}, "Cone / pyramid (segments 3-4)."),
    "capsule": (capsule, {"radius": 0.3, "height": 1.2, "segments": 24}, "Capsule (total height)."),
    "torus": (torus, {"radius": 0.5, "tube": 0.15, "segments": 48, "sides": 16}, "Ring lying flat."),
    "plane": (plane, {"size": [1, 1]}, "Flat quad [x, z] facing up."),
    "disc": (disc, {"radius": 0.5, "segments": 32}, "Flat circle facing up."),
    "extrude": (extrude, {"points": None, "height": 1.0, "holes": None}, "Outline [[x, z], …] extruded up (walls, floors, signs)."),
    "lathe": (lathe, {"profile": None, "segments": 32}, "Profile [[radius, y], …] revolved around Y (vases, columns)."),
    "tube": (tube, {"path": None, "radius": 0.05, "segments": 12, "caps": True}, "Tube along [[x, y, z], …] (pipes, branches, rails)."),
    "terrain": (terrain, {"size": [20, 20], "resolution": 64, "height": 2.0, "seed": 1, "octaves": 4, "roughness": 0.5, "scale": 0.15, "flat": 0.0},
                "Noise terrain; flat = radius kept flat at the centre."),
    "mesh": (mesh_shape, {"vertices": None, "faces": None}, "Raw triangles."),
    "loft": (loft, {"sections": None, "axis": "z", "segments": 32, "smooth": 8, "round": 2.0, "caps": True, "absolute": False},
             "Smooth body through cross-sections [[at, width, height, y], …] along x/y/z (fish, bottles, hulls, limbs)."),
    "blob": (blob, {"parts": None, "blend": 0.1, "resolution": 96, "smooth": 4, "absolute": False},
             "Organic sculpt: spheres/ellipsoids/capsules/boxes/tori melted together (creatures, characters, rocks); resolution 160+ = high poly."),
}

for _name, (_fn, _params, _doc) in SHAPE_DEFS.items():
    register("shape", _name, (lambda f: lambda p: f(**p))(_fn), _params, _doc)
