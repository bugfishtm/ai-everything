"""Built-in shapes. Signature: fn(c, p) — c: Canvas (document pixels), p: the layer's options.

The value written after the shape's name is in p["_value"]:  { star: [400, 300, 120], points: 7 }
"""
from __future__ import annotations

import math
import re

from .api import shape


class ShapeError(ValueError):
    pass


def _nums(p: dict, n: int, what: str) -> list[float]:
    v = p.get("_value")
    if not (isinstance(v, (list, tuple)) and len(v) == n and all(isinstance(x, (int, float)) for x in v)):
        raise ShapeError(f"write it as {what}")
    return [float(x) for x in v]


def _points(v, what: str) -> list[tuple[float, float]]:
    if not (isinstance(v, (list, tuple)) and len(v) >= 2 and all(isinstance(q, (list, tuple)) and len(q) == 2 for q in v)):
        raise ShapeError(f"write it as {what}")
    return [(float(q[0]), float(q[1])) for q in v]


def _smooth(pts: list[tuple[float, float]], closed: bool, steps: int = 10) -> list[tuple[float, float]]:
    """Catmull-Rom: a soft curve through the points."""
    if len(pts) < 3:
        return pts
    P = ([pts[-1]] + pts + pts[:2]) if closed else ([pts[0]] + pts + [pts[-1]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for s in range(steps):
            t = s / steps
            out.append(tuple(0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t ** 3) for a in (0, 1)))
    if not closed:
        out.append(pts[-1])
    return out  # type: ignore[return-value]


@shape("rect", params={"radius": 0}, doc="rect: [x, y, width, height] — radius rounds the corners")
def rect(c, p):
    x, y, w, h = _nums(p, 4, "rect: [x, y, width, height]")
    c.rect(x, y, w, h, float(p["radius"]))


@shape("ellipse", doc="ellipse: [cx, cy, rx, ry]")
def ellipse(c, p):
    cx, cy, rx, ry = _nums(p, 4, "ellipse: [cx, cy, rx, ry]")
    c.ellipse(cx, cy, rx, ry)


@shape("circle", doc="circle: [cx, cy, r]")
def circle(c, p):
    cx, cy, r = _nums(p, 3, "circle: [cx, cy, r]")
    c.ellipse(cx, cy, r, r)


@shape("polygon", params={"smooth": False}, doc="polygon: [[x, y], [x, y], …] — smooth: true rounds it")
def polygon(c, p):
    pts = _points(p.get("_value"), "polygon: [[x, y], [x, y], [x, y]]")
    c.poly(_smooth(pts, True) if p["smooth"] else pts)


@shape("ngon", params={"sides": 6, "rotation": 0}, doc="ngon: [cx, cy, r] — a regular polygon with `sides` corners")
def ngon(c, p):
    cx, cy, r = _nums(p, 3, "ngon: [cx, cy, r]")
    n = max(3, int(p["sides"]))
    a0 = math.radians(float(p["rotation"]) - 90)
    c.poly([(cx + r * math.cos(a0 + i * math.tau / n), cy + r * math.sin(a0 + i * math.tau / n)) for i in range(n)])


@shape("star", params={"points": 5, "inner": 0.45, "rotation": 0}, doc="star: [cx, cy, r] — points, inner (0 … 1: how deep the notches go)")
def star(c, p):
    cx, cy, r = _nums(p, 3, "star: [cx, cy, r]")
    n = max(3, int(p["points"]))
    a0 = math.radians(float(p["rotation"]) - 90)
    pts = []
    for i in range(n * 2):
        rr = r if i % 2 == 0 else r * float(p["inner"])
        pts.append((cx + rr * math.cos(a0 + i * math.pi / n), cy + rr * math.sin(a0 + i * math.pi / n)))
    c.poly(pts)


@shape("burst", params={"rays": 16, "inner": 0.82, "rotation": 0}, doc="burst: [cx, cy, r] — a badge / starburst with many small points")
def burst(c, p):
    star(c, {**p, "points": p["rays"]})


@shape("line", params={"closed": False, "smooth": False, "width": None}, doc="line: [[x, y], [x, y], …] — painted with stroke (width); smooth: a curve through the points")
def line(c, p):
    pts = _points(p.get("_value"), "line: [[x, y], [x, y]]")
    if p["smooth"]:
        pts = _smooth(pts, bool(p["closed"]))
    c.line(pts, p.get("width"), bool(p["closed"]))


@shape("arc", params={"width": None}, doc="arc: [cx, cy, r, start, end] — part of a circle line (degrees, 0 = right, clockwise)")
def arc(c, p):
    cx, cy, r, a, b = _nums(p, 5, "arc: [cx, cy, r, start, end]")
    c.arc(cx, cy, r, a, b, p.get("width"))


@shape("ring", params={"width": 12}, doc="ring: [cx, cy, r] — a circle line `width` thick")
def ring(c, p):
    cx, cy, r = _nums(p, 3, "ring: [cx, cy, r]")
    c.arc(cx, cy, r, 0, 360, float(p["width"]))


@shape("pie", doc="pie: [cx, cy, r, start, end] — a slice of a circle (charts, progress)")
def pie(c, p):
    cx, cy, r, a, b = _nums(p, 5, "pie: [cx, cy, r, start, end]")
    n = max(6, int(abs(b - a) / 3))
    c.poly([(cx, cy)] + [(cx + r * math.cos(math.radians(a + (b - a) * i / n)), cy + r * math.sin(math.radians(a + (b - a) * i / n))) for i in range(n + 1)])


@shape("arrow", params={"width": 10, "head": 3.2}, doc="arrow: [[x1, y1], [x2, y2]] — width of the shaft, head = size of the tip (× width)")
def arrow(c, p):
    (x1, y1), (x2, y2) = _points(p.get("_value"), "arrow: [[x1, y1], [x2, y2]]")[:2]
    w = float(p["width"])
    L = math.hypot(x2 - x1, y2 - y1) or 1.0
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    nx, ny = -uy, ux
    h = min(L * 0.8, w * float(p["head"]))
    bx, by = x2 - ux * h, y2 - uy * h
    c.poly([(x1 + nx * w / 2, y1 + ny * w / 2), (bx + nx * w / 2, by + ny * w / 2), (bx + nx * h * 0.6, by + ny * h * 0.6), (x2, y2),
            (bx - nx * h * 0.6, by - ny * h * 0.6), (bx - nx * w / 2, by - ny * w / 2), (x1 - nx * w / 2, y1 - ny * w / 2)])


@shape("cross", params={"thickness": 0.3, "rotation": 0}, doc="cross: [cx, cy, size] — a plus sign (rotation: 45 makes an ×)")
def cross(c, p):
    cx, cy, s = _nums(p, 3, "cross: [cx, cy, size]")
    t = s * float(p["thickness"]) / 2
    h = s / 2
    a = math.radians(float(p["rotation"]))
    pts = [(-t, -h), (t, -h), (t, -t), (h, -t), (h, t), (t, t), (t, h), (-t, h), (-t, t), (-h, t), (-h, -t), (-t, -t)]
    c.poly([(cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)) for x, y in pts])


