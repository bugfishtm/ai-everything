---
name: code-review
title: Review the code
description: Use when the user asks to review, audit or check their project's code for bugs, security problems or quality before shipping — and wants findings, not a rewrite.
areas: [web, game, android, windows, general]
---

# Review the code

A review finds real problems and proves them. It does not restyle code or list opinions.

## 1. Scope

Ask nothing if the scope is obvious. Otherwise: the whole project or the last changes? Is
there something the user is worried about? Read the entry points first (`index.html`,
`src/main.*`, `server/`, the build config), then follow the data: input → processing → output.

## 2. What to look for (in this order)

1. **Wrong results** — logic errors, off-by-one, wrong units, state that is not reset,
   async code that races, errors swallowed by empty `catch` blocks.
2. **Crashes** — missing null checks on things that can be missing (network, storage, DOM
   elements, user input), unhandled promise rejections, infinite loops or recursion.
3. **Security** — user input in HTML (`innerHTML`), SQL or shell commands; secrets in the
   client code or in the repository; missing checks of WHO may do something on the server;
   file paths built from input.
4. **Data loss** — saves that can overwrite newer data, no confirmation before deleting,
   storage that fails silently.
5. **Performance that users notice** — work inside the frame loop, loading everything at
   once, listeners and timers that are never removed.
6. **Maintainability** — only what will hurt soon: copies of the same logic that already
   drifted apart, dead code that confuses, names that lie.

## 3. Prove each finding

Do not report guesses. For every finding: read the code path fully, and where possible run it
(`studio-browser console …`, a small test script, the build). Drop what you cannot make plausible.

## 4. Report

Most severe first, at most ~10 findings:

```
1. [high] src/save.js:42 — the autosave writes while a load is still running; the old state
   overwrites the new one. Happens when: switching slots quickly. Fix: wait for the load promise.
```

Each with file and line, what goes wrong, when it happens, and the fix in one sentence. End
with what is good (one or two lines) and a clear offer: fix all, or only the high ones.
Do not change code during a review unless the user asked for fixes.
