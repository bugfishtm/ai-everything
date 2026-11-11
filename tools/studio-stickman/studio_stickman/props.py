"""Built-in props, backdrops and particles.

Props draw in local coordinates: (0, 0) is where the prop stands on the floor (or the hand that
holds it, with +x pointing along the prop), -y is up. Backdrops draw the whole scenery once in
world coordinates.
"""
from __future__ import annotations

import math

from .api import backdrop, particle, prop
from .skeleton import color, hash01, mix, shade

INK = "#0c0d11"


# ---------------------------------------------------------------------------
# Scenery props (stand on the floor)
# ---------------------------------------------------------------------------
@prop("rect", params={"w": 100, "h": 60, "color": "#6a7386", "outline": INK, "radius": 0}, doc="a plain box: w × h, standing on its base")
def rect(c, p, t):
    c.rect(-p["w"] / 2, -p["h"], p["w"], p["h"], fill=p["color"], outline=p["outline"] or None, width=2.5, radius=p["radius"])


@prop("circle", params={"r": 30, "color": "#d0a040", "outline": INK}, doc="a disc resting on the floor")
def circle(c, p, t):
    c.circle((0, -p["r"]), p["r"], fill=p["color"], outline=p["outline"] or None, width=2.5)


@prop("line", params={"to": [100, 0], "width": 6, "color": "#cfd6e4"}, doc="a line from the origin to `to` [x, y]")
def line(c, p, t):
    c.line((0, 0), tuple(p["to"]), p["width"], p["color"])


@prop("poly", params={"points": [[-40, 0], [40, 0], [0, -70]], "color": "#6a7386", "outline": INK}, doc="a polygon from points [[x, y], …]")
def poly(c, p, t):
    c.poly([tuple(q) for q in p["points"]], fill=p["color"], outline=p["outline"] or None, width=2.5)


@prop("label", params={"text": "Text", "size": 28, "color": "#ffffff", "font": "bold"}, doc="text in the scenery (a sign, graffiti …)")
def label(c, p, t):
    c.text(str(p["text"]), 0, 0, p["size"], p["color"], "mb", p["font"])


@prop("image", params={"file": "", "w": 200}, doc="a picture from the project (PNG with transparency), w = width in px")
def image(c, p, t):
    from PIL import Image

    from . import registry

    path = registry.project_dir() / str(p["file"])
    im = Image.open(path).convert("RGBA")
    k = c.k * p["w"] / im.width
    im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    q = c.p((0, 0))
    c.img.paste(im, (int(q[0] - im.width / 2), int(q[1] - im.height)), im)


@prop("crate", params={"size": 70, "color": "#9a6b3c"}, doc="a wooden crate")
def crate(c, p, t):
    s, col = p["size"], color(p["color"])
    c.rect(-s / 2, -s, s, s, fill=col, outline=INK, width=2.5)
    c.rect(-s / 2 + 7, -s + 7, s - 14, s - 14, fill=shade(col, 14), outline=shade(col, -40), width=2)
    c.line((-s / 2 + 9, -s + 9), (s / 2 - 9, -9), 5, shade(col, -30))


@prop("table", params={"w": 190, "h": 78, "color": "#7a5230"}, doc="a table (side view)")
def table(c, p, t):
    w, h, col = p["w"], p["h"], color(p["color"])
    for x in (-w / 2 + 12, w / 2 - 12):
        c.rect(x - 5, -h, 10, h, fill=shade(col, -22), outline=INK, width=2)
    c.rect(-w / 2, -h - 9, w, 12, fill=col, outline=INK, width=2.5, radius=3)


