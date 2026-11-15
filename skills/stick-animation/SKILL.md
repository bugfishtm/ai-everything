---
name: stick-animation
title: Make a stick figure animation
description: Use when the user wants a stick figure animation, a stickman fight, a short animated sketch, an explainer with figures, or a dance animation made with studio-stickman.
areas: [video, game, image, general]
---

# Make a stick figure animation

A good animation is a story told in beats. Write the beats first, then the scene file.

## 1. Storyboard in words

Before touching YAML, write 5–12 beats as comments at the top of the scene file:

```
# 0.0  two fighters face each other, title "ROUND 1"
# 1.0  red walks in, jab — jab — punch (POW!)
# 4.5  blue kicks, red blocks
# 6.2  red answers with a high kick: K.O., camera zooms in
# 7.6  red cheers
```

Every beat needs: who, what, and what the viewer should look at. One idea per beat.

## 2. Build the scene

```bash
studio-stickman new src/<name>.stick.yaml --template fight|talk|dance|blank
studio-stickman list actions        # moves with parameters;  list poses / props / backdrops / sounds
studio-stickman poses --preview     # a picture of every pose — read it
studio-stickman docs actions        # one part of the reference (docs figures, docs events, docs sound …)
```

- Use actions (`do: walk`, `do: punch, target: blue`) for whole moves; keyframes (`pose:`) for
  exact acting. A strike with a fixed `t` lands at `t`; items without `t` follow each other —
  let one move end before the next starts (`check` warns when two moves of a figure overlap).
- Strikes find their target and react by themselves. To defend, time a `do: block` (or `dodge`) so
  it covers the moment the strike lands: the hit stops on the forearms (or goes into the air).
- There are moves for most things: `crouch`, `crawl`, `climb`, `roll`, `sit`/`stand`, `getup`,
  `pickup`, `carry`/`push`/`pull`, `turn`, `clap`, `talk`; `walk … upper: wave` keeps a gesture
  while walking. Walking feet stay planted.
- `y` is the height a figure stands on (a ledge, a table) and is kept until a key sets it again;
  `y: 0` brings it down.
- Give the figures clear differences: color, `scale`, a `hat`, `glasses`, a `cape`.
- Dialogue: `say: "…"` — the speaker's mouth moves and it gestures when it has nothing else to do;
  add a real gesture (`do: point`, `do: shrug`) for the important lines. Short lines — a bubble is
  read in about a second per five words.
- Camera: start wide, move in for the important moment, `cut: true` for a surprise, `follow:` a runner.
- Sound: actions bring their own, footsteps included. Add `word: "POW!"` only for the big hits,
  `sfx:` for things without a figure (door, explosion).

## 3. Look at it — every time

```bash
studio-stickman check src/<name>.stick.yaml                     # errors and warnings with line numbers
studio-stickman sheet src/<name>.stick.yaml --focus action      # read the PNG: close-ups of the key moments
studio-stickman at src/<name>.stick.yaml 6.2                    # one moment as text: poses, actions, gaps, camera
studio-stickman sheet src/<name>.stick.yaml --from 6.0 --to 6.6 --step 1f --focus red   # every frame of one impact
studio-stickman render src/<name>.stick.yaml --draft            # fast test with sound → exports/<name>.draft.mp4
```

Fix everything `check` reports (each problem names its line). In the sheet check: do strikes
connect, and is the block up when the strike lands (`at` says what each figure does at that
moment)? Is anyone outside the picture or hidden behind someone? Can each pose be read as a
silhouette? Are the bubbles inside the frame? For motion, `--onion 3` draws earlier poses behind
each figure and `--markers` marks the feet (green: on the floor) — a green foot must not move
between pictures. `studio-stickman watch src/<name>.stick.yaml --sheet` re-checks on every save.
When rendering fails with exit code 4, run `studio-stickman doctor`.

## 4. Timing rules

- Anticipation → action → reaction: wind up before, recoil after. Fast actions 0.08–0.15 s
  (`in: 0.1`, `ease: snap`), calm ones 0.3–0.6 s.
- Hold poses. Leave half a second of stillness before a punchline and after a big hit.
- Vary the rhythm: three quick moves, then one slow one.
- 10–20 seconds is a good length for a sketch; a fight reads best at 8–15 s.

## 5. Missing something? Extend the tool

```bash
studio-stickman plugin new <name> --kind action|pose|prop|fx|backdrop|sound|particle
```

The starter explains the API in comments. Check with `studio-stickman list <name>` and a sheet.

## 6. Deliver

`studio-stickman render src/<name>.stick.yaml --preview` → `exports/<name>.mp4` and the contact
sheet `.studio/previews/<name>-sheet.png` — read it one last time (add `--gif` when the user wants
to post it somewhere without sound). Say the length and what happens in one line.
