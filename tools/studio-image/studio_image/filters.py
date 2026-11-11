"""Filters. Signature: fn(img, p, k) -> img — an RGBA picture in, an RGBA picture out.

`k` is the number of pixels per document unit (sizes in `p` are document pixels: multiply).
The first parameter of a filter is its main one: `{ blur: 6 }` means `{ blur: { radius: 6 } }`.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from .api import filter as register_filter

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
from studio_gfx import color, shifted  # noqa: E402


def _rgb_a(img: Image.Image) -> tuple[Image.Image, Image.Image]:
    return img.convert("RGB"), img.getchannel("A")


def _join(rgb: Image.Image, a: Image.Image) -> Image.Image:
    out = rgb.convert("RGBA")
    out.putalpha(a)
    return out


@register_filter("blur", params={"radius": 6}, doc="Gaussian blur (radius in px)")
def blur(img, p, k):
    r = float(p["radius"]) * k
    return img.filter(ImageFilter.GaussianBlur(r)) if r > 0 else img


@register_filter("sharpen", params={"amount": 1.0, "radius": 2}, doc="unsharp mask")
def sharpen(img, p, k):
    return img.filter(ImageFilter.UnsharpMask(radius=float(p["radius"]) * k, percent=int(150 * float(p["amount"])), threshold=2))


@register_filter("brightness", params={"amount": 1.2}, doc="1 = unchanged, 0 = black")
def brightness(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(ImageEnhance.Brightness(rgb).enhance(float(p["amount"])), a)


@register_filter("contrast", params={"amount": 1.2}, doc="1 = unchanged, 0 = flat gray")
def contrast(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(ImageEnhance.Contrast(rgb).enhance(float(p["amount"])), a)


@register_filter("saturation", params={"amount": 1.3}, doc="1 = unchanged, 0 = gray")
def saturation(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(ImageEnhance.Color(rgb).enhance(float(p["amount"])), a)


@register_filter("hue", params={"shift": 30}, doc="rotate all colors on the color wheel (degrees)")
def hue(img, p, k):
    rgb, a = _rgb_a(img)
    hsv = np.asarray(rgb.convert("HSV")).copy()
    hsv[..., 0] = (hsv[..., 0].astype(np.int32) + int(float(p["shift"]) / 360 * 255)) % 256
    return _join(Image.fromarray(hsv, "HSV").convert("RGB"), a)


@register_filter("grayscale", params={"amount": 1.0}, doc="black and white (amount 0 … 1)")
def grayscale(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(Image.blend(rgb, ImageOps.grayscale(rgb).convert("RGB"), min(1.0, max(0.0, float(p["amount"])))), a)


@register_filter("sepia", params={"amount": 1.0}, doc="old photo brown")
def sepia(img, p, k):
    rgb, a = _rgb_a(img)
    g = ImageOps.grayscale(rgb)
    toned = ImageOps.colorize(g, (40, 26, 13), (255, 240, 210))
    return _join(Image.blend(rgb, toned, min(1.0, max(0.0, float(p["amount"])))), a)


@register_filter("duotone", params={"dark": "#1b1f3b", "light": "#ffd166"}, doc="two colors: shadows → dark, lights → light")
def duotone(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(ImageOps.colorize(ImageOps.grayscale(rgb), color(p["dark"])[:3], color(p["light"])[:3]), a)


@register_filter("invert", params={"amount": 1.0}, doc="negative")
def invert(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(Image.blend(rgb, ImageOps.invert(rgb), min(1.0, max(0.0, float(p["amount"])))), a)


@register_filter("tint", params={"color": "#ff8800", "amount": 0.3}, doc="mix a color into everything")
def tint(img, p, k):
    rgb, a = _rgb_a(img)
    return _join(Image.blend(rgb, Image.new("RGB", rgb.size, color(p["color"])[:3]), min(1.0, max(0.0, float(p["amount"])))), a)


@register_filter("opacity", params={"amount": 0.5}, doc="make everything more transparent (0 … 1)")
def opacity(img, p, k):
    out = img.copy()
    out.putalpha(img.getchannel("A").point(lambda v: int(v * min(1.0, max(0.0, float(p["amount"]))))))
    return out


@register_filter("vignette", params={"amount": 0.5, "size": 0.75, "color": "#000000"}, doc="darker corners (amount 0 … 1, size = where it starts)")
def vignette(img, p, k):
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2)) / math.sqrt(2)
    start = float(p["size"]) * 0.7
    m = np.clip((d - start) / max(0.05, 1 - start), 0, 1) ** 1.6 * float(p["amount"])
    a = np.asarray(img, dtype=np.float32).copy()
    c = np.array(color(p["color"])[:3], dtype=np.float32)
    a[..., :3] = a[..., :3] * (1 - m[..., None]) + c * m[..., None]
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGBA")


@register_filter("grain", params={"amount": 0.08, "seed": 1, "mono": True}, doc="film grain (amount 0 … 1)")
def grain(img, p, k):
    rng = np.random.default_rng(int(p["seed"]))
    a = np.asarray(img, dtype=np.float32).copy()
    shape = a.shape[:2] + ((1,) if p["mono"] else (3,))
    a[..., :3] += (rng.random(shape, dtype=np.float32) - 0.5) * 255 * float(p["amount"])
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGBA")


@register_filter("pixelate", params={"size": 8}, doc="big pixels (size of one in px)")
def pixelate(img, p, k):
    s = max(1, int(round(float(p["size"]) * k)))
    if s <= 1:
        return img
    small = img.resize((max(1, img.width // s), max(1, img.height // s)), Image.BOX)
    return small.resize(img.size, Image.NEAREST)


@register_filter("posterize", params={"levels": 4}, doc="only a few brightness steps per channel")
def posterize(img, p, k):
    rgb, a = _rgb_a(img)
    n = max(2, int(p["levels"]))
    lut = [int(round(round(v / 255 * (n - 1)) / (n - 1) * 255)) for v in range(256)]
    return _join(rgb.point(lut * 3), a)


@register_filter("threshold", params={"level": 0.5}, doc="pure black and white")
def threshold(img, p, k):
    rgb, a = _rgb_a(img)
    t = int(255 * float(p["level"]))
    return _join(ImageOps.grayscale(rgb).point(lambda v: 255 if v >= t else 0).convert("RGB"), a)


@register_filter("outline", params={"width": 4, "color": "#000000"}, doc="a line around everything that is not transparent")
def outline(img, p, k):
    w = max(1, int(round(float(p["width"]) * k)))
    a = img.getchannel("A")
    grown = a.filter(ImageFilter.MaxFilter(min(2 * w + 1, 99) | 1))
    if 2 * w + 1 > 99:  # very wide outlines: several passes
        for _ in range((2 * w + 1) // 99):
            grown = grown.filter(ImageFilter.MaxFilter(99))
    col = color(p["color"])
    back = Image.new("RGBA", img.size, col[:3] + (0,))
    back.putalpha(grown.point(lambda v: int(v * col[3] / 255)))
    back.alpha_composite(img)
    return back


@register_filter("shadow", params={"dy": 8, "dx": 0, "blur": 12, "color": "#00000099"}, doc="a drop shadow under everything that is not transparent")
def shadow(img, p, k):
    col = color(p["color"])
    a = img.getchannel("A").point(lambda v: int(v * col[3] / 255))
    sh = Image.new("RGBA", img.size, col[:3] + (0,))
    sh.putalpha(a)
    sh = shifted(sh, float(p["dx"]) * k, float(p["dy"]) * k)
    if float(p["blur"]) > 0:
        sh = sh.filter(ImageFilter.GaussianBlur(float(p["blur"]) * k))
    sh.alpha_composite(img)
    return sh


@register_filter("glow", params={"radius": 16, "color": None, "strength": 1.0}, doc="light around the shapes (color: default their own colors)")
def glow(img, p, k):
    r = float(p["radius"]) * k
    if p.get("color") is None:
        g = img.filter(ImageFilter.GaussianBlur(r))
    else:
        col = color(p["color"])
        g = Image.new("RGBA", img.size, col[:3] + (0,))
        g.putalpha(img.getchannel("A").filter(ImageFilter.GaussianBlur(r)))
    s = float(p["strength"])
    if s != 1:
        g.putalpha(g.getchannel("A").point(lambda v: int(min(255, v * s))))
    g.alpha_composite(img)
    return g


@register_filter("round", params={"radius": 40}, doc="round the corners of the picture (transparent outside) — icons, cards")
def round_corners(img, p, k):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=float(p["radius"]) * k, fill=255)
    out = img.copy()
    out.putalpha(ImageChops.multiply(img.getchannel("A"), mask))
    return out


@register_filter("chroma", params={"shift": 3}, doc="color fringes: red and blue shifted apart (glitch, lens look)")
def chroma(img, p, k):
    s = int(round(float(p["shift"]) * k))
    if not s:
        return img
    r, g, b, a = img.split()
    return Image.merge("RGBA", (ImageChops.offset(r, s, 0), g, ImageChops.offset(b, -s, 0), a))


@register_filter("flip", params={"axis": "x"}, doc="mirror: x (left ↔ right) or y (top ↔ bottom)")
def flip(img, p, k):
    return ImageOps.mirror(img) if str(p["axis"]).lower().startswith("x") else ImageOps.flip(img)