@prop("desk", params={"w": 210, "h": 78, "color": "#6f4d30", "screen": "#7fd4ff"}, doc="a desk with a monitor and keyboard (sit in front of it: pose type)")
def desk(c, p, t):
    table(c, {"w": p["w"], "h": p["h"], "color": p["color"]}, t)
    top = -p["h"] - 9
    c.rect(18, top - 12, 46, 6, fill="#2a2d35", outline=INK, width=1.5)                      # keyboard
    c.rect(52, top - 58, 6, 50, fill="#30343d")                                              # stand
    c.rect(34, top - 8, 42, 6, fill="#30343d", outline=INK, width=1.5)
    c.rect(-2, top - 96, 96, 62, fill="#191b21", outline=INK, width=2.5, radius=4)
    flick = 0.9 + 0.1 * math.sin(t * 9)
    c.rect(4, top - 90, 84, 50, fill=mix(color(p["screen"]), (10, 12, 18), 1 - flick), radius=2)
    for i in range(4):
        c.line((12, top - 80 + i * 10), (40 + 9 * ((i * 7) % 5), top - 80 + i * 10), 2.4, "#eaf6ff")


@prop("chair", params={"h": 46, "color": "#3d4350"}, doc="a chair (the seat is at sitting height)")
def chair(c, p, t):
    h, col = p["h"], color(p["color"])
    c.line((-18, 0), (-18, -h), 6, shade(col, -16))
    c.line((16, 0), (16, -h), 6, shade(col, -16))
    c.rect(-24, -h - 7, 46, 9, fill=col, outline=INK, width=2, radius=3)
    c.rect(-26, -h - 62, 8, 60, fill=col, outline=INK, width=2, radius=3)


@prop("door", params={"w": 96, "h": 220, "color": "#7b4a2d", "open": 0.0}, doc="a door in its frame; open: 0 (closed) … 1 (open)")
def door(c, p, t):
    w, h, col = p["w"], p["h"], color(p["color"])
    c.rect(-w / 2 - 8, -h - 8, w + 16, h + 8, fill="#22252c", outline=INK, width=2.5)
    k = max(0.08, 1 - float(p["open"]) * 0.92)
    c.rect(-w / 2, -h, w * k, h, fill=col, outline=INK, width=2.5)
    c.rect(-w / 2 + 10 * k, -h + 14, (w - 20) * k, h * 0.4, fill=shade(col, -14), outline=shade(col, -40), width=1.5)
    c.rect(-w / 2 + 10 * k, -h * 0.5 + 6, (w - 20) * k, h * 0.42, fill=shade(col, -14), outline=shade(col, -40), width=1.5)
    c.circle((-w / 2 + (w - 14) * k, -h * 0.47), 5, fill="#d8b24a", outline=INK, width=1.2)


@prop("window", params={"w": 150, "h": 110, "light": "#9fd8ff"}, doc="a window (put it on a wall: y above the floor)")
def window(c, p, t):
    w, h = p["w"], p["h"]
    c.rect(-w / 2 - 6, -h - 6, w + 12, h + 12, fill="#d9dde6", outline=INK, width=2.5)
    c.rect(-w / 2, -h, w, h, fill=p["light"])
    c.line((0, -h), (0, 0), 5, "#d9dde6")
    c.line((-w / 2, -h / 2), (w / 2, -h / 2), 5, "#d9dde6")


@prop("lamp", params={"h": 190, "on": True, "color": "#ffd980"}, doc="a floor lamp with a glow")
def lamp(c, p, t):
    h = p["h"]
    c.rect(-16, -6, 32, 6, fill="#2d3038", outline=INK, width=1.5)
    c.line((0, -6), (0, -h + 30), 5, "#3b3f49")
    if p["on"]:
        for i, r in enumerate((90, 62, 40)):
            c.circle((0, -h + 6), r, fill=color(p["color"]) + (22 + i * 14,))
    c.poly([(-22, -h + 34), (22, -h + 34), (13, -h), (-13, -h)], fill=p["color"] if p["on"] else "#8b8f99", outline=INK, width=2)


@prop("plant", params={"h": 90, "color": "#3f9b58"}, doc="a potted plant")
def plant(c, p, t):
    h, col = p["h"], color(p["color"])
    sway = math.sin(t * 1.3) * 3
    for i, a in enumerate((-50, -22, 8, 34, 58)):
        r = math.radians(a - 90)
        tip = (math.cos(r) * h * (0.7 + 0.08 * (i % 3)) + sway, math.sin(r) * h * (0.7 + 0.08 * (i % 3)) - 28)
        c.poly([(-6, -28), (6, -28), tip], fill=shade(col, -12 + i * 7), outline=INK, width=1.3)
    c.poly([(-20, -30), (20, -30), (15, 0), (-15, 0)], fill="#b5653a", outline=INK, width=2)


