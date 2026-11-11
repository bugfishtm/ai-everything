"""Public plugin API for studio-3d.

A plugin is a .py file in <project>/plugins/3d/ (or a pack item of kind "plugin"):

    from studio3d.api import shape, modifier, trimesh, np, cylinder, cone, place, merge

    @shape("pine", params={"height": 4.0, "radius": 1.2, "layers": 3, "seed": 1}, doc="Low-poly pine")
    def pine(p):
        trunk = cylinder(radius=p["radius"] * 0.12, height=p["height"] * 0.3, segments=8)
        parts = [(trunk, "bark")]
        for i in range(p["layers"]):
            r = p["radius"] * (1 - i / (p["layers"] + 1))
            layer = place(cone(radius=r, height=p["height"] * 0.45, segments=9), y=p["height"] * (0.22 + 0.2 * i))
            parts.append((layer, "leaves"))
        return parts          # a mesh, or a list of (mesh, material name) parts

    @modifier("inflate", params={"amount": 0.05})
    def inflate(mesh, p):
        m = mesh.copy(); m.vertices += m.vertex_normals * p["amount"]; return m

Conventions: Y is up, 1 unit = 1 metre, shapes sit on y = 0 and are centred on x/z.
Material names refer to the scene's `materials:` (or built-in presets like "wood", "gold").
"""
from __future__ import annotations

from typing import Callable

import numpy as np  # noqa: F401
import trimesh  # noqa: F401

from .registry import register
from .shapes import (  # noqa: F401
    box,
    capsule,
    cone,
    cylinder,
    extrude,
    lathe,
    merge,
    noise2,
    place,
    plane,
    sphere,
    terrain,
    torus,
    tube,
)


def shape(name: str, params: dict | None = None, doc: str = "", ui: dict | None = None) -> Callable:
    """Register a shape. `ui` (optional) tells the website editor how to show a parameter:
    ui={"height": {"min": 0.1, "max": 20, "step": 0.1}, "legs": {"int": True, "min": 3, "max": 8}, "style": {"choices": ["a", "b"]}}"""

    def deco(fn: Callable) -> Callable:
        register("shape", name, fn, params, doc, ui)
        return fn

    return deco


def modifier(name: str, params: dict | None = None, doc: str = "", ui: dict | None = None) -> Callable:
    def deco(fn: Callable) -> Callable:
        register("modifier", name, fn, params, doc, ui)
        return fn

    return deco
