# Basic 3D

```yaml
objects:
  - { name: oak, use: basic-3d/tree, height: 5, seed: 3, position: [2, 0, 0] }
  - name: forest
    use: basic-3d/pine
    scatter: { count: 30, area: [30, 30], seed: 2, scale: [0.8, 1.3], min_distance: 2 }
  - { use: basic-3d/rock, size: 1.4, seed: 7, position: [-3, 0, 1] }
  - { use: basic-3d/crate, position: [1, 0, 3] }
  - { use: basic-3d/campfire }
  - { shape: box, size: [4, 0.2, 4], material: basic-3d/granite }
  - { shape: box, size: [6, 2.4, 0.3], material: basic-3d/brick-wall }      # textured: bricks with relief
```

| item | kind | parameters |
|------|------|-----------|
| `tree` | shape plugin | height, canopy, trunk, blobs, seed |
| `pine` | shape plugin | height, radius, layers, trunk, seed |
| `rock` | shape plugin | size, detail, roughness, flatness, seed |
| `bush` | shape plugin | size, blobs, seed |
| `crate` `barrel` `fence` `lamp-post` | model (.glb, text sources in `src/`) | — |
| `campfire` | prefab (scene) | — |
| `oak pine-needles bark granite mossy-rock clay-roof sand water iron ember` | material | — |
| `brick-wall floorboards wood-grain roof-tiles cobblestone floor-tiles concrete-rough meadow rusty-metal` | textured material | change it in your scene: `materials: { wall: { use: basic-3d/brick-wall, texture_scale: 2 } }` |

The textured materials are procedural (made by studio-image when the scene is built — no image
files): open one (`materials/brick-wall.json`) to see how a texture, its relief and its scale are
written, and copy it into your scene to change the colors.

The shape plugins live in `plugins/nature.py` — read them to learn how to write your own
(`studio-3d plugin new <name>`).