@shape("heart", doc="heart: [cx, cy, size]")
def heart(c, p):
    cx, cy, s = _nums(p, 3, "heart: [cx, cy, size]")
    k = s / 34
    c.poly([(cx + k * 16 * math.sin(t) ** 3, cy - k * (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)) - k * 2)
            for t in (i * math.tau / 90 for i in range(90))])


@shape("cloud", doc="cloud: [cx, cy, width]")
def cloud(c, p):
    cx, cy, w = _nums(p, 3, "cloud: [cx, cy, width]")
    u = w / 10
    for dx, dy, r in ((-2.6, 0.6, 1.9), (-1.0, -0.5, 2.5), (1.2, -0.2, 2.2), (2.9, 0.7, 1.7)):
        c.ellipse(cx + dx * u, cy + dy * u, r * u, r * u)
    c.rect(cx - 2.8 * u, cy + 0.5 * u, 5.8 * u, 2.0 * u, radius=1.0 * u)


@shape("bubble", params={"radius": 18, "tail": None, "tail_width": 26}, doc="bubble: [x, y, width, height] — a speech bubble; tail: [x, y] where it points to")
def bubble(c, p):
    x, y, w, h = _nums(p, 4, "bubble: [x, y, width, height]")
    c.rect(x, y, w, h, float(p["radius"]))
    if p.get("tail"):
        tx, ty = float(p["tail"][0]), float(p["tail"][1])
        bx = min(max(tx, x + float(p["radius"]) + float(p["tail_width"]) / 2), x + w - float(p["radius"]) - float(p["tail_width"]) / 2)
        by = y + h - 1 if ty > y + h / 2 else y + 1
        c.poly([(bx - float(p["tail_width"]) / 2, by), (bx + float(p["tail_width"]) / 2, by), (tx, ty)])


