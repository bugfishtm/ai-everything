# studio-stickman — stick figure animation from text

Scenes are YAML files (`*.stick.yaml`): who is in the picture, what they do when, where the
camera looks, which words and sounds appear. `studio-stickman render` turns a scene into an
MP4 with synthesized sound effects (+ GIF/WebM, PNG frames, sprite sheets for games).

```bash
studio-stickman new src/duel.stick.yaml            # starter scene (--template fight|talk|dance|blank)
studio-stickman check src/duel.stick.yaml          # validate fast: names, parameters, timing warnings
studio-stickman sheet src/duel.stick.yaml          # contact sheet PNG of the key moments — LOOK at it
studio-stickman render src/duel.stick.yaml --preview    # → exports/duel.mp4 + .studio/previews/duel.png
studio-stickman render src/duel.stick.yaml --draft --from 3 --to 6   # half size, 15 fps, one part: fast
studio-stickman render src/duel.stick.yaml --gif --webm --frames     # more formats
studio-stickman still src/duel.stick.yaml 2.5 "3:1"     # single frames as PNG
studio-stickman sprite src/duel.stick.yaml --figure red --from 1 --to 2.6 --frames 8   # sprite sheet + atlas JSON
studio-stickman info src/duel.stick.yaml           # who does what when (a table)
studio-stickman list actions                       # catalogue: poses, actions, fx, props, backdrops, sounds, particles
studio-stickman poses guard block kick --preview   # pictures of poses with their names (several words: any of them)
studio-stickman plugin new backflip --kind action  # extend the tool (plugins/stickman/backflip.py)
```

**Watching without eyes:** videos cannot be read, pictures can. After every change run `sheet`
(or `render --preview`) and read the PNG: a grid of the key moments of the scene with time stamps
and what happens there. Use `--at 2.1,2.4,2.7` for exact moments and `still` for one large frame.
`check` reports warnings (a strike that cannot reach, a figure outside the picture, things after
the end). Work in this order: `check` → `sheet` → `render --draft` → `render`.

## Scene file

