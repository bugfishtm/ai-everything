# studio — asset library access for Claude

Every Claude session started by the Studio (chat or terminal) gets two
environment variables:

| Variable          | Meaning                                                 |
|-------------------|---------------------------------------------------------|
| `STUDIO_TOKEN`    | short-lived token bound to the user + project           |
| `STUDIO_API_URL`  | the Studio server inside the container                   |

With them, the `studio` command and the `studio` MCP server can use the library.

## Command line

```bash
studio lib search low poly tree --kind model3d
studio lib info ast_k3m9x2qp7v
studio lib get ast_k3m9x2qp7v --to assets/models/tree
studio lib add exports/tree.glb --name "Low-poly pine tree" --kind model3d --tags tree,nature,lowpoly --desc "1.2k tris, 2 materials"
studio lib add models/chest/ --name "Treasure chest" --main chest.gltf
studio whoami
studio tools
```

Add `--json` to any command for machine-readable output.

## MCP tools (mcp__studio__*)

| Tool              | Purpose                                             |
|-------------------|-----------------------------------------------------|
| `library_search`  | search by words, kind and scope                     |
| `library_info`    | details and file list of one asset                  |
| `library_get`     | copy an asset into the project                      |
| `library_add`     | save project files as a new asset                   |
| `studio_tools`    | list installed Studio tools                         |
| `permission_prompt` | internal — the website's "ask before acting" bridge |

## Rules

* Assets are **immutable files + editable metadata**. To change an asset, import
  it, edit the copy, and add the result as a new asset.
* Claude can add assets to the **user's private library**. Publishing to the
  **Global Space** is a human decision made on the website.
* Prefer text-based sources inside assets (glTF JSON, SVG, score files …) next to
  their rendered versions, so future sessions can modify them.
