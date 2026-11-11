---
name: game-assets
title: Make assets for a game
description: Use when a game needs its own sprites, character animations, sound effects, music or 3D models and they should be made with the Studio tools instead of placeholders.
areas: [game, music, model3d, video]
---

# Make assets for a game

One style for the whole game. Decide it first: palette (4–6 colors), outline or not, pixel
size, and the mood of the sound (chiptune, soft, realistic). Write it at the top of a
`assets/STYLE.md` and keep to it.

## Look for existing ones first

```bash
studio lib search <words> --kind image|audio|music|model3d
studio packs search <words>
```

## Sprites, textures, UI and icons — studio-image

```bash
studio-image new src/art/coin.image.yaml --template pixel       # pixel art: a grid of characters + a palette
studio-image new src/art/wall.image.yaml --template texture     # a seamless texture (512×512)
studio-image new src/art/icon.image.yaml --template icon        # app icon + favicon sizes
studio-image render src/art/coin.image.yaml --preview           # → exports/coin.png — read the preview
studio-image sheet exports/coin-*.png --cols 4 --out assets/coins.png     # frames → one sheet + atlas JSON
```

- Pixel art: `antialias: 1`, 4–8 colors with one dark outline color, a list of grids for the
  frames of an animation; scale it up in the game with `image-rendering: pixelated`.
- Textures tile when their size fits the pattern; blend two or three texture layers.
- Buttons, panels, HUD parts: `rect` with `radius`, gradients, `stroke`, `shadow` — one picture
  per part, or all parts in one picture and cut them in code.
- See the skill `image-design`.

## Character animation — studio-stickman

```bash
studio-stickman new src/hero.stick.yaml --template blank
# one scene holds all animations one after another: idle 0–1 s, walk 1–2.6 s, jump 3–4 s, hit 4.5–5 s
studio-stickman sprite src/hero.stick.yaml --figure hero --from 1 --to 2.6 --frames 8 --size 128 --name hero-walk
```

- Output: `exports/hero-walk-hero-sprite.png` (transparent, one row of cells) and `.json` with the
  frames, `fps` and the `anchor` (where the feet are inside a cell — put that point on the ground).
- The figure stays in the middle of each cell; `dx` per frame tells how far it moved (use it or
  move the sprite in code).
- Loops (walk, run, idle): choose `--from/--to` so the last frame leads into the first.
- Draw with the atlas: `ctx.drawImage(img, f.x, f.y, f.w, f.h, x - anchor.x, y - anchor.y, f.w, f.h)`.

## Sound effects and music — studio-daw

```bash
studio-daw sfx list                                   # jump, coin, hit, explosion, laser, click, win, lose …
studio-daw sfx jump,coin,hit,hurt,win,lose --out assets/sfx
studio-daw sfx hit --variants 4 --out assets/sfx      # hit-1.wav … hit-4.wav: play a random one each time
studio-daw sfx laser --pitch 1.4 --dur 0.7 --out assets/sfx/pew.wav
```

- Shape with `--pitch` (higher / lower), `--dur` (shorter / longer) and `--seed`; keep one family
  of sounds for the whole game. Something special: a one-bar song with a single note, or an
  instrument plugin (`studio-daw plugin new`).
- Music: `studio-daw new src/theme.song.yaml --template chiptune|lofi|house|basic`, a loop that ends
  where it starts (no fade-out), `master: { target: -16 }` so effects stay on top.
  See the skill `song-production`.

## 3D models — studio-3d

```bash
studio-3d new src/models/<name>.scene.yaml --template props
studio-3d build src/models/<name>.scene.yaml --preview      # → exports/<name>.glb, read the preview PNG
```

Low triangle counts for the web (props under 2 000, characters under 8 000), few materials,
real-world scale (1 unit = 1 m), standing on y = 0.

## Put them in the game

Copy the results to `assets/` (keep the sources in `src/`), load them with relative URLs, and
check with `studio-browser shot index.html` that they show up. Save assets worth keeping to the
library: `studio lib add assets/<file> --name "…" --tags …`.
