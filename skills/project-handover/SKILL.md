---
name: project-handover
title: Write a project handover
description: Use when the user asks for a summary of the project, its current state, documentation for someone else, a README, or "where were we" after a break.
---

# Write a project handover

Someone who has never seen the project must be able to continue after reading one page.

## 1. Collect facts (do not write from memory)

Read the folder: sources in `src/`, results in `exports/`, `assets/`, servers in `server/`,
plugins in `plugins/`, the project notes in `CLAUDE.md`. Run the status commands that apply:

```bash
studio site status          # published? where?
studio service list         # running servers
studio tools                # the Studio software available here
```

## 2. Write `README.md` in the project root

Keep it to one screen. Sections:

1. **What this is** — two sentences: the thing and who it is for.
2. **State** — what works today, as a short list. Then what is unfinished or known to be
   broken. Be exact ("level 3 has no exit"), not polite.
3. **How to run / render it** — the commands, in order, that turn the sources into the result.
4. **Where things are** — the handful of files someone must know, each with one line.
5. **Decisions** — the choices that are not obvious from the code and why they were made.
6. **Next steps** — the three most useful things to do next, most valuable first.

## 3. Rules

- Only what is true now: check every command and path you write down.
- No history of how it got here, no praise, no filler.
- Dates as dates, not "yesterday".
- If `README.md` exists, update it instead of replacing what the user wrote; keep their sections.

Tell the user where the file is and name the one open point that matters most.
