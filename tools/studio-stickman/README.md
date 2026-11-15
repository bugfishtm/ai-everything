# studio-stickman — stick figure animation from text

Scenes are YAML files (`*.stick.yaml`): who is in the picture, what they do when, where the
camera looks, which words and sounds appear. `studio-stickman render` turns a scene into an
MP4 with synthesized sound effects (+ GIF/WebM, PNG frames, sprite sheets for games).

```bash
studio-stickman new src/duel.stick.yaml            # starter scene (--template fight|talk|dance|blank)
studio-stickman check src/duel.stick.yaml          # validate fast: names, parameters, timing; plays it through
studio-stickman sheet src/duel.stick.yaml --focus action   # contact sheet PNG of the key moments, close-ups — LOOK at it
studio-stickman sheet src/duel.stick.yaml --from 4.4 --to 4.8 --step 1f --focus red   # every frame, cropped
studio-stickman sheet src/duel.stick.yaml --at 2.0,2.2 --onion 3 --markers   # motion ghosts, feet on the floor?
studio-stickman at src/duel.stick.yaml 4.6         # the state at 4.6 s as text: poses, actions, camera, gaps
studio-stickman info src/duel.stick.yaml           # who does what when, and when each strike lands
studio-stickman render src/duel.stick.yaml --draft --from 3 --to 6   # quick look → exports/duel-3-6s.draft.mp4
studio-stickman render src/duel.stick.yaml --preview    # → exports/duel.mp4 + .studio/previews/duel-sheet.png
studio-stickman render src/duel.stick.yaml --res 1080p --gif --webm --frames   # bigger, more formats
studio-stickman still src/duel.stick.yaml 2.5 "3:1"     # single frames as PNG
studio-stickman sprite src/duel.stick.yaml --figure red --from 1 --to 2.6 --frames 8   # sprite sheet + atlas JSON
studio-stickman list actions                       # catalogue: poses actions fx props backdrops sounds particles hats expressions eases events
studio-stickman poses guard block kick --preview   # pictures of poses with their names (several words: any of them)
studio-stickman plugin new backflip --kind action  # extend the tool (plugins/stickman/backflip.py)
studio-stickman watch src/duel.stick.yaml --sheet  # check + sheet again on every save
studio-stickman doctor                             # is everything there? ffmpeg, encoders, fonts, plugins, a test render
studio-stickman help render                        # every option of a command; docs <topic> for one part of this file
```

**Watching without eyes:** videos cannot be read, pictures and text can. After every change run
`sheet` (or `render --preview`) and read the PNG: a grid of the key moments (hits, the start of
speech and of each move) with two lines under each picture — the time, what each figure does and
its expression, then the words on screen. `--focus action` makes every picture a close-up of the
figures (an orange dot marks a close-up), `--focus red` follows one figure; `--at 2.1,2.4,2.7` shows
exact moments, `--from 4.4 --to 4.8 --step 1f` every frame of an impact, `--onion 3` faint earlier
poses behind each figure, `--markers` the floor line with x ticks every 50 px and dots on the feet
(green: on the floor, red: in the air) and hands — a green foot that moves between pictures slides.
`still` gives one large frame; the sheet before is kept as `….prev.png` to compare. `at <t>` tells
in words where everyone is, what they do and what the camera sees at that moment (the camera of the
drawn frame: follow smoothing, kept inside the scenery, zoom punches and shakes) — e.g. whether a
block is up when the kick lands (`info` lists when each strike lands). Work in this order:
`check` → `sheet --focus action` → `at <t>` for a moment that looks wrong → `render --draft` → `render`.

## Scene file

