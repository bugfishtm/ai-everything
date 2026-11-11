# Packs — expansion content for the Studio software and for Claude

A pack is a folder with a `pack.json` manifest plus its files. Packs extend the Studio
software (studio-daw, studio-3d, future tools) with instruments, samples, kits, presets,
models, materials, textures, prefabs and plugins — and the manifest is **text the AI reads**
to know what is available and how to use it.

```
my-drums/
  pack.json
  README.md            # optional, shown on the website and readable by Claude
  samples/kick.wav …
```

## pack.json

```json
{
  "id": "my-drums",                       // = folder name; lowercase, digits, . _ -
  "name": "My Drums",
  "version": "1.0.0",
  "type": "music",                        // music | 3d | image | video | general
  "description": "Punchy acoustic one-shots recorded in a small room.",
  "author": "Ada", "license": "CC0-1.0", "homepage": "https://…",
  "tags": ["drums", "acoustic"],
  "software": ["studio-daw"],             // tools the pack is made for (informative)
  "docs": "README.md",
  "items": [                              // or "items.json" for very large packs
    { "id": "kick", "kind": "sample", "name": "Kick", "file": "samples/kick.wav",
      "tags": ["kick", "bd"], "meta": { "pitched": false } },
    { "id": "kit", "kind": "kit", "name": "Full kit",
      "meta": { "map": { "kick": "kick", "snare": "snare", "hat": "hat-closed" } } }
  ]
}
```

Every item has `id` and `kind`; `name`, `file` (relative path), `description`, `tags` and a free
`meta` object are optional. Extra fields are kept for future software. Reference an item from
anywhere as **`pack-id/item-id`**.

## Item kinds understood today

| type | kind | used by | meta |
|------|------|---------|------|
| music | `instrument` | studio-daw | SoundFont preset: `format: sf2`, `bank`, `program` |
| music | `drumkit` | studio-daw | SoundFont kit: `format: sf2`, `bank: 128`, `program` |
| music | `sample` | studio-daw | `root` (note, makes it pitched), `pitched`, `sustain` |
| music | `kit` | studio-daw | `map: { sound-name: item-id or pack/item }` |
| music | `preset` | studio-daw | file = JSON `{ "use": "pad", "attack": 2 }` (or the same in `meta`) |
| music | `loop` | (planned) | `bpm`, `key`, `bars` |
| any | `plugin` | every Studio tool | `target: studio-daw\|studio-3d\|studio-image\|studio-video\|studio-stickman`, `voice` / `shape` (registered name), `params` |
| video | `pose` | studio-stickman | `angles: { T, H, RS, RE, LS, LE, RH, RK, LH, LK, rot?, y? }` — a named pose (list the pack under `use:` in a scene) |
| music / video | `sample` | studio-stickman | any audio item works as a sound effect: `sfx: pack-id/item-id` |
| 3d | `model` | studio-3d | glb / gltf / obj / stl |
| 3d | `prefab` | studio-3d | a `.scene.yaml` used as one object |
| 3d | `material` | studio-3d | file = JSON `{ "color": "#…", "roughness": 0.8, "texture": "x.png" }` |
| image | `image`, `texture`, `sprite`, `font` | studio-image, studio-video | used by reference: `image: pack-id/item-id`, `font: pack-id/item-id` (a .ttf / .otf file) |
| image / video | `palette`, `lut`, … | future use | — |

## Where packs live

Searched in this order (first match of an id wins) — the same order is in `STUDIO_PACKS_PATH`:

1. `<project>/packs/<id>` — packs you are building inside a project
2. personal packs of the user (installed from a project)
3. the **Global Space** (published by users, readable by everyone)
4. system packs shipped with the image (this folder)

## Creating and sharing

```bash
studio packs new my-drums --type music        # packs/my-drums/pack.json in the project
# … add files and items …
studio packs validate packs/my-drums
studio packs install packs/my-drums           # → personal pack (Claude or you)
```

Then publish it on the website (Packs → your pack → Publish). Packs with code (`plugin` items,
`.py`/`.js` files) published by non-admins only *run* after an admin reviewed the code
("Mark code as reviewed"); until then everything else in the pack works.

## Packs in this folder (system packs)

| id | type | content |
|----|------|---------|
| `gm-instruments` | music | all General MIDI instruments + drum kits of the FluidR3 SoundFont |
| `studio-drums` | music | synthesized one-shot drums (kick, snare, hats, toms, cymbals …) + kits |
| `studio-synths` | music | synth presets + an example instrument plugin (acid bass) |
| `basic-3d` | 3d | PBR materials, nature shape plugins (tree, pine, rock, bush), props and a prefab |

A system pack may have an `install.sh` that runs at image build time (to generate or link content).