@shape("wave", params={"waves": 2.0, "amplitude": 30, "phase": 0.0}, doc="wave: [x, y, width, height] — a band with a wavy top edge (hills, water, section dividers)")
def wave(c, p):
    x, y, w, h = _nums(p, 4, "wave: [x, y, width, height]")
    n = 80
    top = [(x + w * i / n, y + float(p["amplitude"]) * math.sin((i / n * float(p["waves"]) + float(p["phase"])) * math.tau)) for i in range(n + 1)]
    c.poly(top + [(x + w, y + h), (x, y + h)])


@shape("grid_lines", params={"spacing": 50, "width": 1.5}, doc="grid_lines: [x, y, width, height] — lines every `spacing` px")
def grid_lines(c, p):
    x, y, w, h = _nums(p, 4, "grid_lines: [x, y, width, height]")
    sp = max(2.0, float(p["spacing"]))
    i = 0.0
    while i <= w + 1e-6:
        c.line([(x + i, y), (x + i, y + h)], float(p["width"]))
        i += sp
    j = 0.0
    while j <= h + 1e-6:
        c.line([(x, y + j), (x + w, y + j)], float(p["width"]))
        j += sp


# ---------------------------------------------------------------------------
# SVG path data
# ---------------------------------------------------------------------------
_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
_ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def _bezier(p0, p1, p2, p3, n: int = 16):
    return [tuple((1 - t) ** 3 * p0[a] + 3 * (1 - t) ** 2 * t * p1[a] + 3 * (1 - t) * t * t * p2[a] + t ** 3 * p3[a] for a in (0, 1)) for t in (i / n for i in range(1, n + 1))]


def _arc_points(p0, rx, ry, phi, large, sweep, p1, n: int = 24):
    """SVG elliptical arc (endpoint form) as points."""
    if rx == 0 or ry == 0 or p0 == p1:
        return [p1]
    rx, ry = abs(rx), abs(ry)
    ph = math.radians(phi)
    cp, sp = math.cos(ph), math.sin(ph)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1, y1 = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = max(0.0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
    den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    co = (math.sqrt(num / den) if den else 0.0) * (-1 if large == sweep else 1)
    cxp, cyp = co * rx * y1 / ry, -co * ry * x1 / rx
    cx = cp * cxp - sp * cyp + (p0[0] + p1[0]) / 2
    cy = sp * cxp + cp * cyp + (p0[1] + p1[1]) / 2
    a0 = math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx)
    a1 = math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx)
    d = a1 - a0
    if sweep and d < 0:
        d += math.tau
    elif not sweep and d > 0:
        d -= math.tau
    return [(cx + cp * rx * math.cos(a0 + d * i / n) - sp * ry * math.sin(a0 + d * i / n), cy + sp * rx * math.cos(a0 + d * i / n) + cp * ry * math.sin(a0 + d * i / n)) for i in range(1, n + 1)]