```yaml
scene:
  title: Duel
  size: [1280, 720]        # the video, even numbers from 64×64 up to 3840×2160
  fps: 30                  # 5–60
  background: dojo         # a backdrop (list backdrops), a color ("#223", [30, 30, 40]), or { use: street, night: false }
  bpm: 120                 # optional: the tempo of the music → times can be "bar:beat"
  time: 4/4
  audio: exports/song.mp3  # optional soundtrack: an audio file, or a studio-daw song (src/x.song.yaml — rendered
                           # for you, and its bpm becomes the scene's bpm); audio_gain: -3 (dB), audio_offset: 0.5
  sfx_gain: 0              # dB for all sound effects
  footsteps: true          # walking, running and sneaking figures make footstep sounds
  floor: 640               # y of the ground line (default: height - 80)
  world: [2400, 720]       # optional: scenery larger than the video — the camera can travel
  blend: 0.22              # default seconds a figure takes to move into a pose
  duration: 12             # optional: else the scene ends 1 s after the last thing
  seed: 1                  # the small random variations (sounds, grain)
  style: { line: 9, outline: true, shadow: true, faces: true, highlight: true, vignette: 0.25, grain: 0, smear: true }
                           # smear: fast strikes leave a smear and speed lines; grain: film grain up to 0.05

use: [my-pack]             # optional: packs with stickman plugins or pose sets

figures:                   # name → look and start
  red:  { color: "#c0392b", x: 420, face: right, hat: headband }
  blue: { color: blue, x: 860, face: left, scale: 1.1, glasses: true }

props:                     # things in the scene
  box:   { kind: crate, x: 640 }
  sword: { kind: sword, held_by: red, hand: R }            # in a hand

timeline:                  # per figure: a list, in order
  red:
    - { t: 0, pose: guard }                                # be in this pose AT t
    - { t: 1.0, do: walk, to: blue, gap: 110 }             # an action
    - { do: jab, target: blue }                            # no t: starts when the previous one ended
    - { t: "+0.4", do: punch, target: blue, word: "POW!" } # 0.4 s after the previous one ended
    - { t: 6.2, do: highkick, target: blue, ko: true }     # a strike with a fixed t LANDS at t
  blue:
    - { t: 0, pose: guard }
    - { t: 3.0, pose: block, hold: 0.6, expr: focus }      # stay in it for 0.6 s

camera:
  - { t: 0, x: 640, y: 380, zoom: 1.0 }
  - { t: 6.2, follow: blue, zoom: 1.4, ease: snap }

events:                    # things without a figure
  - { t: 0.2, title: "ROUND 1", dur: 1.4 }
  - { t: 7.5, caption: "…and that was that." }
```

Coordinates are pixels: x to the right, y down, `(0, 0)` top left. A figure is about 215 px tall
and stands at its `x`. Its `y` is the height it stands on, in px ABOVE the floor (a ledge, a
table): it stays until a key sets it again, like `x` — a figure on a ledge stays up there when it
waves or walks, and a jump on a table lands back on the table. `y: 0` brings it down; `check` warns
when a figure stays in the air with nothing under it. Props are placed in picture coordinates
instead: a `crate` (70 px) standing on the floor carries a figure with `y: 70`; a `platform` at
`y: 520` (its top edge) carries one with `y: 120` when the floor is at 640.

**YAML:** only `true` / `false` are yes/no values — `on`, `off`, `yes`, `no` stay words (`hit: { on: b }`
works, a figure may be called `no`); where an option is a yes/no value, `yes`/`no`/`on`/`off` are
accepted too. A key written twice is an error. Top-level keys starting with `_` or `x-` are ignored
(a place for YAML anchors). A timeline entry may be a single `{ … }` instead of a list.

**Errors:** `check` reports every problem at once, each with its YAML path and line:
`timeline.red[2] (line 17): unknown action "jabb" — did you mean jab?`. Warnings name the place the
same way: unknown options (`scene.duraton` — did you mean duration?), two moves of one figure that
overlap (`… the two moves get mixed`), an item whose `t` is earlier than the item above it, a figure
left in the air, a strike that cannot reach or lands just outside a block, a sound file that is
missing, characters no installed font has, a figure outside the picture, things after the end.
Limits: times are not negative; `dur` > 0, `in` / `hold` / `blend` ≥ 0; a `"bar:beat"` must exist in
the bar; `fps` is rounded to a whole number; `time` is N/D with D 1, 2, 4, 8 or 16; `world` is at least `size`
and at most 4 × the area of 3840×2160.