```yaml
scene:
  title: Duel
  size: [1280, 720]        # the video, even numbers up to 3840×2160
  fps: 30                  # 5–60
  background: dojo         # a backdrop (list backdrops), a color, or { use: street, night: false }
  bpm: 120                 # optional: the tempo of the music → times can be "bar:beat"
  time: 4/4
  audio: exports/song.mp3  # optional soundtrack: an audio file, or a studio-daw song (src/x.song.yaml — rendered
                           # for you, and its bpm becomes the scene's bpm); audio_gain: -3 (dB), audio_offset: 0.5
  sfx_gain: 0              # dB for all sound effects
  floor: 640               # y of the ground line (default: height - 80)
  world: [2400, 720]       # optional: scenery larger than the video — the camera can travel
  blend: 0.22              # default seconds a figure takes to move into a pose
  duration: 12             # optional: else the scene ends 1 s after the last thing
  style: { line: 9, outline: true, shadow: true, faces: true, highlight: true, vignette: 0.25, grain: 0 }

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

Coordinates are pixels: x to the right, y down, `(0, 0)` top left. Figures stand on the floor
at their `x`; the `y` of a figure is its height ABOVE the floor (jumps). A figure is about 215 px tall.

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
| `x`, `y`, `rot` | position, height above the floor, whole-body rotation (90 = lying, 360 = a flip) |
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
"Near" limbs are drawn in front. The lowest point of a pose rests on the floor automatically.

### Actions — `do:`

Actions write the keyframes for a whole move (and its sounds). `studio-stickman list actions`
prints all of them with parameters; the important ones:

| Action | Parameters |
|--------|-----------|
| `walk`, `run`, `sneak` | `to: 600` or `to: figure` (stops `gap` px in front), or `by: -200`; `speed` px/s or `dur`; `backwards`; `then: pose` |
| `enter`, `exit` | `side: left` / `right`, `to: x`, `run: true` |
| `jump` | `height`, `to`/`by`, `dur` |
| `punch`, `jab`, `uppercut`, `kick`, `highkick`, `lowkick`, `strike`, `swing` | `target: figure` → the figure steps into range (`lunge`), the hit gets sparks, a sound, a camera shake and the target reacts (`react: false` when the target blocks or dodges); `word: "POW!"`, `power: 1.6`, `ko: true` (the target goes down), `part: head` / `chest` / `knee`, `sfx: name`, `then: pose` |
| `combo` | `moves: [jab, jab, kick]`, `gap` between hits (`"1b"` = on every beat), same parameters as a strike; `ko` applies to the last one |
| `block`, `dodge` | `dur`; dodge `style: back` / `duck` — time them so they cover the impact of the attacker |
| `hurt`, `fall`, `getup` | a hit without an attacker (`from: front` / `back`), falling over (`dir`), standing up again |
| `wave`, `cheer`, `shrug`, `think`, `facepalm`, `bow`, `salute`, `laugh`, `talk`, `type` | `dur`, `then` |
| `point` | `at: figure` |
| `nod`, `turn`, `sit`, `stand` | `times`; `to: left` / `right` / a figure |
| `dance` | `beats: 8` (on the bpm of the scene) or `dur` |
| `throw` | the throwing movement — move the thrown prop with its own `keys` |
| `appear`, `vanish` | with a puff of smoke; `x`, `pose` |
| `wait` | `dur` |

Reactions never overwrite your own choreography: when the target has a keyframe of its own
around the impact, the automatic recoil is left out.

### Figures

`color` (without one a figure is dark on light scenery and light on dark scenery), `outline` (color),
`scale` (0.2–4), `line` (thickness), `x`, `face`, `pose`, `expr`,
`fx`, `visible`, `z` (drawing order), `label` (a name tag), and accessories: `hat`
(cap, tophat, crown, headband, helmet, beanie, horns), `glasses`, `tie`, `badge`, `belt`,
`scarf`, `cape`, `hair`, `shoes`, `skin`, `eyes` — `true` or a color. `build` changes the
proportions in px: `{ torso: 78, neck: 8, head: 19, upper_arm: 42, forearm: 40, thigh: 50, shin: 50 }`
(a child: `scale: 0.6, build: { head: 24 }`).

### Props

`kind` (default: the name of the prop), `x`, `y` (default: the floor), `rot`, `scale`, `flip`,
`layer: back` / `front` (behind or in front of the figures), `from` / `to` (visible only then) and
the parameters of the kind (`studio-stickman list props`). Kinds: rect, circle, line, poly,
label, image (`file:` a PNG of the project), crate, table, desk, chair, door, window, lamp,
plant, tree, bush, rock, platform, sign, ball, trophy; for hands: sword, bat, stick, shield,
mug, phone, bottle, briefcase, paper, flag, blaster.

```yaml
props:
  ball: { kind: ball, x: 300, keys: [ { t: 1, x: 300 }, { t: 1.8, x: 900, arc: 220, rot: 720 } ] }   # thrown
  mug:  { kind: mug, held_by: ana, hand: L, angle: 10, from: 2, to: 6 }                              # carried
