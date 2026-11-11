# studio-3d — 3D models from text

Scenes are YAML files (`*.scene.yaml`): the save format, readable and editable by you and
Claude. `studio-3d build` turns them into a binary glTF (`.glb`) for games, the website viewer
and the asset library, and renders a 4-view preview (perspective, front, side, top) that Claude
reads to *see* the result.

```bash
studio-3d new src/house.scene.yaml           # starter (--template basic|props|terrain|organic|textured)
studio-3d check src/house.scene.yaml         # validate fast: names, parameters, materials, textures
studio-3d build src/house.scene.yaml --preview   # → exports/house.glb + .studio/previews/house.png
studio-3d build src/house.scene.yaml --format glb,stl,obj    # also for 3D printing and other 3D programs
studio-3d preview exports/house.glb          # preview any model (glb, gltf, obj, stl …)
studio-3d info assets/library/chest/chest.glb  # triangles, size, materials, textures — and the scene it was built from
studio-3d shapes tree                        # shapes, modifiers, pack models (with parameters)
studio-3d materials wood                     # material presets, pack materials, material options
studio-3d textures bricks                    # procedural textures, UV projections, texture maps, pictures of the project
```

**Conventions:** Y is up, 1 unit = 1 metre, every shape **stands on y = 0** and is centred on x/z.
So `position: [2, 0, -1]` puts an object on the ground; to stack, use the height of what is below.
Rotations are degrees `[x, y, z]`.

**The same file opens in the website's 3D editor** (Files → a `.scene.yaml` → *3D editor*): move,
rotate and scale with the mouse, change shapes and materials, lay textures — every change is
written back into this text, only the touched part, comments stay. What a person does there and
what Claude writes here is the same file.

## Scene file

```yaml
scene:
  name: Camp
  # smooth_angle: 40          # edges sharper than this stay hard (see Shading)
  # texture_format: jpg       # smaller files for color textures; texture_max: 2048 = largest side

materials:                                   # name → definition (or a preset / pack material)
  canvas: { color: "#c9b48a", roughness: 0.95 }
  lamp:   { color: "#fff3c4", emissive: "#ffb347" }      # glowing
  steel:  metal                              # preset (studio-3d materials)
  pine:   basic-3d/pine-needles              # pack material
  wall:   { texture: { type: bricks, colors: ["#3a2b26", "#b5563c"] }, bump: 1.5, texture_scale: 1.2 }
  logo:   { texture: assets/logo.png, uv: fit }          # the picture once on the object

objects:
  - { name: ground, shape: plane, size: [20, 20], material: grass }
  - { name: tent, shape: cone, radius: 1.6, height: 2.2, segments: 4, rotation: [0, 45, 0], material: canvas }
  - name: lantern                            # a group = hierarchy; children are relative to it
    position: [2, 0, 1]
    group:
      - { shape: cylinder, radius: 0.04, height: 1.4, material: steel }
      - { shape: sphere, radius: 0.14, position: [0, 1.4, 0], material: lamp }
  - name: fence
    shape: box
    size: [0.1, 1, 0.1]
    position: [-4, 0, -4]
    repeat: { count: 9, offset: [1, 0, 0] }  # copies (rotate / scale per step also possible)
    material: wood
  - name: rocks
    use: basic-3d/rock                       # pack shape plugin with parameters
    params: { size: 0.6 }
    scatter: { count: 20, area: [18, 18], seed: 4, scale: [0.5, 1.5], min_distance: 1, avoid: [[0, 0, 3]] }
  - { name: chest, model: assets/models/chest.glb, position: [-2, 0, 2], scale: 0.5 }   # project file
  - { name: tree, use: basic-3d/pine-tree, position: [5, 0, -3] }                        # pack model
  - name: arch
    boolean:                                 # union | difference | intersection (closed shapes)
      op: difference
      objects:
        - { shape: box, size: [3, 3, 0.6] }
        - { shape: cylinder, radius: 0.9, height: 1, rotation: [90, 0, 0], position: [0, 1.4, -0.5] }
    material: stone
  - name: rock
    shape: sphere
    radius: 0.5
    detail: 2
    modifiers: [ { type: noise, amount: 0.12, scale: 2 }, flat ]
    material: rock

camera: { position: [9, 6, 10], target: [0, 1, 0] }   # optional, for the perspective preview
```