@prop("tree", params={"h": 300, "color": "#3d8a4c", "trunk": "#6b4a2e"}, doc="a tree")
def tree(c, p, t):
    h, col = p["h"], color(p["color"])
    c.poly([(-13, 0), (13, 0), (8, -h * 0.5), (-8, -h * 0.5)], fill=p["trunk"], outline=INK, width=2)
    sway = math.sin(t * 0.9) * 4
    for dx, dy, r in ((-46, -h * 0.55, 54), (44, -h * 0.58, 56), (0, -h * 0.78, 68), (-22, -h * 0.68, 48), (26, -h * 0.72, 46)):
        c.circle((dx + sway, dy), r * h / 300, fill=col, outline=INK, width=2)
    for dx, dy, r in ((-40, -h * 0.6, 40), (30, -h * 0.66, 44), (0, -h * 0.82, 52)):
        c.circle((dx + sway, dy), r * h / 300, fill=shade(col, 14))


@prop("bush", params={"w": 120, "color": "#3d8a4c"}, doc="a bush")
def bush(c, p, t):
    w, col = p["w"], color(p["color"])
    for dx, r in ((-w * 0.3, w * 0.24), (w * 0.3, w * 0.25), (0, w * 0.32)):
        c.circle((dx, -r * 0.9), r, fill=col, outline=INK, width=2)
    c.circle((0, -w * 0.3), w * 0.24, fill=shade(col, 14))


@prop("rock", params={"w": 90, "color": "#7b808c"}, doc="a rock")
def rock(c, p, t):
    w, col = p["w"], color(p["color"])
    pts = [(-w * 0.5, 0), (-w * 0.42, -w * 0.3), (-w * 0.12, -w * 0.52), (w * 0.22, -w * 0.46), (w * 0.48, -w * 0.2), (w * 0.52, 0)]
    c.poly(pts, fill=col, outline=INK, width=2.5)
    c.poly([(-w * 0.3, -w * 0.28), (-w * 0.1, -w * 0.45), (w * 0.14, -w * 0.4), (0, -w * 0.22)], fill=shade(col, 18))


@prop("platform", params={"w": 220, "h": 26, "color": "#565c6b"}, doc="a ledge / platform (y = its top edge)")
def platform(c, p, t):
    w, h, col = p["w"], p["h"], color(p["color"])
    c.rect(-w / 2, 0, w, h, fill=col, outline=INK, width=2.5, radius=4)
    c.rect(-w / 2 + 3, 2, w - 6, 5, fill=shade(col, 26))


@prop("sign", params={"text": "EXIT", "w": 130, "h": 54, "color": "#2c6e49", "post": 120}, doc="a sign on a post")
def sign(c, p, t):
    w, h, post = p["w"], p["h"], p["post"]
    c.rect(-4, -post, 8, post, fill="#5b6070", outline=INK, width=1.5)
    c.rect(-w / 2, -post - h, w, h, fill=p["color"], outline=INK, width=2.5, radius=6)
    c.text(str(p["text"]), 0, -post - h / 2, h * 0.5, "#ffffff", "mm", "bold")


@prop("ball", params={"r": 18, "color": "#e8642c"}, doc="a ball (animate it with keys and arc)")
def ball(c, p, t):
    r, col = p["r"], color(p["color"])
    c.circle((0, -r), r, fill=col, outline=INK, width=2.2)
    c.arc((0, -r), r * 0.62, 200, 300, r * 0.14, shade(col, 60), 6)


@prop("trophy", params={"color": "#f0c83c"}, doc="a trophy cup")
def trophy(c, p, t):
    col = color(p["color"])
    c.rect(-16, -8, 32, 8, fill="#4a3a2a", outline=INK, width=1.5)
    c.rect(-4, -26, 8, 18, fill=shade(col, -30), outline=INK, width=1.5)
    c.poly([(-20, -62), (20, -62), (12, -26), (-12, -26)], fill=col, outline=INK, width=2)
    c.arc((-22, -50), 9, 60, 300, 3, shade(col, -20), 8)
    c.arc((22, -50), 9, -120, 120, 3, shade(col, -20), 8)


