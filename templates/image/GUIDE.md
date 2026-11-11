### Image — with studio-image

Pictures are text: `src/*.image.yaml` — a size, a background and a stack of layers (shapes, SVG
paths, text, pictures, procedural textures, pixel art) with fills, strokes, shadows, masks, blend
modes and filters. **Read the reference once: `studio-image docs`.**

```bash
studio-image new src/cover.image.yaml --template poster   # starters: poster icon pixel texture banner blank
studio-image check src/cover.image.yaml              # fast validation (names, options, files, fonts)
studio-image render src/cover.image.yaml --preview   # → exports/cover.png (+ the export list), .studio/previews/cover.png
studio-image list shapes | textures | filters | fonts
studio-image info assets/photo.jpg                   # size, transparency, brightness, main colors of any image
studio-image palette assets/photo.jpg --colors 6     # its colors as hex — a palette that matches a reference
studio-image convert assets/photo.jpg --to webp --width 800
studio-image sheet exports/walk-*.png --cols 4       # sprite sheet + atlas JSON
```

**You must look:** after every render read the preview PNG and the report (brightness, contrast,
main colors, warnings: text wider than the picture, a layer that draws nothing). Never say a
picture is done without having looked at it.

Workflow: decide size and palette (3–4 colors, in `image.palette`) → background → big shapes →
text → details and filters → render → look → adjust. Export several sizes at once with
`export:` (icons: `sizes: [16, 32, 180, 512]`, favicon: `format: ico`).

- **Logos and icons:** simple shapes and `path: "M … Z"` (SVG path data); test at 32 px.
- **Pixel art:** `pixels:` grids with a `palette`, `antialias: 1`, `smooth: false` for resized copies;
  several grids = frames of a sprite sheet.
- **Textures for games and 3D:** `--template texture`; sizes in powers of two; the textures tile.
- **Photos the user uploaded** (`assets/uploads/`): use them as `image:` layers (crop, fit, filters,
  text on top); `studio-image info` first to know their size.
- For anything the tool cannot draw yet, **extend it**: `studio-image plugin new <name> --kind
  shape|filter|texture` (Python, `studio_image.api`) — or write a Python script with Pillow.

The user can open `*.image.yaml` in the Files tab and press **Check** / **Render**; keep the files
tidy and commented. Deliverables: PNG / JPG / WebP in `exports/`, sources in `src/`. Save reusable
results to the library (`studio lib add exports/x.png src/x.image.yaml --name … --kind image`).