### Time

| Written | Means |
|---------|-------|
| `2.5` | seconds from the start |
| `"3:1"` | bar 3, beat 1 — needs `scene.bpm` (bars and beats count from 1; `"3:2.5"` works) |
| `"+0.4"`, `"+1b"` | after the previous item of this figure ended |
| no `t` | directly when the previous item ended |
| lengths (`dur`, `hold`, `in`, `gap`) | seconds `1.5`, beats `"2b"`, bars `"1bar"` |

With music: set `scene.bpm` to the tempo of the song and place the moves on beats. A `studio-daw`
song is a ready soundtrack: `scene.audio: src/x.song.yaml` renders it when needed and takes its bpm.
Several scenes, titles and one song under everything: put them on a `studio-video` timeline.

### Keyframes

A timeline item with `pose` (or just single fields) is a keyframe: the figure IS in that state
at `t`. It keeps its previous state until shortly before and moves over `in` seconds
(default `scene.blend`); `in: full` uses the whole time since the previous key.

| Field | |
|-------|---|
| `pose` | a pose name (`studio-stickman poses --preview`) |
| `x`, `y`, `rot` | position, height it stands on (kept until set again), whole-body rotation (90 = lying, 360 = a flip) |
| `face` | `left` / `right` |
| `T H RS RE LS LE RH RK LH LK` | single joint angles on top of the pose: `{ pose: guard, RS: 150 }` |
| `expr` | calm, happy, angry, sad, surprised, hurt, focus, ko, sleepy, smirk, scared, none |
| `look` | fwd, back, up, down, camera |
| `fx` | continuous movement while the pose is held: `walk`, `shiver`, `"nod+talk"`, `{ use: float, height: 20 }`; `still` = no breathing |
| `ease` | io (default), lin, in, out, snap, hold (cut), bounce, back (overshoot) |
| `arc` | px the figure rises on the way to this key (a hop) |
| `in`, `hold` | transition seconds; seconds to stay before the next item starts |
| `visible` | `false` hides the figure |
| `say`, `sfx`, `text`, `shake`, `flash`, `burst` | an event at the same moment (`say` becomes the speech bubble of this figure; `say_dur` for its length) |

Angles are degrees: 0 = the limb hangs down / the body is upright, positive = towards the side
the figure faces. `T` torso lean, `H` head tilt, `RS`/`RE` near shoulder/elbow, `LS`/`LE` far
shoulder/elbow, `RH`/`RK` near hip/knee (knees bend with negative values), `LH`/`LK` far hip/knee.
"Near" limbs are drawn in front. Elbows stay within −10…160°, knees −165…5°, the head −70…70°.
The body rests on the floor by its lowest part (feet, knees, buttocks, back or head), so lying and
sitting poses need no `y`; hands and arms fold onto the floor instead of going through it. Between
two keys every joint turns the short way round (`rot` does not: 360 is a flip), and `fx` fade in and
out over the key's `in` instead of switching on in one frame.

### Actions — `do:`

Actions write the keyframes for a whole move (and its sounds). `studio-stickman list actions`
prints all of them with parameters and defaults:

