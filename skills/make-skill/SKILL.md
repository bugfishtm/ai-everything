---
name: make-skill
title: Turn a workflow into a skill
description: Use when the user wants to save how something is done so it can be repeated — "remember how to do this", "make this a skill", "do it like this every time" — or asks to create, improve or fix a skill.
---

# Turn a workflow into a skill

A skill is a text file the AI reads right before a matching task. It works when it says
exactly WHEN to use it and gives instructions a newcomer could follow without this conversation.

## 1. Find out what to capture

From the conversation (or by asking, at most three questions): What is the task? What does a
good result look like? Which steps and checks made it good this time? What went wrong on the
way and must be avoided? What changes from case to case (names, sizes, topics) — those become
"ask or decide" points, everything else is fixed.

## 2. Write the SKILL.md

```bash
studio skill new <name>          # scaffolds skills/<name>/SKILL.md in the project
```

```markdown
---
name: weekly-report                  # a-z, 0-9, - · this is also the /command
title: Weekly report
description: Use when the user asks for the weekly report or a status mail for the team — collects the changes of the week and writes them in the house style.
areas: [general, web]                # optional: only offered in these areas
auto: true                           # false = only when the user types /weekly-report
---

# Weekly report

1. …
```

**The description decides everything.** The AI only sees name and description when it chooses
— write what the user would say ("when the user asks for …") and what the skill produces.
Vague descriptions ("helps with reports") are never picked.

**The body**
- Numbered steps in the order they are done; commands exactly as they are typed.
- The checks that prove the result is good ("render and compare", "console must be clean").
- The house rules: tone, format, names, what never to do.
- Short. Leave out what any capable assistant does anyway. 30–80 lines is typical.
- Self-contained: no "as discussed", no references to this chat.

## 3. Save and test

```bash
studio skill save skills/<name>          # → the user's own skill (new or updated)
studio skill show <name>                 # read it back
```

Tell the user: the name, that it is used automatically when a task matches (or with `/<name>`),
and that they can edit, switch off or share it on the **Skills** page of the website.
Then try it once on a real example and tighten what was unclear.