def parse_path(d: str) -> list[tuple[list[tuple[float, float]], bool]]:
    """SVG path data -> [(points, closed)] — curves become short straight pieces."""
    tokens = _TOKEN.findall(str(d))
    subs: list[tuple[list, bool]] = []
    cur: list = []
    pos = (0.0, 0.0)
    start = (0.0, 0.0)
    last_ctrl = None
    cmd = ""
    i = 0

    def flush(closed: bool) -> None:
        nonlocal cur
        if len(cur) >= 2:
            subs.append((cur, closed))
        cur = []

    while i < len(tokens):
        t = tokens[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in "Zz":
                flush(True)
                pos = start
                last_ctrl = None
                continue
        elif not cmd:
            raise ShapeError("a path starts with M x y")
        n = _ARGS[cmd.upper()]
        try:
            a = [float(tokens[i + j]) for j in range(n)]
        except (IndexError, ValueError):
            raise ShapeError(f'path: "{cmd}" needs {n} numbers') from None
        i += n
        rel = cmd.islower()
        C = cmd.upper()

        def pt(x, y):
            return (pos[0] + x, pos[1] + y) if rel else (x, y)

        if C == "M":
            flush(False)
            pos = start = pt(a[0], a[1])
            cur = [pos]
            cmd = "l" if rel else "L"       # further pairs are lines
            last_ctrl = None
        elif C == "L":
            pos = pt(a[0], a[1])
            cur.append(pos)
            last_ctrl = None
        elif C == "H":
            pos = (pos[0] + a[0], pos[1]) if rel else (a[0], pos[1])
            cur.append(pos)
            last_ctrl = None
        elif C == "V":
            pos = (pos[0], pos[1] + a[0]) if rel else (pos[0], a[0])
            cur.append(pos)
            last_ctrl = None
        elif C in "CS":
            if C == "C":
                c1, c2, end = pt(a[0], a[1]), pt(a[2], a[3]), pt(a[4], a[5])
            else:
                c1 = (2 * pos[0] - last_ctrl[0], 2 * pos[1] - last_ctrl[1]) if last_ctrl and last_ctrl[2] == "C" else pos
                c2, end = pt(a[0], a[1]), pt(a[2], a[3])
            cur += _bezier(pos, c1, c2, end)
            last_ctrl = (c2[0], c2[1], "C")
            pos = end
        elif C in "QT":
            if C == "Q":
                q, end = pt(a[0], a[1]), pt(a[2], a[3])
            else:
                q = (2 * pos[0] - last_ctrl[0], 2 * pos[1] - last_ctrl[1]) if last_ctrl and last_ctrl[2] == "Q" else pos
                end = pt(a[0], a[1])
            c1 = (pos[0] + 2 / 3 * (q[0] - pos[0]), pos[1] + 2 / 3 * (q[1] - pos[1]))
            c2 = (end[0] + 2 / 3 * (q[0] - end[0]), end[1] + 2 / 3 * (q[1] - end[1]))
            cur += _bezier(pos, c1, c2, end)
            last_ctrl = (q[0], q[1], "Q")
            pos = end
        elif C == "A":
            end = pt(a[5], a[6])
            cur += _arc_points(pos, a[0], a[1], a[2], bool(a[3]), bool(a[4]), end)
            pos = end
            last_ctrl = None
    flush(False)
    if not subs:
        raise ShapeError("the path has no lines")
    return subs


@shape("path", params={"scale": 1.0, "width": None}, doc='path: "M 10 10 L 90 10 C … Z" — SVG path data (M L H V C S Q T A Z); at: [x, y] moves it, scale resizes it; holes work (even-odd)')
def path(c, p):
    subs = parse_path(p.get("_value") or "")
    s = float(p["scale"])
    ox, oy = (float(p["at"][0]), float(p["at"][1])) if p.get("_at_given") else (0.0, 0.0)
    moved = [([(x * s + ox, y * s + oy) for x, y in pts], closed) for pts, closed in subs]
    closed_ones = [pts for pts, closed in moved if closed and len(pts) >= 3]
    if closed_ones:
        c.paths(closed_ones)
    for pts, closed in moved:
        if not closed:
            c.line(pts, p.get("width"))