| Action | Parameters |
|--------|-----------|
| `walk`, `run`, `sneak` | `to: 600` or `to: figure` (stops `gap` px in front), or `by: -200`; `speed` px/s or `dur`; `backwards`; `upper: wave` (a pose, or wave / talk / cheer / type, for the arms while the legs walk); `then: pose`. The feet are planted: each step lands and stays put while the body moves over it; turning round to walk the other way is animated |
| `crouch` | crouch down; with `to` / `by` it walks there crouched low; it stays down until `then: stand` or the next move |
| `carry`, `push`, `pull` | walk holding something in both arms / leaning into it / dragging it backwards (`to` / `by` like walk) — move the prop with its own `keys` |
| `crawl` | `to` / `by` on hands and knees (they stay planted); `then: stand` gets up at the end |
| `climb` | `height` px up a ladder or wall; `then: hang` (default) stays up there, `then: stand, over: 40` steps onto the ledge |
| `roll` | a forward roll, `dir: back` backwards; `by` / `to`, `dur` |
| `enter`, `exit` | `side: left` / `right`, `to: x`, `run: true` |
| `jump` | `height`, `to`/`by`, `dur` — crouch, push off, fly, land on bent knees |
| `punch`, `jab`, `uppercut`, `kick`, `highkick`, `lowkick`, `strike`, `swing` | `target: figure` → the figure steps in with the front foot (`lunge`; the back foot stays) until the fist or foot meets the target (side of the head, the chin for an uppercut, the jaw for a highkick, the belly for a kick); the hit gets sparks, a sound, a 2-frame hit-stop and a camera shake, and the target recoils and springs back — a jab a little, a punch more, scaled by `power: 1.6`; `word: "POW!"`, `ko: true` (the target topples over), `part: head` / `chest` / `hip` / `knee`, `react: false`, `sfx: name`, `then: pose`. When the target is busy with a move of its own at the impact (or starts one right after it), it does not react and `check` says so; an attacker that stepped in steps back out. `ko: true` always wins: it cuts the target's running move and skips its moves until it lies down (with a warning). `power` is 0–5 |
| `combo` | `moves: [jab, jab, kick]`, `gap` between hits (`"1b"` = on every beat), same parameters as a strike; `ko` applies to the last one |
| `block`, `dodge` | `dur`; a strike that lands during a `block` stops on the forearms (block sound, a small shove, no recoil); during a `dodge` (`style: back` / `duck`) it goes into the air |
| `hurt`, `fall`, `getup` | a hit without an attacker (`from: front` / `back`, `power`); falling over (`dir: back` / `front`, `slide` px): hips, back, head, a small bounce; standing up again from the back, face down or sitting |
| `sit`, `stand` | `sit` steps to the seat and sits back with the feet planted, the hips at the figure's x (or `at: x`); `stand` from a chair keeps the feet planted, from the floor it gets up |
| `wave`, `cheer`, `shrug`, `think`, `facepalm`, `bow`, `salute`, `laugh`, `talk`, `type`, `clap` | `dur`, `then` (`talk`: varied beat gestures with both hands and head nods) |
| `point` | `at: figure` |
| `nod` | `times` |
| `turn` | `to: left` / `right` / a figure; the body turns through a front view in `dur` (0.22 s) |
| `pickup` | bend down until the hands reach the floor, then come up (`dur`, `then`) |
| `dance` | `beats: 8` (on the bpm of the scene) or `dur`; `moves: [step, sway, arms, clap, point, roll, turn]` (default: a mix that differs per figure); each move lands on the beat, the feet really step |
| `throw` | the throwing movement — move the thrown prop with its own `keys` |
| `appear`, `vanish` | with a puff of smoke; `x`, `pose` |
| `wait` | `dur` |

Moves of all figures are worked out in the order they start, so a strike sees where its target
really is, whichever figure comes first in the file. When the attacker would have to step more than
190 px to get into range (or the limb cannot reach), the strike misses: a whoosh, no hit, no
reaction, and a warning — walk there first. Reactions never overwrite
your own choreography: the automatic recoil is left out while the target does a move of its own
(block, dodge, walk …) or has a keyframe of its own around the impact. `target:` naming the figure
itself is an error. Time a `block` so it covers the moment the strike lands (`info`, `at`).

### Figures

