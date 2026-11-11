# Building Studio software (for the AI)

Studio software is not made for clicking — it is made for Claude Code. A human describes an
idea, Claude writes **text**, the software turns text into media, and Claude **checks the result
itself** before it answers. `studio-daw` (music), `studio-3d` (3D), `studio-image` (pictures),
`studio-video` (timelines) and `studio-stickman` (animation) are the reference implementations;
new tools follow the same contract. Time-based media cannot be looked at as a whole: render a **contact sheet** of
the key moments (studio-stickman) or a spectrogram (studio-daw) as the preview.

```
 idea ─▶ Claude writes text ─▶ tool check (fast, precise errors) ─▶ tool render ─▶ report + preview
              ▲                                                                       │
              └────────────── Claude reads numbers / looks at the PNG ◀───────────────┘
```

## The contract

1. **Text is the save format.** One human-readable document format per tool (YAML/JSON/DSL),
   versioned by git in the project, small diffs, comments allowed. Binaries are *renders* in
   `exports/`. The library stores renders *and* sources so assets stay editable.
2. **Fast `check`.** Validates without rendering; errors say *where* (`patterns.verse.bass: bar 3
   has 3.5 beats`) and suggest fixes (`did you mean …?`). Unknown parameters are warnings.
3. **`render`/`build` with a report.** Machine-readable with `--json` (last stdout line), human
   summary otherwise. Report what the AI cannot perceive: loudness, peaks, per-track levels,
   triangle counts, real-world size, warnings ("track is almost silent", "below the ground").
4. **A preview the AI can look at.** A PNG that summarises the output: spectrogram + waveform with
   section markers (audio), 4 views with a 1 m grid (3D), contact sheet (video), the image itself.
5. **Partial work.** Let Claude iterate cheaply: `--from/--to` bars, single objects, low quality.
6. **Discoverability.** `<tool> docs` prints the full reference; listing commands
   (`instruments`, `shapes`, `materials`, `effects`) show everything usable *with parameters*.
7. **Packs, not hard-coded content.** Content (instruments, samples, models, materials …) comes
   from packs via `pack-id/item-id` references, resolved through `STUDIO_PACKS_PATH`
   (`tools/studio/python/studio_packs.py`, `tools/studio/lib/packs.js`).
8. **Self-extension.** The tool loads plugins from the project (`plugins/<tool>/*.py`), so Claude can
   add the instrument/effect/shape/modifier it misses — then share it in a pack. `plugin new`
   scaffolds a working example.
9. **Headless and deterministic.** No display, seeds for randomness, same input → same output.
10. **Safe by default.** Runs as the user's sandbox account; plugin code from Global Space packs
    runs only when the pack's `.studio-meta.json` says `trusted` (admin review).
11. **Visual editors sit on top, they do not re-implement.** People may edit the same text in a
    website editor (the DAW for songs). Such an editor asks the tool for the parsed model and its
    catalog (`studio-daw model` / `catalog`, JSON) and for renders, and writes its edits back into the
    text surgically — so plugins, packs and new features of the tool work there automatically.
    Give plugin parameters UI hints (`{"value": …, "min": …, "max": …}`) so they become good controls.

## Anatomy of a tool

```
tools/studio-xyz/
  tool.json          manifest: commands, text formats, areas, packTypes, docs, optional MCP
  README.md          the format reference (= `studio-xyz docs`) — written for Claude
  install.sh         build-time dependencies (pip/npm), runs as root in `docker build`
  bin/studio-xyz     entry point → /usr/local/bin
  studio_xyz/        implementation (Python is a good default: numpy/scipy/trimesh/Pillow are there)
    cli.py  registry.py  api.py  …
```

`tool.json` is read by the server: the tool appears on the area pages and in Claude's system prompt
for the listed `areas`. Use `"packTypes"` for the pack types the tool consumes.

## Plugin API pattern (copy from studio-daw / studio-3d)

```python
# registry.py: tables + load_file(path, source) + load_project_plugins()
# api.py:      decorators used by plugins, re-exporting helpers
@instrument("name", params={...}, doc="one line")   # studio-daw
@effect("name", params={...})
@shape("name", params={...})                        # studio-3d
@modifier("name", params={...})
```

Built-ins register through the same decorators, so built-ins and plugins are equal citizens and the
listing commands show both with their source (`built-in`, `pack:x/y`, `project:plugins/…`).

## Packs for a tool

Define item kinds and their `meta` fields in the tool's README and in `packs/README.md`, ship a
small system pack in `packs/<id>/` (an `install.sh` may generate content at build time — the DAW
renders `studio-drums`, studio-3d builds the `basic-3d` models), and make the listing commands
show pack items next to built-ins.

## Testing a tool

```bash
docker compose build studio          # tools + packs are built and validated (studio packs validate)
docker compose run --rm studio bash  # then: studio-xyz new x && studio-xyz render x --preview
```

During development mount `tools/` over `/opt/studio/tools` and use Admin → System → Rescan tools.
