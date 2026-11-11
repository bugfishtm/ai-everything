### 3D models — with studio-3d

Models are text: `src/*.scene.yaml` (shapes, groups, booleans, repeat/scatter, modifiers, PBR
materials with textures, pack models). **Read the reference once: `studio-3d docs`.**

```bash
studio-3d check src/model.scene.yaml               # fast validation
studio-3d build src/model.scene.yaml --preview     # → exports/model.glb + .studio/previews/model.png
studio-3d build src/model.scene.yaml --format glb,stl   # stl for 3D printing, obj for other programs
studio-3d shapes <words>                           # shapes, modifiers, pack models/plugins
studio-3d materials <words>                        # material presets + pack materials + options
studio-3d textures <words>                         # procedural textures, UV projections, maps, pictures of the project
studio-3d info <any model>                         # triangles, size, materials — and the scene it was built from
studio packs search <words> --type 3d
```

**The user edits the same file.** The website opens every `*.scene.yaml` in a visual 3D editor
(move / rotate / scale with the mouse, shapes, materials, textures); each change is written into
the text. So: keep scenes readable (names on objects, materials under `materials:`), read the file
again before you change it — the user may have moved things — and change only what was asked.
To change a model that exists only as `exports/x.glb`: `studio-3d info` names its scene file.

**Conventions:** Y up, metres, every shape stands on y = 0 centred on x/z; rotations in degrees.

**Organic things** (animals, characters, plants, food, smooth products): use `loft` (smooth body
through cross-sections — fish, bottles, boats) and `blob` (spheres/ellipsoids/capsules melted
together — creatures, characters; `resolution: 160` for high poly). Start from
`studio-3d new src/<name>.scene.yaml --template organic` (a fish) and adapt it.

**Textures:** a material's `texture:` is an image file, a studio-image picture
(`src/x.image.yaml`, rendered while the scene is built) or a procedural texture written in place:
`{ type: bricks, colors: [dark, light], resolution: 512 }` (`studio-3d textures` lists them; new
ones are studio-image plugins). Lay it with `uv:` — `box` (default, `texture_scale` metres per
repeat), `planar`, `cylinder`, `sphere`, `fit` (a picture once: signs, screens). `bump: 1` gives
relief from the texture itself; more maps: `normal_map`, `roughness_map`, `metallic_map`,
`emissive_map`. Start from `studio-3d new src/<name>.scene.yaml --template textured`.

**Work in small steps:** a first rough version within a few minutes, build + look at the preview,
then refine. Prefer a short scene file using the built-in shapes over a long custom script — the
user waits while you write, and small files are faster to check and change.

**Look at every build:** read the preview PNG (perspective, front, side, top) and the size line —
compare it with the real object (a door is ~2 m, a chair seat ~0.45 m). The preview shows the
colors of the file. Keep game assets light (low segments/detail, `shading: flat` for low-poly,
textures of 256–512 px).

**Packs:** `basic-3d` (tree/pine/rock/bush shapes, crate/barrel/fence/lamp models, campfire
prefab, materials) and whatever the user installed. Search the asset library too
(`studio lib search … --kind model3d`).

**Extend the tool yourself** when a shape or modifier is missing: `studio-3d plugin new <name>`
writes `plugins/3d/<name>.py` (Python: `studio3d.api`, trimesh, numpy) — then use
`shape: <name>` with parameters. Reusable generators belong in a pack
(`studio packs new my-props --type 3d` … `studio packs install packs/my-props`).

Deliverables: `.glb` in `exports/`. Save finished models with their text source to the library
(`studio lib add exports/x.glb src/x.scene.yaml --name … --kind model3d --tags …`).