`color` (without one a figure is dark on light scenery and light on dark scenery), `outline` (color;
by default dark, and light for a dark figure on dark scenery), `scale` (0.2–4), `line`
(thickness), `x`, `y` (the height it stands on), `face`, `pose`, `expr`, `fx`, `visible`, `z`
(drawing order), `label` (a name tag), and accessories: `hat` (cap, tophat, crown, headband, helmet,
beanie, horns; or `{ kind: cap, color: red }`), `glasses`, `tie`, `badge`, `belt`, `scarf`, `cape`,
`hair`, `shoes`, `skin`, `eyes` — `true` or a color. `build` changes the proportions in px (0.3×–3×
the default): `{ torso: 78, neck: 8, head: 19, upper_arm: 42, forearm: 40, thigh: 50, shin: 50 }`
(a child: `scale: 0.6, build: { head: 24 }`). While a figure's speech bubble is up its mouth moves,
and a figure that stands or sits and does nothing else gestures as it talks — not while it holds a
pose of its own (think, guard …), has arm angles set in a key, or does a move; the hand holding a prop
stays still. `talk: false` switches the gestures off. `skin: true` gives the default skin tone.

### Props

`kind` (default: the name of the prop), `x`, `y` (picture y of its base, default: the floor; a
`platform`'s top edge), `rot`, `scale`, `flip`, `layer: back` / `front` (behind or in front of the
figures), `from` / `to` (visible only then) and the parameters of the kind (`studio-stickman list
props`). Kinds: rect, circle, line, poly, label, image (`file:` a PNG of the project), crate, table,
desk, chair, door, window, lamp, plant, tree, bush, rock, platform, sign, ball, trophy; for hands:
sword, bat, stick, shield, mug, phone, bottle, briefcase, paper, flag, blaster. A prop moves with
`keys: [ { t, x, y, rot, arc, ease } ]`; one with `held_by: figure` (`hand: R` / `L`, `angle`) moves
with the hand instead (its `keys` are ignored).

```yaml
props:
  ball: { kind: ball, x: 300, keys: [ { t: 1, x: 300 }, { t: 1.8, x: 900, arc: 220, rot: 720 } ] }   # thrown
  mug:  { kind: mug, held_by: ana, hand: L, angle: 10, from: 2, to: 6 }                              # carried
```

### Camera

A list of keyframes: `t`, `x`, `y` (the point in the middle of the picture), `zoom` (1 = the
whole scene), `ease`, `cut: true` (jump instead of gliding), `follow: figure` (+ `dx`, `dy`).
The camera glides from key to key. `follow` smooths out the figure's jolts (lunges, recoils, the
bob of a run) and only rises for real jumps; a shake zooms in just enough that no black edges show.
Zoom in on the important moment; for wide travelling shots make `scene.world` larger than `scene.size`.

### Events

| Event | Options |
|-------|---------|
| `text: "POW!"` | a word in the scene: `x`, `y`, `size` (4–400), `color`, `dur`, `rot`, `pop`, `outline`, `font` (bold, regular, italic, mono), `ui: true` (fixed on the screen instead of in the world) |
| `say: "Hi!"` | speech bubble: `who: figure`, `dur` (default: by text length), `size`, `color`, `bubble`; it opens with a pop |
| `caption: "Later…"` | a subtitle: `dur`, `size`, `color` — under the figures' feet when there is room, else at the top |
| `title: "ROUND 1"` | a title card: `sub`, `dur`, `size`, `color`, `shade` |
| `hit: [x, y]` or `hit: { on: figure, part: head }` | impact (part: head, chest, hip, hand, foot, knee, neck): `word`, `sfx`, `shake`, `flash`, `sparks`, `zoom`, `color`, `size`, `gain` |
| `sfx: punch` | a sound: built-in (`list sounds`), a project file (`assets/x.wav`) or a pack item (`pack/item`); `gain`, `pan` + the parameters of the sound |
| `shake: 8` | camera shake in px, `dur` |
| `flash: true` | white flash (or a color): `dur`, `alpha` |
| `burst: confetti` | particles (spark, dust, smoke, debris, star, confetti, drop, glass): `x`, `y`, `n` (1–2000), `speed`, `dir`, `spread`, `life`, `gravity`, `color`, `size` |
| `fade: in` / `fade: out` | `dur`, `color` |

