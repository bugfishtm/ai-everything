"""Built-in modifiers: fn(mesh, params) -> mesh (local space, before placement)."""
from __future__ import annotations

import math

import numpy as np
import trimesh

from .registry import register
from .shapes import noise2


def _subdivide(m, p):
    for _ in range(int(p["iterations"])):
        m = m.subdivide()
    return m


def _smooth(m, p):
    m = m.copy()
    trimesh.smoothing.filter_taubin(m, iterations=int(p["iterations"]))
    return m


def _noise(m, p):
    m = m.copy()
    v = m.vertices
    n = noise2(v[:, 0] + v[:, 1] * 0.37, v[:, 2] - v[:, 1] * 0.61, int(p["seed"]), 3, 0.5, float(p["scale"]))
    m.vertices = v + m.vertex_normals * (n * float(p["amount"]))[:, None]
    return m


def _taper(m, p):
    m = m.copy()
    v = m.vertices.copy()
    h = max(v[:, 1].max() - v[:, 1].min(), 1e-9)
    t = (v[:, 1] - v[:, 1].min()) / h
    k = 1 + (float(p["top"]) - 1) * t
    v[:, 0] *= k
    v[:, 2] *= k
    m.vertices = v
    return m


def _twist(m, p):
    m = m.copy()
    v = m.vertices.copy()
    h = max(v[:, 1].max() - v[:, 1].min(), 1e-9)
    a = np.radians(float(p["degrees"])) * (v[:, 1] - v[:, 1].min()) / h
    x, z = v[:, 0].copy(), v[:, 2].copy()
    v[:, 0] = x * np.cos(a) - z * np.sin(a)
    v[:, 2] = x * np.sin(a) + z * np.cos(a)
    m.vertices = v
    return m


def _flat(m, p):
    m = m.copy()
    m.unmerge_vertices()
    return m


def _smooth_shading(m, p):
    m = m.copy()
    m.merge_vertices()
    return m


def _bend(m, p):
    """Bend around the Z axis: `degrees` over the height of the mesh."""
    m = m.copy()
    v = m.vertices.copy()
    h = max(v[:, 1].max() - v[:, 1].min(), 1e-9)
    total = math.radians(float(p["degrees"]))
    if abs(total) < 1e-6:
        return m
    r = h / total
    t = (v[:, 1] - v[:, 1].min()) / h * total
    x = v[:, 0]
    v[:, 0] = (r - x) * -np.cos(t) + r
    v[:, 1] = (r - x) * np.sin(t) + v[:, 1].min()
    m.vertices = v
    return m


for name, fn, params, doc in [
    ("subdivide", _subdivide, {"iterations": 1}, "Split every triangle into 4 (smoother after `smooth`)."),
    ("smooth", _smooth, {"iterations": 10}, "Taubin smoothing (keeps volume)."),
    ("noise", _noise, {"amount": 0.05, "scale": 2.0, "seed": 1}, "Displace along normals with noise (rocks, organic shapes)."),
    ("taper", _taper, {"top": 0.5}, "Scale x/z towards the top (top = factor at the top)."),
    ("twist", _twist, {"degrees": 90}, "Twist around Y over the height."),
    ("bend", _bend, {"degrees": 45}, "Bend over the height."),
    ("flat", _flat, {}, "Faceted low-poly look (flat shading)."),
    ("smooth_shading", _smooth_shading, {}, "Merge vertices for smooth shading."),
]:
    register("modifier", name, fn, params, doc)