# ---------------------------------------------------------------------------
# Hand props (origin = the hand, +x = along the prop)
# ---------------------------------------------------------------------------
@prop("sword", params={"length": 96, "color": "#d5dbe6", "hold_angle": 78}, doc="a sword (hand prop)")
def sword(c, p, t):
    n = p["length"]
    c.poly([(10, -4), (n - 12, -4), (n, 0), (n - 12, 4), (10, 4)], fill=p["color"], outline=INK, width=1.6)
    c.line((12, 0), (n - 14, 0), 1.4, "#ffffff")
    c.line((9, -12), (9, 12), 5, "#b08a3a")
    c.line((-12, 0), (7, 0), 6, "#5a3c22")


@prop("bat", params={"length": 92, "color": "#c9a063", "hold_angle": 70}, doc="a baseball bat (hand prop)")
def bat(c, p, t):
    n, col = p["length"], color(p["color"])
    c.poly([(-10, -3.5), (n * 0.45, -4.5), (n, -8), (n + 5, 0), (n, 8), (n * 0.45, 4.5), (-10, 3.5)], fill=col, outline=INK, width=1.6)
    c.line((-10, 0), (8, 0), 7, shade(col, -50))


@prop("stick", params={"length": 120, "color": "#8a6a44", "hold_angle": 80}, doc="a staff / pole (hand prop)")
def stick(c, p, t):
    n = p["length"]
    c.line((-n * 0.35, 0), (n * 0.65, 0), 7.5, INK)
    c.line((-n * 0.35, 0), (n * 0.65, 0), 5, p["color"])


@prop("shield", params={"r": 34, "color": "#3d6fb8", "hold_angle": 90}, doc="a round shield (hand prop)")
def shield(c, p, t):
    r, col = p["r"], color(p["color"])
    c.ellipse((6, 0), r * 0.42, r, fill=col, outline=INK, width=2.2)
    c.ellipse((6, 0), r * 0.2, r * 0.5, fill=shade(col, 40))


@prop("mug", params={"color": "#f2f2f2", "hold_angle": 90}, doc="a mug (hand prop)")
def mug(c, p, t):
    c.rect(-7, -20, 16, 20, fill=p["color"], outline=INK, width=1.6, radius=2)
    c.arc((11, -10), 6, -80, 80, 2.4, INK, 6)
    for i in range(2):
        w = math.sin(t * 3 + i * 2) * 2
        c.line((-1 + i * 6 + w, -24), (0 + i * 6 - w, -32), 1.6, (255, 255, 255, 120))


@prop("phone", params={"color": "#20242c", "hold_angle": 70}, doc="a phone (hand prop)")
def phone(c, p, t):
    c.rect(-5, -24, 12, 26, fill=p["color"], outline=INK, width=1.5, radius=3)
    c.rect(-3, -21, 8, 18, fill="#8fd6ff")


@prop("bottle", params={"color": "#3f9b58", "hold_angle": 85}, doc="a bottle (hand prop)")
def bottle(c, p, t):
    col = color(p["color"])
    c.rect(-6, -22, 12, 24, fill=col, outline=INK, width=1.5, radius=3)
    c.rect(-2.5, -34, 5, 13, fill=col, outline=INK, width=1.5)


@prop("briefcase", params={"color": "#5a3c22", "hold_angle": 0}, doc="a briefcase hanging from the hand (hand prop)")
def briefcase(c, p, t):
    col = color(p["color"])
    c.arc((0, 8), 9, 180, 360, 3, INK, 8)
    c.rect(-24, 8, 48, 32, fill=col, outline=INK, width=2, radius=4)
    c.rect(-4, 20, 8, 6, fill="#d8b24a")


@prop("paper", params={"color": "#f4f1e8", "hold_angle": 60}, doc="a sheet of paper / document (hand prop)")
def paper(c, p, t):
    c.rect(-4, -34, 26, 34, fill=p["color"], outline=INK, width=1.4)
    for i in range(4):
        c.line((0, -28 + i * 7), (18, -28 + i * 7), 1.4, "#8a8f99")


