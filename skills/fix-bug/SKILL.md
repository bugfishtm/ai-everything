---
name: fix-bug
title: Find and fix a bug
description: Use when something in the project does not work — an error message, a crash, wrong behaviour, a blank page, "it worked before" — and the cause is not yet known.
areas: [web, game, android, windows, general]
---

# Find and fix a bug

Reproduce first, understand second, change code third. A fix without a known cause is a guess.

## 1. Reproduce

Get the exact symptom: what was done, what happened, what should have happened. Then see it
yourself:

```bash
studio-browser console index.html --wait 3000      # errors, failed requests
studio-browser shot index.html --wait 2000 --press "Space" --out .studio/bug.png
studio service logs --tail 100                     # when a project server is involved
```

For builds: run the build and read the FIRST error, not the last. If you cannot reproduce it,
say so and ask for the one detail that is missing (browser, steps, input) — do not start changing things.

## 2. Narrow it down

- Read the error text and the line it names completely. Most bugs are where the message says.
- Follow the data backwards from the wrong value to where it is still right.
- "It worked before": what changed since? Look at the most recently edited files first.
- Halve the problem: switch off parts (comment out, early return, minimal input) until it
  disappears — the cause is in the half you removed.
- Add temporary logging at the boundary (before/after the suspicious step); remove it afterwards.

## 3. Name the cause

Write one sentence before fixing: "X happens because Y, when Z." If you cannot, keep looking.
Check whether the same mistake exists in other places (search for the pattern).

## 4. Fix

- The smallest change that removes the cause — not the symptom (no `try/catch` around it, no
  `if (x) return` that hides it, no retry loop).
- Keep the style of the surrounding code; do not refactor on the way.

## 5. Prove it

Repeat step 1: the symptom must be gone and the console clean. Test the neighbours of the
fix (the other paths through the changed function). Then tell the user in three lines: the
cause, the fix, and how you verified it.