Object keys: `name`, one of `shape` / `use` / `model` / `group` / `boolean`, shape parameters
(inline or under `params`), `position`, `rotation`, `scale` (number or `[x, y, z]`), `material`
(name, preset, `#hex` or an inline mapping), `modifiers`, `repeat`, `scatter`, `visible: false`,
`shading` / `smooth_angle`, `uv` (texture mapping of this object only), `note`.
Repeated and scattered copies share one mesh in the `.glb` (instancing: small files).

### Shapes

| shape | parameters |
|-------|-----------|
| `box` | `size: [x, y, z]` |
| `sphere` | `radius`, `detail` (1–5) |
| `cylinder` | `radius`, `height`, `segments`, `radius_top` (frustum) |
| `cone` | `radius`, `height`, `segments` (4 = pyramid) |
| `capsule` | `radius`, `height` |
| `torus` | `radius`, `tube`, `segments`, `sides` (lies flat) |
| `plane`, `disc` | `size: [x, z]` / `radius` (facing up) |
| `extrude` | `points: [[x, z], …]`, `height`, `holes` — floor plans, walls, letters, signs |
| `lathe` | `profile: [[radius, y], …]`, `segments` — vases, columns, bottles, wheels |
| `tube` | `path: [[x, y, z], …]`, `radius` (one value or one per point) — pipes, branches, cables |
| `terrain` | `size: [x, z]`, `resolution`, `height`, `seed`, `octaves`, `roughness`, `scale`, `flat` |
| `mesh` | `vertices`, `faces` — raw triangles |
| `loft` | `sections: [[at, width, height, y], …]`, `axis` (x/y/z), `segments`, `smooth`, `round` — smooth bodies: fish, bottles, boats, fuselages, limbs |
| `blob` | `parts: [{sphere/ellipsoid/capsule/box/torus …}]`, `blend`, `resolution`, `smooth` — organic sculpts: creatures, characters, rocks, fins |

### Organic models: `loft` and `blob`

Living things are rarely boxes. Two shapes make them easy — start from
`studio-3d new src/fish.scene.yaml --template organic`:

```yaml
- name: body                     # cross-sections along x, head at +x
  shape: loft
  axis: x
  sections:                      # [at, width, height, y]  (round: 2 ellipse, 4 rounded box)
    - [-0.5, 0.03, 0.08, 0.6]
    - [ 0.0, 0.22, 0.38, 0.6]
    - [ 0.5, 0.04, 0.06, 0.6]
  segments: 48                   # around;  smooth: 10 = sections added between the given ones
- name: creature                 # primitives melted into one surface
  shape: blob
  blend: 0.08                    # how far parts melt together (m)
  resolution: 128                # 64 draft · 96 default · 160+ high poly
  parts:
    - { ellipsoid: [0.4, 0.3, 0.3], at: [0, 0.5, 0] }
    - { sphere: 0.22, at: [0.45, 0.75, 0] }
    - { capsule: [0.08, 0.05], from: [0.2, 0.3, 0.15], to: [0.25, 0, 0.2] }   # tapered leg
    - { box: [0.2, 0.2, 0.2], at: [0.6, 0.7, 0], round: 0.05 }
    - { sphere: 0.05, at: [0.62, 0.8, 0.12], subtract: true }               # carve an eye socket
```

Part types: `sphere: r`, `ellipsoid: [rx, ry, rz]`, `capsule: r | [r_from, r_to]` with `from`/`to`,
`box: [x, y, z]` (+ `round`), `torus: [R, r]`; each takes `at`, `rotation`, `blend`, `subtract`.
Several parts of one model: give them `absolute: true` — their coordinates stay exactly as written
(one coordinate system for the whole model) instead of standing on y = 0. Use `modifiers: [smooth]`
for extra softness, a higher `resolution`/`segments` for high-poly output.

### Modifiers

`subdivide {iterations}`, `smooth {iterations}`, `noise {amount, scale, seed}`, `taper {top}`,
`twist {degrees}`, `bend {degrees}`, `flat` (faceted low-poly), `smooth_shading` — applied in order,
before the object is placed: `modifiers: [ { type: noise, amount: 0.1 }, flat ]`.

### Shading

