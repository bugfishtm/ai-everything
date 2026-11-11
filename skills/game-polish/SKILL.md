---
name: game-polish
title: Polish a game
description: Use when a browser game works but feels unfinished or flat, or when the user asks to polish it, make it feel better, add juice, or get it ready to show to people.
areas: [game]
---

# Polish a game

Play it first (screenshots and console), write down what is missing, then work through the
list from the top. Do not rewrite a working game — add to it.

## 1. Look at the current state

```bash
studio-browser console index.html            # must be free of errors
studio-browser shot index.html --wait 2000 --out .studio/shot-start.png
studio-browser shot index.html --wait 2500 --press "Space" --out .studio/shot-play.png
```

## 2. Checklist — fix what is missing, in this order

**It must be complete**
- start screen with the title, how to play and "press to start" (audio starts on that click)
- pause (P / Esc and when the tab loses focus), game over with the score and a restart
- a way to win or a score that climbs; a best score kept in memory (wrap `localStorage` in try/catch)

**It must be fair and readable**
- the player understands in 5 seconds what to do — a hint on the first screen or first seconds
- contrast: player, enemies and pickups differ clearly from the background and from each other
- difficulty ramps up slowly; the first 20 seconds are easy
- controls: keyboard AND touch (on-screen buttons or swipe); works at any window size

**It must feel good (juice)**
- every action answers at once: a sound, a small scale or color pop, a few particles
- screen shake on hits (2–6 px, 100–200 ms), a short freeze frame (40–80 ms) on big ones
- easing on movement and menus instead of jumps; things squash and stretch a little
- numbers pop up where points are scored; the score counter ticks up
- music, quieter than the effects, with a mute button

**It must run well**
- one `requestAnimationFrame` loop with delta time; movement independent of the frame rate
- no garbage in the loop (reuse objects), draw only what is on screen

## 3. Make the missing assets yourself

- sounds: `studio-daw sfx jump,coin,hit,win,lose --out assets/sfx` (list: `studio-daw sfx list`); music: `studio-daw new … --template chiptune`
- characters: `studio-stickman sprite …` for sprite sheets, `studio-3d` for models
- ready-made: `studio lib search <words> --kind image|audio|music|model3d`

## 4. Verify

Run the console and screenshot checks again after every block. Tell the user what was added
as a short list, and what you would do next.
