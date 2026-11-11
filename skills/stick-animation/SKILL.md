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
```

- Use actions (`do: walk`, `do: punch, target: blue`) for whole moves; keyframes (`pose:`) for
  exact acting. A strike with a fixed `t` lands at `t`; items without `t` follow each other.
- Give the figures clear differences: color, `scale`, a `hat`, `glasses`, a `cape`.
- Dialogue: `say: "…"` next to a gesture (`do: point`, `do: shrug`). Short lines — a bubble is
  read in about a second per five words.
- Camera: start wide, move in for the important moment, `cut: true` for a surprise, `follow:` a runner.
- Sound: actions bring their own. Add `word: "POW!"` only for the big hits, `sfx:` for things
  without a figure (door, explosion).

## 3. Look at it — every time

```bash
studio-stickman check src/<name>.stick.yaml
studio-stickman sheet src/<name>.stick.yaml                 # read the PNG
studio-stickman sheet src/<name>.stick.yaml --at 6.0,6.2,6.4,6.6     # one moment in detail
studio-stickman render src/<name>.stick.yaml --draft        # fast test with sound
```

In the contact sheet check: do strikes connect (fist at the target)? Is anyone outside the
picture or hidden behind someone? Can each pose be read as a silhouette? Is the speech bubble
inside the frame? Fix what `check` warns about.

## 4. Timing rules

- Anticipation → action → reaction: wind up before, recoil after. Fast actions 0.08–0.15 s
  (`in: 0.1`, `ease: snap`), calm ones 0.3–0.6 s.
- Hold poses. Leave half a second of stillness before a punchline and after a big hit.
- Vary the rhythm: three quick moves, then one slow one.
- 10–20 seconds is a good length for a sketch; a fight reads best at 8–15 s.

## 5. Missing something? Extend the tool

```bash
studio-stickman plugin new <name> --kind action|pose|prop|fx|backdrop|sound
```

The starter explains the API in comments. Check with `studio-stickman list <name>` and a sheet.

## 6. Deliver

`studio-stickman render src/<name>.stick.yaml --preview` → `exports/<name>.mp4` (add `--gif`
when the user wants to post it somewhere without sound). Say the length and what happens in one line.