Captions, titles and bubbles wrap inside the picture. Bubbles stay in the frame, do not cover each
other or a caption, and point towards a speaker who is off screen; hit words at the same spot take
turns. Characters the font lacks (★ ✓ → emoji) are drawn with another installed font; `check` warns
about characters no installed font has.

### Sound

Every action brings its sounds; a strike that lands gets a swing whoosh before the hit, a blocked
one the `block` sound. Built-in sounds are levelled (gain 1 is a normal level for each) and vary a
little each time, so repeated punches are not identical. With `scene.footsteps` (default true)
walking, running and sneaking figures make footsteps where their feet land. Music dips up to 4 dB
under sound effects; peaks are limited without distorting the rest. Audio files (`scene.audio`,
`sfx: assets/x.wav`) are looked up in the project folder, then next to the scene file. A sound that
cannot be made (missing file, `pitch` outside 0.05–8, `dur` over 10 s) is left out with a warning
and the rest still plays. The render report (`--json`) has `audio.peak_db`, `audio.limited_db`
and `audio.footsteps`, and warns when the limiter takes more than 3 dB.

## Output

| Command | Files |
|---------|-------|
| `render` | `exports/<name>.mp4` (H.264 + AAC); `--gif`, `--webm`, `--frames` (`<name>-frames/00000.png …`) come out of the same pass, from the frames (not from the compressed MP4); a part of the scene: `<name>-3-6s.mp4` |
| `render --draft` | `exports/<name>.draft.mp4` — half size, 15 fps; it never replaces the final export |
| `render --preview`, `sheet` | `.studio/previews/<name>-sheet.png`; a selection is part of the name (`-3-6s`, `-at-2.1_2.4`, `-4.4-4.8s-step-1f`, `-red`, `-action`); the sheet before is kept as `….prev.png` |
| `still` | `.studio/previews/<name>-002.500.png` (`…@0.5.png` with `--scale 0.5`) |
| `poses --preview` | `.studio/previews/poses.png` |
| `sprite` | `exports/<name>-<figure>-sprite.png` (transparent, the figure stays in the middle of each cell) + `.json` atlas: frames with `x y w h t dx`, `anchor` (the feet), `fps`. Up to 64 frames 8 per row, more about as many rows as columns (`--cols` sets it). A sheet over 16384 px a side or 8192×8192 px in all is refused before drawing (exit 2, with the largest `--size` that fits); over 4096 px a side it warns (many phones cannot load it) |

Size: `render --res 720p|1080p|1440p|4k` (the height; the width follows `scene.size`) or `--scale 1.5`;
any size comes out with even pixel numbers. Scene coordinates are design units: the same scene
renders at any size up to 4K without changes. Videos are tagged BT.709, so players show the colors
as drawn.

## Command line

`studio-stickman help` lists the commands, `studio-stickman help <command>` all options of one (with
units, ranges and defaults). Numbers are checked: `--fps 5–60`, `--count 1–48`, `--scale`, `--jobs`,
`--size`, `--frames`, `--cols`, `--onion 0–6`; `--from`/`--to` must lie inside the scene and `--to`
after `--from`; a time outside the scene (`--at 99`) is moved to its end with a warning. A scene file
can be named without `.stick.yaml`; `check` takes several files, and `-` reads one from stdin (check
generated YAML before writing it: `… | studio-stickman check - --json`).

