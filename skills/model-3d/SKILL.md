---
name: model-3d
title: Build a 3D model
description: Use when the user asks for a 3D model, prop, building, vehicle, character blockout or a kit of parts made with studio-3d — or to change, retexture or re-export one — delivered as .glb (also .stl for 3D printing).
areas: [model3d, game]
---

# Build a 3D model

Models are built like with building blocks: big shapes first, details last, and a look at the
preview after every step.

## 1. Brief

What is it, how big in metres, which style (low-poly, blocky, smooth), where it is used (game:
triangle budget; viewer: more detail is fine), which parts must be separate nodes (a lid, a
door, wheels) so they can be animated later.

## 2. Block out

```bash
studio-3d new src/<name>.scene.yaml --template basic|props|terrain|organic|textured
studio-3d shapes <words>         # shapes, modifiers and pack models with parameters
studio-3d materials <words>      # presets, pack materials, material options
studio-3d textures <words>       # procedural textures, UV projections, texture maps
```

Changing an existing model: the scene file is the model. `studio-3d info exports/<name>.glb` names
the scene it was built from. The user may have edited it in the website's 3D editor — read it
again first and keep what they did.

- Conventions: Y is up, 1 unit = 1 m, every shape stands on y = 0 and is centred on x/z.
- Start with 3–6 large shapes that give the silhouette. Build, look, correct proportions.
- Use `group:` for parts that belong together; children are placed relative to the group.

## 3. Look at it — every step

```bash
studio-3d check src/<name>.scene.yaml
studio-3d build src/<name>.scene.yaml --preview      # read .studio/previews/<name>.png (4 views)
```

In the four views check: Does it stand on the ground (not sunk in, not floating)? Are parts
touching that should touch? Do the proportions match the real thing from front AND side? Is
anything inside out or missing from one view?

## 4. Detail and materials

- Add the 5–10 details that make it recognisable (handle, rim, window frames); skip what is
  invisible at the size it will be seen.
- Booleans cut openings; scatter places many small things (grass, rivets); modifiers bend and taper.
- 2–5 materials are enough: one main, one secondary, one accent, glass or light if needed.
  Roughness high (0.7–0.95) for most things; metal only where it is metal.
- Textures where a plain color looks like plastic — walls, floors, wood, fabric, labels:
  `texture: { type: bricks, colors: ["#3a2b26", "#b5563c"] }` + `bump: 1` for relief,
  `texture_scale` = metres per repeat. Lay it with `uv: box` (default) / `cylinder` / `sphere` /
  `fit` (one picture: signs, screens). Own pictures: draw them with studio-image
  (`src/<name>.image.yaml`) and name the file as the texture. Keep them 256–512 px.
- Round things look round by themselves (`shading: auto`); `shading: flat` gives low-poly facets.

## 5. Budget and delivery

`studio-3d info exports/<name>.glb` — triangles, size, materials. Web/game props: under 2 000
triangles; hero objects under 10 000. Lower `segments` on round shapes first when it is too heavy.

Deliver `exports/<name>.glb`, say size, triangles and the separate nodes — and that the scene
opens in the 3D editor for changes by hand. For 3D printing add `--format stl`. Missing a shape?
`studio-3d plugin new <name> --kind shape` adds one in Python.
