"""Nature shapes for studio-3d (basic-3d pack): tree, pine, rock, bush.

Use:  objects: [ { use: basic-3d/tree, height: 5, seed: 3 } ]
All stand on y = 0 and are low-poly (flat shaded) for games.
"""
from studio3d.api import cone, cylinder, merge, np, place, shape, sphere


def _noisy(mesh, amount, seed):
    m = mesh.copy()
    v = m.vertices
    k = np.sin(v[:, 0] * 3.1 + seed) * np.cos(v[:, 2] * 2.7 - seed) + np.sin(v[:, 1] * 4.3 + seed * 0.5)
    m.vertices = v + m.vertex_normals * (k * amount)[:, None]
    return m


def _faceted(m):
    m = m.copy()
    m.unmerge_vertices()
    return m


@shape("tree", params={"height": 4.0, "canopy": 1.6, "trunk": 0.18, "blobs": 4, "seed": 1},
       doc="Round deciduous tree: trunk + lumpy low-poly canopy")
def tree(p):
    rng = np.random.default_rng(int(p["seed"]))
    h = float(p["height"])
    trunk_h = h * 0.45
    parts = [(cylinder(radius=p["trunk"], height=trunk_h + 0.4, segments=8), "bark")]
    blobs = []
    for _ in range(int(p["blobs"])):
        r = p["canopy"] * rng.uniform(0.55, 0.8)
        dx, dz = rng.uniform(-0.45, 0.45, 2) * p["canopy"]
        y = trunk_h + rng.uniform(0.0, 0.4) * max(h - trunk_h - 2 * r, 0.1)
        blobs.append(place(sphere(radius=r, detail=1), x=dx, y=y, z=dz))
    canopy = _noisy(merge(blobs), 0.07 * p["canopy"], int(p["seed"]))
    parts.append((_faceted(canopy), "leaves"))
    return parts


@shape("pine", params={"height": 5.0, "radius": 1.3, "layers": 4, "trunk": 0.15, "seed": 1},
       doc="Low-poly conifer with stacked cone layers")
def pine(p):
    h = float(p["height"])
    layers = max(1, int(p["layers"]))
    parts = [(cylinder(radius=p["trunk"], height=h * 0.3, segments=7), "bark")]
    cones = []
    for i in range(layers):
        t = i / layers
        cones.append(place(cone(radius=p["radius"] * (1 - t * 0.7), height=h * 0.42 * (1 - t * 0.35), segments=8),
                           y=h * 0.16 + h * 0.6 * t, rotation=[0, i * 22 + int(p["seed"]) * 7, 0]))
    parts.append((_faceted(merge(cones)), "basic-3d/pine-needles"))
    return parts


@shape("rock", params={"size": 1.0, "detail": 2, "roughness": 0.25, "flatness": 0.7, "seed": 1},
       doc="Low-poly rock / boulder")
def rock(p):
    s = float(p["size"])
    rng = np.random.default_rng(int(p["seed"]))
    m = _noisy(sphere(radius=0.5 * s, detail=int(p["detail"])), p["roughness"] * 0.5 * s, int(p["seed"]))
    m.apply_scale([1.0 + 0.25 * rng.uniform(-1, 1), float(p["flatness"]), 1.0 + 0.25 * rng.uniform(-1, 1)])
    m.apply_translation([0, -m.bounds[0][1], 0])
    return [(_faceted(m), "basic-3d/granite")]


@shape("bush", params={"size": 0.8, "blobs": 3, "seed": 1}, doc="Low-poly bush")
def bush(p):
    rng = np.random.default_rng(int(p["seed"]))
    s = float(p["size"])
    blobs = [place(sphere(radius=s * rng.uniform(0.35, 0.55), detail=1), x=rng.uniform(-0.3, 0.3) * s, z=rng.uniform(-0.3, 0.3) * s)
             for _ in range(int(p["blobs"]))]
    m = _noisy(merge(blobs), 0.05 * s, int(p["seed"]))
    m.apply_translation([0, -m.bounds[0][1], 0])
    return [(_faceted(m), "leaves")]