**For programs:** `--json` (before or after the command) prints one JSON object as the last line of
stdout: `ok`, `command`, `version`, `files` (`{kind: path}`), `warnings` (text) and `warning_items`
(`{where, line, code, message}`). A failure has `error` (one line per problem) and `errors`
(`[{message, where, line, col, code, got, suggest}]`) — also for a wrong command line. `help [command]`,
`-h` and `--version` answer with JSON too (`text`, `commands` or `usage` + `options`). `render`
writes its progress to stderr: `frames 130/308 (42%, 11.8 fps, ~12 s left)`, or with `--json` JSON
lines (`{"phase": "frames", "done": 130, "of": 308, "eta_s": 12.4}`); `--progress none` turns it off.
`watch --json` prints one JSON object per run. `schema --out .studio/stick.schema.json` writes a JSON
Schema of the format (actions with their parameters, every pose, prop, sound … — project plugins
included) for editors (`# yaml-language-server: $schema=../.studio/stick.schema.json`).

| Exit code | Means |
|-----------|-------|
| 0 | ok |
| 1 | the scene is wrong (or a name in it, or a plugin it needs) |
| 2 | the command line is wrong |
| 3 | `check --strict`: there are warnings (or a plugin did not load) |
| 4 | something outside the scene is missing: ffmpeg, an encoder, a folder that cannot be written — run `doctor` |
| 70 | an internal error (a bug; the message says where) |

The project folder (plugins, `exports/`, `.studio/`, audio files) is found from the scene file:
the nearest folder with `CLAUDE.md`, `.studio/` or `plugins/stickman/` above it (or the parent of its
`src/` folder); `STUDIO_PROJECT_DIR` overrides it. `doctor` shows which one was chosen and why.

## Extending the tool — plugins

Everything a scene can name is a registry entry; the built-ins use the same API. A plugin is
a Python file in `plugins/stickman/` of the project — it is loaded automatically by every
command. `studio-stickman plugin new <name> --kind action|pose|prop|fx|backdrop|sound|particle`
writes a working starter with the API explained in comments.

```python
from studio_stickman.api import action, backdrop, math, motion, np, particle, pose, prop, sound

pose("victory", doc="both arms up", RS=170, RE=-10, LS=165, LE=-10, H=-12)   # base="guard" starts from another pose

@action("backflip", params={"height": 150, "dur": 0.7}, doc="jump, turn once, land")
def backflip(a):                       # a.t, a.x, a.face, a.p (parameters), a.beat, a.floor, a.scale, a.ground
    d = a.p["dur"]
    a.key(0.12, "land", in_=0.12, ease="out")                      # keyframes: seconds after the start
    a.key(0.12 + d / 2, "jump", y=a.p["height"], rot=-180, in_=d / 2, ease="out")   # y counts from a.ground
    a.key(0.12 + d, "land", y=0, rot=-360, in_=d / 2, ease="in")
    a.key(0.36 + d, "stand", rot=0, in_=0)
    a.event(0.12 + d, sfx="land")                                  # any event: text=, hit=, shake=, burst= …
    # a.key_for(other, dt, pose, …) moves another figure · a.x_of(name) · a.free(name, t0, t1) · a.warn(msg)
    # a.doing(name, dt) → the action that figure is busy with, or None · a.key(…, ground=0) a new height to stand on

@motion("tremble", params={"amp": 4}, doc="the head shakes")       # fx: tremble
def tremble(st, t, p, ctx):            # st: the angles + x, y, rot, face — change in place
    st["H"] += math.sin(t * 40) * p["amp"]

@prop("lantern", params={"color": "#ffd060", "hold_angle": 0})     # (0, 0) = where it stands / the hand
def lantern(c, p, t):
    c.line((0, 0), (0, 26), 3, "#40444e")
    c.glow((0, 38), 40, p["color"])
    c.circle((0, 38), 12, fill=p["color"], outline="#0c0d11", width=2)

@backdrop("alley", params={"wall": "#2a2f3a"})                     # world coordinates; drawn again as the camera moves — keep it fast
def alley(c, w, h, floor, p):
    c.rect(0, 0, w, floor, fill=p["wall"])
    c.rect(0, floor, w, h - floor, fill="#15171c")

@sound("laser", params={"freq": 1400})                             # → numpy array, mono or (n, 2)
def laser(sr, p, rng):
    t = np.arange(int(0.25 * sr)) / sr
    return np.sin(2 * np.pi * (p["freq"] * np.exp(-t * 9)) * t) * np.exp(-t * 12) * 0.5

@particle("heart", params={"size": 10})                            # u: 0 (born) … 1 (gone)
def heart(c, x, y, age, u, seed, p):
    c.circle((x, y), p["size"] * (1 - u), fill="#ff5a8a")
```