@prop("flag", params={"color": "#d83a3a", "length": 130, "hold_angle": 85}, doc="a flag on a pole (hand prop)")
def flag(c, p, t):
    n, col = p["length"], color(p["color"])
    c.line((-10, 0), (n, 0), 4.5, "#c9ced8")
    # the cloth hangs from the top of the pole; its free edge waves
    w1, w2 = math.sin(t * 5) * 4, math.sin(t * 5 + 1) * 5
    c.poly([(n - 52, -2), (n - 2, -2), (n - 2 + w1, -36), (n - 27 + (w1 + w2) / 2, -38 + math.sin(t * 5 + 0.5) * 2), (n - 52 + w2, -34)],
           fill=col, outline=INK, width=1.5)


@prop("blaster", params={"color": "#4a5364", "hold_angle": 5}, doc="a toy sci-fi blaster (hand prop)")
def blaster(c, p, t):
    col = color(p["color"])
    c.rect(-4, -10, 40, 12, fill=col, outline=INK, width=1.6, radius=3)
    c.rect(-2, 0, 10, 16, fill=shade(col, -20), outline=INK, width=1.6, radius=2)
    c.circle((38, -4), 4, fill="#59e0ff", outline=INK, width=1.2)


# ---------------------------------------------------------------------------
# Backdrops
# ---------------------------------------------------------------------------
def _vgrad(c, w, y0, y1, top, bottom, steps: int = 48) -> None:
    top, bottom = color(top), color(bottom)
    for i in range(steps):
        a = y0 + (y1 - y0) * i / steps
        b = y0 + (y1 - y0) * (i + 1) / steps
        c.rect(0, a, w, b - a + 1, fill=mix(top, bottom, i / (steps - 1)))


@backdrop("plain", params={"color": "#1c2028", "floor": None}, doc="one color (floor: a second color below the floor line)")
def plain(c, w, h, floor, p):
    c.rect(0, 0, w, h, fill=p["color"])
    if p["floor"]:
        c.rect(0, floor, w, h - floor, fill=p["floor"])


@backdrop("gradient", params={"top": "#27304a", "bottom": "#0f1118", "floor": "#0b0c10"}, doc="a vertical gradient with a floor")
def gradient(c, w, h, floor, p):
    _vgrad(c, w, 0, floor, p["top"], p["bottom"])
    c.rect(0, floor, w, h - floor, fill=p["floor"])
    c.line((0, floor), (w, floor), 2, shade(color(p["floor"]), 40))