Every model is exported with normals. `shading: auto` (the default) keeps round surfaces smooth
and edges sharper than `smooth_angle` (40°) hard — a cylinder is round with flat caps, a box has
six flat sides, an 8-sided column is faceted, a 12-sided one is round. `shading: flat` gives the
faceted low-poly look (the same as the `flat` modifier), `shading: smooth` rounds everything.
`smooth_angle` can be set per object or for the whole scene (`scene: { smooth_angle: 30 }`).

### Materials

PBR: `color` (`#rrggbb`, `#rrggbbaa` or `[r, g, b]`), `metallic` 0–1, `roughness` 0–1,
`emissive` (+ `emissive_strength`), `opacity` (glass/water), `double_sided`, `alpha`
(`opaque` · `blend` · `cutout` for textures with holes; `alpha_cutoff`).
A material can stand on another one: `{ use: wood, roughness: 0.5 }` (a preset, a pack material
or another material of the scene). Presets: white black gray red green blue yellow orange purple
pink wood dark-wood bark leaves grass dirt sand snow stone rock concrete brick marble metal steel
iron gold silver copper chrome plastic rubber glass water ice skin fabric leather lamp lava
neon-blue neon-pink.

## Textures

A material gets a picture with `texture:`. The source can be:

```yaml
materials:
  photo:  { texture: assets/wall.png }                       # an image file of the project (png, jpg, webp …)
  drawn:  { texture: src/wall.image.yaml }                   # a studio-image picture — rendered when the scene is built
  bricks: { texture: bricks }                                # a procedural texture by name (studio-3d textures)
  wall:                                                      # … with its options
    texture: { type: bricks, colors: ["#3a2b26", "#8f3f2c", "#b5563c"], width: 128, height: 64, mortar: 8, resolution: 512 }
  sign:                                                      # a whole picture written right here (studio-image layers)
    texture:
      size: [512, 256]
      background: "#f2e8c9"
      layers:
        - { text: "OPEN", at: [256, 128], size: 120, font: bold, fill: "#3a2616" }
    uv: fit
```

Procedural textures and pictures are made by **studio-image** — every texture, filter and plugin
that tool has (also `plugins/image/*.py` of the project) works here: `noise clouds grain marble
wood stripes checker dots grid bricks cells stars waves rays`. `colors` go from dark to light,
`resolution` is the size in pixels (default 512; choose it so the pattern fits: bricks of
`width: 128` in 512 px), `seed` changes the random pattern, `filters: [ … ]` are studio-image
filters. Without `color`, a texture shows as it is; with `color` it is tinted (multiplied).

### How the picture lies on the object (UV mapping)

```yaml
materials:
  wall:   { texture: bricks, texture_scale: 1.2 }            # box (default): 1.2 m per repeat on every side
  floor:  { texture: checker, uv: planar, texture_scale: 2 } # from above
  label:  { texture: …, uv: { projection: cylinder, repeat: [2, 1] } }   # around the object, twice
  planet: { texture: …, uv: sphere }
  poster: { texture: assets/poster.png, uv: fit }            # the picture exactly once, seen from the front
objects:
  - { shape: box, material: wall, uv: { scale: 0.5, rotation: 45 } }     # only for this object
```

| projection | what it does |
|-----------|--------------|
| `box` | six-sided projection; every side starts at its lower left corner. `scale` = metres per repeat. Walls, floors, rocks — works on anything. |
| `planar` | flat along `axis` (default `y` = from above). Ground, decals. |
| `cylinder` | wrapped around `axis` (default `y`); the middle of a repeat faces the front (+z), the seam is at the back, caps are seen from above. `repeat: [around, up]` or `scale`. Bark, labels, columns. |
| `sphere` | wrapped like a globe. `repeat: [around, up]`. Planets, balls, eyes. |
| `fit` | the picture exactly once over the object, seen along `axis` (default `z` = front). Signs, posters, screens. |
| `mesh` | the UVs the model already has (imported models keep theirs automatically). |

Options: `projection`, `axis` (x/y/z), `scale` (metres per repeat, a number or `[u, v]`), `repeat`
(`[u, v]`), `offset` (`[u, v]`, 1 = one whole repeat), `rotation` (degrees). On a material they can
also be written as `texture_scale`, `texture_repeat`, `texture_offset`, `texture_rotation`.
`texture_filter: nearest` keeps pixel art sharp, `texture_wrap: repeat | clamp | mirror`.