Canvas (`c`): `line(a, b, width, color)`, `polyline(points, width, color)`, `circle(center, r, fill, outline, width)`,
`ellipse(center, rx, ry, fill, outline, width)`, `rect(x, y, w, h, fill, outline, width, radius)`,
`poly(points, fill, outline, width)`, `arc(center, r, start, end, width, color)`, `text(s, x, y, size, color)`,
`glow(center, r, color, strength=0.5)` (a soft light), `at(origin, angle, flip, scale)` → a canvas in a
moved/rotated coordinate system. Helpers in `studio_stickman.api`: `ik_limb(fwd, down, l1, l2, bend)`
solves an arm (`bend=1`) or a leg (`bend=-1`) so its end reaches a point, `fk(state, floor, scale, build)`
gives the joint positions, `limit`, `LIMITS`, `DIMS`. Parameters given in a scene are checked against
the type of their default value (number, color, true/false, list).

A plugin with a mistake does not break other scenes: `check` and `list` report the error with
the file name and line, and nothing of the broken file stays registered (`check --strict` exits 3).
When a scene uses a name such a plugin should have defined, the error says so. `check` plays the
scene through, so an fx or prop plugin that crashes is reported with figure, time and plugin line:
figures with a plugin fx and plugin props and particles are tried at every frame time a render
draws (other figures at their keys, plus two small frames). A plugin that fails while a frame is
drawn — in `sheet`, `still`, `sprite` or `render` — is a scene problem (exit 1, with the plugin's
file and line), not an internal error. A plugin pose with a hinge angle outside the joint limits
(elbows −10…160, knees −165…5, head −70…70) is drawn clamped; `check`, `list` and `poses` warn
with the file and line (`pose "victory" (plugins/stickman/victory.py line 3): RE -25 is drawn as -10 …`).
A plugin may import a helper module next to it. To share plugins or pose sets, put them in a pack (item kind `plugin` with
`meta.target: studio-stickman`, or kind `pose` with `meta.angles`) and list the pack under `use:`.

## Tips for good animation

- **Anticipation → action → reaction.** A wind-up before the move, a recoil after the hit. The
  strike actions do this; for your own moves add a short opposite pose first.
- **Timing is everything.** Fast things take 0.08–0.15 s (`in: 0.1`, `ease: snap`), relaxed ones
  0.3–0.6 s. Leave pauses: a beat of stillness before the punchline.
- **Hold, then move.** Do not let everything drift all the time — poses that hold read better.
- **One move at a time.** Let a figure's moves follow each other (leave out `t`, or `t: "+0"`);
  when `check` says two moves get mixed, the figure skates.
- **Use the camera.** Zoom in for the decisive moment, cut (`cut: true`) for surprise, follow a runner.
- **Sound sells it.** Every impact, step and jump has a sound; add `word:` for the big hits only.
- **Stay readable.** Keep figures apart (≥ 90 px), strong silhouettes, contrasting colors
  (`outline` on dark backgrounds).
- **Check the feet.** `sheet --at … --markers --focus <figure>`: a foot that should stand is green
  and stays where it is from one picture to the next.
