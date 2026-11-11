# Studio tools — the software Claude works with

Everything in this folder is copied into the image at `/opt/studio/tools/` and picked up
automatically by the website and by Claude: the tool appears on the area pages, in every Claude
session's system prompt, and its `bin/` commands are on the PATH.

| Tool | What it does |
|------|--------------|
| `studio-daw` | **music from text** — songs (`*.song.yaml`) → WAV/MP3/MIDI/stems + loudness report + spectrogram; synths, samples, SoundFonts, pack instruments; instrument/effect plugins |
| `studio-3d` | **3D from text** — scenes (`*.scene.yaml`) → `.glb` (+ `.obj`/`.stl`) + stats + 4-view preview; shapes, booleans, scatter, modifiers, PBR materials with textures (files, studio-image pictures, procedural; UV projections, relief), pack models; shape/modifier plugins; the website's 3D editor edits the same files |
| `studio-image` | **pictures from text** — pictures (`*.image.yaml`) → PNG/JPG/WebP/ICO in several sizes + preview + report; shapes, SVG paths, text, textures, pixel art, masks, blend modes, filters; analyses / converts / packs images; shape/filter/texture plugins |
| `studio-video` | **videos from text** — timelines (`*.video.yaml`) → MP4 (+ GIF/WebM, .srt) + contact sheet; video files, stills with zoom/pan, title cards, stick scenes, pictures, songs; transitions, overlays, subtitles, ducking; transition/generator plugins |
| `studio-stickman` | **animation from text** — scenes (`*.stick.yaml`) → MP4 with sound effects (+ GIF/WebM, sprite sheets) + contact sheet; poses, actions, props, camera, speech bubbles, beats of a song; pose/action/prop/fx/backdrop/sound plugins |
| `studio` | library, packs, skills, servers and websites CLI (`studio lib|packs|skill|service|site …`) and the `studio` MCP server (library/packs tools, permission bridge) |
| `browser` | `studio-browser`: headless Chromium screenshots, console, DOM |

All of them follow the same contract — see [docs/SOFTWARE.md](../docs/SOFTWARE.md). Shared picture
helpers (colors, fonts, text, gradients, blending, contact sheets) are in `studio/python/studio_gfx.py`.

## The rules

1. **Saves are text** (YAML/JSON/DSL) — renders go to `exports/`.
2. **`check` + `render` with a report and a preview** the AI can read/look at.
3. **Content comes from packs** (`pack-id/item-id`), see [packs/README.md](../packs/README.md).
4. **Claude can extend the tool** with project plugins (`plugins/<tool>/*.py`) and share them in packs.

## Folder layout of a tool

```
tools/
  my-tool/
    tool.json        # manifest (required)
    README.md        # the format reference Claude reads (`my-tool docs`)
    bin/my-tool      # executables → symlinked into /usr/local/bin
    install.sh       # optional, runs once at image build time (as root)
    my_tool/ …       # implementation
```

## tool.json

```json
{
  "id": "studio-video",
  "name": "Studio Video",
  "version": "0.1.0",
  "description": "Edits as text timelines, rendered with ffmpeg.",
  "areas": ["video", "game"],
  "packTypes": ["video", "music"],
  "commands": [
    { "usage": "studio-video render <file.timeline.yaml> --preview", "description": "render MP4 + contact sheet" }
  ],
  "formats": [
    { "ext": ".timeline.yaml", "description": "clips, transitions, titles, audio" }
  ],
  "mcp": { "studiovideo": { "command": "studio-video", "args": ["mcp"] } },
  "docs": "README.md"
}
```

| Field | Meaning |
|-------|---------|
| `areas` | area ids (`music image model3d video game android windows web general`) or `"*"` |
| `packTypes` | pack types the tool consumes (shown on the website) |
| `commands` | shown on the website and in Claude's system prompt |
| `formats` | the text formats the tool owns |
| `mcp` | optional MCP servers; they receive `STUDIO_TOKEN`, `STUDIO_API_URL`, `STUDIO_PROJECT_DIR`, `STUDIO_PACKS_PATH` |
| `docs` | file Claude can read for details |

## Adding a tool

1. Create `tools/<id>/` with `tool.json`, `bin/…`, `README.md` (and `install.sh` for dependencies).
2. `docker compose build` and restart — or, while developing in a mounted folder, Admin → System → Rescan tools.