### Relief and more maps

```yaml
materials:
  wall:
    texture: { type: bricks, colors: ["#3a2b26", "#b5563c"] }
    bump: 1.5                              # relief from the texture itself: light = high (0 flat … 3 deep)
  plate:
    use: steel
    texture: { type: cells, colors: ["#6f757c", "#c9ced4"], count: 60 }
    bump_map: { type: noise, scale: 24 }   # relief from another picture (white = high)
    roughness_map: { type: noise, scale: 32 }     # white = rough, black = glossy
    metallic_map: assets/rust-mask.png            # white = metal
  window: { color: "#111111", emissive_map: assets/lit-windows.png, emissive_strength: 3 }
  crate:  { texture: assets/crate.png, normal_map: assets/crate-normal.png, occlusion_map: assets/crate-ao.png }
```

Every map takes the same sources as `texture`. `bump` / `bump_map` are turned into a normal map
when the scene is built; a ready-made `normal_map` wins. With a `roughness_map` the `roughness`
value multiplies it (default 1), the same for `metallic_map`. All maps of a material share its
mapping. `studio-3d textures` lists everything; `studio-3d check` says which texture could not be
made and why (the model is still built, without it).

## Formats

`studio-3d build <scene> --format glb,obj,stl,ply` — `glb` (default): games, the web, the
library, with materials and textures · `obj`: other 3D programs (a folder with `.obj`, `.mtl`
and the textures) · `stl`: 3D printing · `ply`: scanning tools (both: the shape only, placements
applied). A `.glb` built here remembers its scene file: `studio-3d info x.glb` shows it, and the
website's viewer offers **Edit scene**.

## Packs

`use: pack/item` places pack `model`s (glb/gltf/obj/stl), `prefab`s (a `.scene.yaml` inside a
pack) and `plugin` shapes; `materials: { x: pack/item }` uses pack `material`s (JSON with the
fields above — also textures, relative to the file). Find them with `studio-3d shapes <words>`,
`studio-3d materials <words>` or `studio packs search <words> --type 3d`.

## Extending studio-3d (plugins)

```bash
studio-3d plugin new table                  # → plugins/3d/table.py (shape)
studio-3d plugin new wobble --kind modifier # → plugins/3d/wobble.py
```

```python
from studio3d.api import shape, modifier, box, cylinder, cone, sphere, lathe, tube, place, merge, np, trimesh

@shape("table", params={"height": 0.75, "width": 1.2, "depth": 0.7}, doc="Simple table",
       ui={"height": {"min": 0.3, "max": 1.5, "step": 0.05}})       # optional: how the website editor shows a parameter
def table(p):
    top = place(box([p["width"], 0.05, p["depth"]]), y=p["height"] - 0.05)
    parts = [(top, "wood")]
    for x in (-1, 1):
        for z in (-1, 1):
            leg = cylinder(radius=0.03, height=p["height"] - 0.05, segments=10)
            parts.append((place(leg, x=x * (p["width"] / 2 - 0.06), z=z * (p["depth"] / 2 - 0.06)), "metal"))
    return parts                       # a trimesh mesh, or [(mesh, material name), …]
```

All `plugins/3d/*.py` of the project load automatically and appear in the website editor's
**Add** list with their parameters. A plugin that fails to load does not break other scenes
(`studio-3d shapes` shows the error). `ui` hints: `min`, `max`, `step`, `int`, `choices`.
Share plugins in a pack (item `kind: plugin`, `file: plugins/table.py`,
`meta: { target: studio-3d, shape: table, params: {…} }`), install with `studio packs install`,
publish on the website. Plugin code in Global Space packs only runs after an admin reviewed it.
New *textures* are studio-image plugins: `studio-image plugin new <name> --kind texture`.

## Tips

- Build up in steps: blockout with boxes/cylinders → check the preview → refine → materials → textures.
- Always look at the preview after a build; check the size line (metres!) against reality.
- Colors in the preview and in the website editor are the colors of the file (neutral light).
- Keep games light: low `segments`/`detail`, `shading: flat` for a low-poly look, `repeat`/`scatter`
  for copies, textures of 256–512 px (`scene: { texture_format: jpg }` for small files).
- Save finished models with their source: `studio lib add exports/x.glb src/x.scene.yaml --name … --kind model3d`.
