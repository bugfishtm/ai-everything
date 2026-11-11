# Skills — know-how the AI loads when it needs it

Every folder here is a **built-in skill**: `skills/<name>/SKILL.md`. The image copies them to
`/opt/studio/skills`; the Studio lists them on the **Skills & instructions** page and in every AI
session's prompt (name + description only). When a task matches, the AI reads the skill with
`studio skill show <name>` and follows it; users call one directly by starting a message with
`/<name>`. Skills are plain text in the prompt, so they work with every AI provider.

Users have the same thing for themselves: they write skills on the website (or let the AI save
one with `studio skill save`), switch built-in ones off, and publish their own to the Global Space.

## SKILL.md

```markdown
---
name: weekly-report                 # a-z, 0-9, - — the folder name wins for built-in skills
title: Weekly report                # display name (default: the first # heading)
description: Use when the user asks for the weekly report or a status mail for the team — collects the changes of the week and writes them in the house style.
areas: [general, web]               # optional: only offered in these areas (music image model3d video game android windows web general chat)
auto: true                          # false = never offered to the AI by itself, only on /weekly-report
---

# Weekly report

1. …
```

- **description** decides whether a skill is used: the AI sees only name and description when it
  chooses. Write what the user would ask for and what comes out ("Use when …").
- **Body**: numbered steps in order, exact commands, how to check the result, what never to do.
  Self-contained and short (30–80 lines) — every skill a session reads costs context.
- Commands in a skill must exist: check them against `studio help` and the tools' `docs`.
- The front matter is read like YAML: `# comments` after a value are ignored, quoted values may
  contain `#` and `\"`, `areas` is `[a, b]` or a `- a` list. A skill that still has the description
  of the `studio skill new` template is refused — the description is what the AI decides by.

## Adding a built-in skill

1. Create `skills/<name>/SKILL.md`.
2. Rebuild the image (`docker compose build`) — or, on a running Studio with the folder mounted,
   restart the container. `SKILLS_DIR` points somewhere else if you keep your own set.

| Skill | For |
|-------|-----|
| `song-production`, `mix-and-master` | music with studio-daw |
| `stick-animation`, `music-video` | animation with studio-stickman |
| `image-design` | pictures with studio-image (posters, icons, textures, pixel art) |
| `video-edit` | timelines with studio-video (trailers, slideshows, shorts) |
| `model-3d` | models with studio-3d |
| `game-polish`, `game-assets` | browser games |
| `publish-website` | websites, domains, HTTPS |
| `code-review`, `fix-bug`, `project-handover` | any software project |
| `make-skill` | turning a workflow into a new skill |
| `explain-simply` | only on `/explain-simply` |