```

### Camera

A list of keyframes: `t`, `x`, `y` (the point in the middle of the picture), `zoom` (1 = the
whole scene), `ease`, `cut: true` (jump instead of gliding), `follow: figure` (+ `dx`, `dy`).
The camera glides from key to key. Zoom in on the important moment; for wide travelling shots
make `scene.world` larger than `scene.size`.

### Events

| Event | Options |
|-------|---------|
| `text: "POW!"` | a word in the scene: `x`, `y`, `size`, `color`, `dur`, `rot`, `pop`, `ui: true` (fixed on the screen instead of in the world) |
| `say: "Hi!"` | speech bubble: `who: figure`, `dur` (default: by text length), `size`, `color`, `bubble`, `sfx` (the blip when it opens, default pop; `none` = silent) |
| `caption: "Later…"` | a subtitle at the bottom: `dur`, `size`, `color` |
| `title: "ROUND 1"` | a title card: `sub`, `dur`, `size`, `shade` |
| `hit: [x, y]` or `hit: { on: figure, part: head }` | impact: `word`, `sfx`, `shake`, `flash`, `sparks`, `zoom`, `gain` |
| `sfx: punch` | a sound: built-in (`list sounds`), a project file (`assets/x.wav`) or a pack item (`pack/item`); `gain`, `pan` + the parameters of the sound |
| `shake: 8` | camera shake in px, `dur` |
| `flash: true` | white flash: `dur`, `alpha` |
| `burst: confetti` | particles (spark, dust, smoke, debris, star, confetti, drop, glass): `x`, `y`, `n`, `speed`, `dir`, `spread`, `life`, `gravity`, `color`, `size` |
| `fade: in` / `fade: out` | `dur`, `color` |

## Output

| Command | Files |
|---------|-------|
| `render` | `exports/<name>.mp4` (H.264 + AAC); `--gif`, `--webm`, `--frames` (PNG sequence); `--preview` adds `.studio/previews/<name>.png` |
| `sheet`, `still`, `poses --preview` | PNGs in `.studio/previews/` |
| `sprite` | `exports/<name>-<figure>-sprite.png` (transparent, the figure stays in the middle of each cell) + `.json` atlas: frames with `x y w h t dx`, `anchor` (the feet), `fps` |

`--json` prints a report for programs: files, seconds, frames, size, sounds, warnings.

## Extending the tool — plugins

Everything a scene can name is a registry entry; the built-ins use the same API. A plugin is
a Python file in `plugins/stickman/` of the project — it is loaded automatically by every
command. `studio-stickman plugin new <name> --kind action|pose|prop|fx|backdrop|sound` writes
a working starter with the API explained in comments.

```python
from studio_stickman.api import action, backdrop, math, motion, np, particle, pose, prop, sound

pose("victory", doc="both arms up", RS=170, RE=-25, LS=165, LE=-25, H=-12)   # base="guard" starts from another pose

@action("backflip", params={"height": 150, "dur": 0.7}, doc="jump, turn once, land")
def backflip(a):                       # a.t, a.x, a.face, a.p (parameters), a.beat, a.floor, a.scale
    d = a.p["dur"]
    a.key(0.12, "land", in_=0.12, ease="out")                      # keyframes: seconds after the start
    a.key(0.12 + d / 2, "jump", y=a.p["height"], rot=-180, in_=d / 2, ease="out")
    a.key(0.12 + d, "land", y=0, rot=-360, in_=d / 2, ease="in")
    a.key(0.36 + d, "stand", rot=0, in_=0)
    a.event(0.12 + d, sfx="land")                                  # any event: text=, hit=, shake=, burst= …
    # a.key_for(other, dt, pose, …) moves another figure · a.x_of(name) · a.free(name, t0, t1) · a.warn(msg)

@motion("tremble", params={"amp": 4}, doc="the head shakes")       # fx: tremble
def tremble(st, t, p, ctx):            # st: the angles + x, y, rot, face — change in place
    st["H"] += math.sin(t * 40) * p["amp"]

@prop("lantern", params={"color": "#ffd060", "hold_angle": 0})     # (0, 0) = where it stands / the hand
def lantern(c, p, t):
    c.line((0, 0), (0, 26), 3, "#40444e")
    c.circle((0, 38), 12, fill=p["color"], outline="#0c0d11", width=2)

@backdrop("alley", params={"wall": "#2a2f3a"})                     # world coordinates, drawn once
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
`at(origin, angle, flip, scale)` → a canvas in a moved/rotated coordinate system.

A plugin with a mistake does not break other scenes: `check` and `list` report the error with
the file name. To share plugins or pose sets, put them in a pack (item kind `plugin` with
`meta.target: studio-stickman`, or kind `pose` with `meta.angles`) and list the pack under `use:`.

## Tips for good animation

- **Anticipation → action → reaction.** A wind-up before the move, a recoil after the hit. The
  strike actions do this; for your own moves add a short opposite pose first.
- **Timing is everything.** Fast things take 0.08–0.15 s (`in: 0.1`, `ease: snap`), relaxed ones
  0.3–0.6 s. Leave pauses: a beat of stillness before the punchline.
- **Hold, then move.** Do not let everything drift all the time — poses that hold read better.
- **Use the camera.** Zoom in for the decisive moment, cut (`cut: true`) for surprise, follow a runner.
- **Sound sells it.** Every impact, step and jump has a sound; add `word:` for the big hits only.
- **Stay readable.** Keep figures apart (≥ 90 px), strong silhouettes, contrasting colors
  (`outline` on dark backgrounds).
