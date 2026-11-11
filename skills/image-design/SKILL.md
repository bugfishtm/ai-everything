---
name: image-design
title: Design a picture
description: Use when the user asks for a poster, cover, thumbnail, banner, logo, app icon, favicon, texture, sprite or pixel art made with studio-image — from an idea to exported files that were looked at.
areas: [image, game, web, video, android, windows, general]
---

# Design a picture

A good picture has one idea, few colors and a clear order of what the eye sees first.

## 1. Brief (decide what is not said)

What is it for (store page, video thumbnail, app icon, game), the size it will be seen at,
the mood in two words, the text that must appear — word for word. Sizes that are usually right:
cover / thumbnail 1280×720 · social banner 1200×630 · app icon 512×512 (+ small sizes) ·
favicon 32 / 180 · game texture 512×512 or 1024×1024 · pixel sprite 16–64 px per frame.

## 2. Plan before drawing

Write it as comments at the top of the file:

- the palette: 3–4 colors + black/white (take them from a reference with
  `studio-image palette <image> --colors 5` when the user gave one)
- the focus: the one thing that is biggest and brightest
- three depths: background (gradient, texture at low opacity) · subject · text

## 3. Build

```bash
studio-image new src/<name>.image.yaml --template poster|icon|pixel|texture|banner|blank
studio-image list shapes          # also: textures, filters, fonts
```

- Put the colors into `image.palette` and use the names — changing the look later is one edit.
- Background first: `{ gradient: [...] }`, a texture layer at `opacity: 0.1–0.3`, soft color
  glows (`ellipse` + `blur: 80–140`).
- Shapes: built-in ones, or `path: "M … Z"` with SVG path data for anything custom (logos).
  `stroke` gives one outline around overlapping parts; `mask:` cuts a picture or texture to a shape.
- Text: at most two fonts (`bold` for titles, `sans` for small text), `width:` so long lines wrap,
  `shadow` or `box` on busy backgrounds, a margin of 5 % to the edges.
- Finish with `filters: [ { vignette: 0.3 }, { grain: 0.04 } ]` — subtle, or not at all for icons.

## 4. Look — every time

```bash
studio-image check src/<name>.image.yaml
studio-image render src/<name>.image.yaml --preview     # read .studio/previews/<name>.png
```

Check in the preview and the report: Is the focus obvious at a glance? Can every text be read
(contrast below 0.1 in the report = flat)? Is anything cut off or outside the picture (warnings)?
Does it still work small — render icons and thumbnails with `--scale 0.25` and look again.

## 5. Kinds with their own rules

- **App icons / logos:** one simple shape on a plain or gradient plate (`rect` with `radius`), no
  thin lines, no text smaller than a third of the icon. Export sizes in one go:
  `export: [ { format: png }, { format: png, sizes: [16, 32, 48, 180, 192] }, { format: ico, sizes: [16, 32, 48] } ]`.
- **Pixel art:** `antialias: 1`, a `pixels:` grid with a small palette (4–8 colors, one dark outline
  color), light from the top left. Frames of an animation: a list of grids. Resized copies with
  `smooth: false`.
- **Textures:** `--template texture`, power-of-two sizes, two or three texture layers blended
  (`overlay`, `soft_light`) instead of one. Check tiling: place it 2×2 with `repeat` in a test picture.
- **Thumbnails:** a face or object large on one side, 2–4 words in huge type on the other, strong outline or shadow.

## 6. Deliver

The files of `export:` are in `exports/`. Say the sizes and formats, and what you would vary
next (a second color scheme is one palette edit away — offer it).
