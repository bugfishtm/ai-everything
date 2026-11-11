# {{PROJECT_NAME}}

Area: **{{AREA_NAME}}** · created in Everything Studio

> {{DESCRIPTION}}

## How this workspace works

- This folder is the whole project. Keep everything inside it.
- **Text first:** creative work is stored as human-readable text sources
  (scores, SVG, glTF JSON, timelines, generator scripts). Renders/binaries are
  produced from them. Never leave the only copy of something in a binary format
  when a text source is possible.
- `src/` — sources · `assets/` — inputs (uploads, imported library assets) ·
  `exports/` — finished deliverables the user downloads (not versioned in git).
- A git checkpoint is created after every Claude turn; the user can restore any
  version from the History tab.
- Asset library: search before creating (`studio lib search …`), import with
  `studio lib get <id>`, save reusable results with `studio lib add …`.
- Check visual work yourself: `studio-browser shot <file> --out .studio/shot.png`
  and read the image; for audio, inspect with `ffprobe`/`sox --info`.

## Area guide

{{AREA_GUIDE}}

## Project notes

<!-- Claude and the user keep decisions, style rules and TODOs for this project here. -->