@backdrop("room", params={"wall": "#d8cdb8", "floor": "#8a6a48", "window": True, "pictures": True}, doc="an indoor room: wall, wooden floor, skirting board, window")
def room(c, w, h, floor, p):
    wall, fl = color(p["wall"]), color(p["floor"])
    _vgrad(c, w, 0, floor, shade(wall, 10), shade(wall, -18))
    c.rect(0, floor, w, h - floor, fill=fl)
    for i in range(0, int(w), 90):
        c.line((i + (i // 90 % 2) * 20, floor + 2), (i - 60, h), 1.5, shade(fl, -22))
    c.rect(0, floor - 16, w, 16, fill=shade(wall, 30), outline=shade(wall, -60), width=1.5)
    if p["window"]:
        x = w * 0.72
        c.poly([(x - 110, floor - 150), (x + 110, floor - 150), (x + 190, h), (x - 60, h)], fill=(255, 250, 220, 26))
        c.rect(x - 96, floor - 330, 192, 150, fill="#eef2f6", outline=shade(wall, -90), width=3)
        _vgrad(c.at((x - 88, floor - 322)), 176, 0, 134, "#8fc4f0", "#d6ecff", 12)
        c.line((x, floor - 322), (x, floor - 188), 6, "#eef2f6")
        c.line((x - 88, floor - 255), (x + 88, floor - 255), 6, "#eef2f6")
    if p["pictures"]:
        x = w * 0.2
        c.rect(x - 50, floor - 300, 100, 76, fill="#3b3f49", outline=shade(wall, -90), width=3)
        c.poly([(x - 44, floor - 232), (x - 14, floor - 268), (x + 8, floor - 244), (x + 24, floor - 262), (x + 44, floor - 232)], fill="#6fae7a")
        c.circle((x + 26, floor - 280), 8, fill="#f3d36b")


@backdrop("street", params={"night": True, "seed": 3}, doc="a city street: sky, skyline with lit windows, pavement")
def street(c, w, h, floor, p):
    night = bool(p["night"])
    _vgrad(c, w, 0, floor, "#0c1230" if night else "#6db3e8", "#3a2f57" if night else "#cfe9ff")
    if night:
        for i in range(70):
            c.circle((hash01(i, 1, p["seed"]) * w, hash01(i, 2, p["seed"]) * floor * 0.6), 0.8 + hash01(i, 3) * 1.2, fill=(255, 255, 255, 150))
        c.circle((w * 0.82, floor * 0.22), 34, fill="#f4f1d8")
    x = -20.0
    i = 0
    while x < w + 40:
        bw = 70 + hash01(i, 4, p["seed"]) * 110
        bh = 120 + hash01(i, 5, p["seed"]) * 300
        col = (22 + int(hash01(i, 6) * 16), 26 + int(hash01(i, 7) * 14), 44 + int(hash01(i, 8) * 20)) if night else (150, 160, 178)
        c.rect(x, floor - bh, bw, bh, fill=col)
        for wy in range(int(floor - bh + 16), int(floor - 20), 30):
            for wx in range(int(x + 12), int(x + bw - 14), 24):
                lit = hash01(wx, wy, p["seed"]) > (0.55 if night else 2)
                c.rect(wx, wy, 11, 15, fill=(255, 214, 120, 230) if lit else shade(col, 16 if night else -20))
        x += bw + 6
        i += 1
    c.rect(0, floor, w, h - floor, fill="#2b2e36" if night else "#8d939e")
    c.rect(0, floor, w, 7, fill="#4a4e59" if night else "#b9bec8")
    for lx in range(0, int(w), 120):
        c.rect(lx + 20, floor + (h - floor) * 0.55, 60, 5, fill=(255, 255, 255, 60))


@backdrop("dojo", params={"wall": "#e9dfc8", "floor": "#b98a55"}, doc="a training hall with paper walls")
def dojo(c, w, h, floor, p):
    wall, fl = color(p["wall"]), color(p["floor"])
    c.rect(0, 0, w, floor, fill=wall)
    for x in range(0, int(w) + 1, 160):
        c.rect(x - 5, 0, 10, floor, fill="#4a3526")
        for y in range(60, int(floor), 80):
            c.line((x, y), (x + 160, y), 2, shade(wall, -40))
        c.line((x + 80, 0), (x + 80, floor), 2, shade(wall, -40))
    c.rect(0, 0, w, 26, fill="#3a281c")
    c.rect(0, floor, w, h - floor, fill=fl)
    for x in range(0, int(w), 200):
        c.line((x, floor), (x - 80, h), 2, shade(fl, -30))
    c.rect(0, floor - 6, w, 8, fill="#3a281c")


@backdrop("rooftop", params={"seed": 5}, doc="a rooftop at night above the city")
def rooftop(c, w, h, floor, p):
    _vgrad(c, w, 0, floor, "#070a1c", "#2b2148")
    for i in range(90):
        c.circle((hash01(i, 1, p["seed"]) * w, hash01(i, 2, p["seed"]) * floor * 0.8), 0.7 + hash01(i, 3) * 1.3, fill=(255, 255, 255, 170))
    c.circle((w * 0.16, floor * 0.24), 44, fill="#f1eed8")
    c.circle((w * 0.16 + 14, floor * 0.24 - 8), 40, fill="#0b0e22")
    x = -10.0
    i = 0
    while x < w + 30:
        bw = 50 + hash01(i, 4, p["seed"]) * 90
        bh = 40 + hash01(i, 5, p["seed"]) * 170
        c.rect(x, floor - bh, bw, bh, fill=(16, 18, 34))
        for wy in range(int(floor - bh + 10), int(floor - 8), 22):
            for wx in range(int(x + 8), int(x + bw - 10), 18):
                if hash01(wx, wy, p["seed"]) > 0.6:
                    c.rect(wx, wy, 7, 10, fill=(255, 205, 110, 200))
        x += bw + 4
        i += 1
    c.rect(0, floor, w, h - floor, fill="#1d1f29")
    c.rect(0, floor - 10, w, 12, fill="#343846", outline="#0c0d11", width=1.5)
    c.rect(w * 0.08, floor - 70, 90, 62, fill="#2a2d39", outline="#0c0d11", width=2)
    c.rect(w * 0.86, floor - 120, 14, 112, fill="#2a2d39", outline="#0c0d11", width=2)


@backdrop("field", params={"sky": "#7cc4f2", "grass": "#5fa85a", "sun": True}, doc="open land: sky, hills, grass")
def field(c, w, h, floor, p):
    sky, grass = color(p["sky"]), color(p["grass"])
    _vgrad(c, w, 0, floor, sky, mix(sky, (255, 255, 255), 0.55))
    if p["sun"]:
        for r, a in ((90, 40), (64, 70), (44, 255)):
            c.circle((w * 0.8, floor * 0.25), r, fill=(255, 240, 170, a))
    for i, (cx, r) in enumerate(((w * 0.18, w * 0.3), (w * 0.62, w * 0.36), (w * 0.95, w * 0.26))):
        c.ellipse((cx, floor + r * 0.42), r, r * 0.7, fill=mix(grass, sky, 0.45 - i * 0.08), n=40)
    for i in range(5):
        cx = hash01(i, 11) * w
        cy = 60 + hash01(i, 12) * floor * 0.3
        for dx, rr in ((-34, 24), (0, 32), (36, 22)):
            c.circle((cx + dx, cy), rr, fill=(255, 255, 255, 210))
    c.rect(0, floor, w, h - floor, fill=grass)
    c.rect(0, floor, w, 6, fill=shade(grass, 26))
    for i in range(60):
        gx = hash01(i, 21) * w
        c.line((gx, floor + 6 + hash01(i, 22) * (h - floor - 10)), (gx + 3, floor - 2 + hash01(i, 22) * (h - floor - 10)), 1.6, shade(grass, -26))


@backdrop("stage", params={"curtain": "#8c1d2c", "floor": "#5a3d28"}, doc="a theatre stage with curtains and a spotlight")
def stage(c, w, h, floor, p):
    cur, fl = color(p["curtain"]), color(p["floor"])
    _vgrad(c, w, 0, floor, "#17121c", "#2a1f2e")
    c.poly([(w * 0.5 - 60, 0), (w * 0.5 + 60, 0), (w * 0.5 + 260, floor), (w * 0.5 - 260, floor)], fill=(255, 245, 210, 22))
    c.ellipse((w * 0.5, floor + 6), 270, 26, fill=(255, 245, 210, 40), n=40)
    for side in (0, 1):
        x0 = 0 if side == 0 else w - w * 0.16
        for i in range(8):
            x = x0 + i * w * 0.02
            c.rect(x, 0, w * 0.021, floor + 4, fill=shade(cur, -18 if i % 2 else 8))
    c.rect(0, 0, w, 46, fill=shade(cur, -30))
    for i in range(0, int(w), 60):
        c.ellipse((i + 30, 46), 30, 16, fill=shade(cur, -10), n=16)
    c.rect(0, floor, w, h - floor, fill=fl)
    c.rect(0, floor, w, 8, fill=shade(fl, 30))


@backdrop("void", params={"color": "#0d0f16", "grid": "#2a3350"}, doc="dark space with a glowing grid floor")
def void(c, w, h, floor, p):
    base = color(p["color"])
    _vgrad(c, w, 0, floor, shade(base, 14), base)
    c.rect(0, floor, w, h - floor, fill=shade(base, -4))
    g = color(p["grid"])
    for i in range(1, 7):
        y = floor + (h - floor) * (i / 6) ** 1.6
        c.line((0, y), (w, y), 1.6, g)
    for i in range(-12, 13):
        c.line((w / 2 + i * 60, floor), (w / 2 + i * 190, h), 1.6, g)
    c.line((0, floor), (w, floor), 2.5, shade(g, 40))


# ---------------------------------------------------------------------------
# Particles — fn(c, x, y, age, u, seed, p): one particle; u = age / life (0 … 1)
# ---------------------------------------------------------------------------
@particle("spark", params={"color": "#ffe9a0", "size": 4, "gravity": 0}, doc="short bright streaks (impacts)")
def spark(c, x, y, age, u, seed, p):
    col = color(p["color"]) + (int(255 * (1 - u)),)
    vx, vy = p["_v"]
    n = math.hypot(vx, vy) or 1.0
    k = p["size"] * 4 * (1 - u)
    c.line((x, y), (x - vx / n * k, y - vy / n * k), max(1.0, p["size"] * 0.6 * (1 - u)), col)


@particle("dust", params={"color": "#cbbfa8", "size": 9}, doc="soft puffs near the floor")
def dust(c, x, y, age, u, seed, p):
    c.circle((x, y), p["size"] * (0.6 + 1.6 * u), fill=color(p["color"]) + (int(120 * (1 - u)),))


@particle("smoke", params={"color": "#b9bdc7", "size": 14, "gravity": -160}, doc="bigger grey clouds that rise")
def smoke(c, x, y, age, u, seed, p):
    c.circle((x, y), p["size"] * (0.7 + 2.0 * u), fill=color(p["color"]) + (int(110 * (1 - u) ** 1.5),))


@particle("debris", params={"color": "#8a6a48", "size": 6}, doc="small tumbling chunks")
def debris(c, x, y, age, u, seed, p):
    lc = c.at((x, y), angle=age * (300 + 500 * hash01(seed, 3)))
    s = p["size"] * (0.6 + hash01(seed, 4))
    lc.rect(-s / 2, -s / 2, s, s, fill=color(p["color"]) + (int(255 * min(1.0, (1 - u) * 3)),), outline="#0c0d11", width=1)


@particle("star", params={"color": "#ffe14d", "size": 9, "gravity": 0}, doc="little stars (dizzy, magic)")
def star(c, x, y, age, u, seed, p):
    lc = c.at((x, y), angle=age * 240)
    r = p["size"] * (1 - u * 0.6)
    pts = []
    for i in range(10):
        rr = r if i % 2 == 0 else r * 0.45
        a = math.radians(-90 + i * 36)
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    lc.poly(pts, fill=color(p["color"]) + (int(255 * min(1.0, (1 - u) * 2.5)),), outline="#7a5a0a", width=1)


@particle("confetti", params={"size": 7, "gravity": 380}, doc="colorful paper pieces")
def confetti(c, x, y, age, u, seed, p):
    cols = ["#ff5a5f", "#ffd23f", "#3ec1d3", "#7bd389", "#b388ff", "#ff9f1c"]
    col = color(cols[int(hash01(seed, 9) * len(cols)) % len(cols)])
    lc = c.at((x + math.sin(age * 7 + seed) * 8, y), angle=age * 500 * (hash01(seed, 5) - 0.5))
    s = p["size"]
    lc.rect(-s / 2, -s / 4, s, s / 2, fill=col + (int(255 * min(1.0, (1 - u) * 4)),))


@particle("drop", params={"color": "#8fd0ff", "size": 4}, doc="drops (sweat, water)")
def drop(c, x, y, age, u, seed, p):
    c.circle((x, y), p["size"] * (1 - u * 0.4), fill=color(p["color"]) + (int(230 * (1 - u)),), outline="#2a5f8a", width=0.8)


@particle("glass", params={"color": "#cfeaff", "size": 9}, doc="shards")
def glass(c, x, y, age, u, seed, p):
    lc = c.at((x, y), angle=age * (400 * (hash01(seed, 6) - 0.5)) + seed * 40)
    s = p["size"] * (0.6 + hash01(seed, 7))
    lc.poly([(-s, s * 0.5), (0, -s), (s * 0.7, s * 0.6)], fill=color(p["color"]) + (int(210 * min(1.0, (1 - u) * 3)),), outline="#6f9ab8", width=1)
