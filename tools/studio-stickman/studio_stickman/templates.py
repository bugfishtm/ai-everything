"""Starter files for `studio-stickman new` and `studio-stickman plugin new`."""

SCENES = {
    "fight": """# {{TITLE}} — studio-stickman scene (reference: studio-stickman docs)
scene:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30
  background: dojo            # studio-stickman list backdrops
  # bpm: 120                  # with the tempo of the music, times can be bars and beats: t: "3:1"
  # audio: exports/song.mp3   # soundtrack (the sound effects are mixed on top)

figures:
  red:  { color: "#c0392b", x: 420, face: right, hat: headband }
  blue: { color: "#2b5fc0", x: 860, face: left }

timeline:                     # per figure: poses (reached AT t) and actions (do: …)
  red:
    - { t: 0, pose: guard }
    - { t: 1.0, do: walk, to: blue, gap: 110 }
    - { do: jab, target: blue }                          # no t: starts when the walk ended
    - { do: punch, target: blue, word: "POW!" }
    - { t: 4.45, do: block, dur: 0.5 }                   # blue's kick lands at 4.6
    - { t: 6.2, do: highkick, target: blue, ko: true, word: "K.O.!", power: 1.6 }
    - { t: 7.6, do: cheer, dur: 1.4 }
  blue:
    - { t: 0, pose: guard }
    - { t: 4.6, do: kick, target: red, react: false, sfx: thud }    # red blocks it (see above)
    - { t: 5.4, pose: guard, expr: angry }

camera:                       # plain keyframes: the camera glides from one to the next
  - { t: 0, x: 640, y: 380, zoom: 1.0 }
  - { t: 2.5, x: 700, y: 420, zoom: 1.25 }
  - { t: 5.9, x: 760, y: 420, zoom: 1.25 }
  - { t: 6.2, x: 820, y: 430, zoom: 1.45, ease: snap }
  - { t: 7.4, follow: red, zoom: 1.3 }
  - { t: 9.5, x: 640, y: 380, zoom: 1.0 }

events:
  - { t: 0.2, title: "ROUND 1", dur: 1.4, size: 90 }
  - { t: 7.9, text: "WINNER", x: 420, y: 250, size: 54, dur: 1.6 }
""",
    "talk": """# {{TITLE}} — two figures talking (reference: studio-stickman docs)
scene:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30
  background: room

figures:
  ana: { color: "#18181c", x: 430, face: right, hair: "#5a3a1a" }
  ben: { color: "#18181c", x: 850, face: left, glasses: true, tie: true }

props:
  plant: { kind: plant, x: 1120 }
  lamp:  { kind: lamp, x: 160 }

timeline:
  ana:
    - { t: 0.6, do: wave, dur: 0.9, say: "Hi Ben!" }
    - { t: 3.2, do: point, at: ben, say: "Is that a new tie?" }
    - { t: 7.0, do: laugh, dur: 1.2 }
  ben:
    - { t: 1.8, do: nod, say: "Hello!" }
    - { t: 5.0, do: shrug, say: "It was on sale." }
    - { t: 7.2, pose: hero, expr: happy }

camera:
  - { t: 0, x: 640, y: 400, zoom: 1.15 }
""",
    "dance": """# {{TITLE}} — dancing on the beat (reference: studio-stickman docs)
scene:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30
  bpm: 120                    # the tempo: "bar:beat" times and beat lengths (2b) follow it
  background: stage
  # audio: exports/song.mp3

figures:
  a: { color: "#f2c14e", x: 440, outline: "#000000" }
  b: { color: "#59c3c3", x: 640, outline: "#000000", scale: 1.1 }
  c: { color: "#f78154", x: 840, outline: "#000000", face: left }

timeline:
  a: [ { t: "1:1", do: dance, beats: 14 } ]
  b: [ { t: "2:1", do: dance, beats: 12 }, { t: "5:1", do: jump, height: 150 } ]
  c: [ { t: "3:1", do: dance, beats: 10 } ]

camera:
  - { t: 0, zoom: 1.0 }
  - { t: "5:1", zoom: 1.2, y: 400 }

events:
  - { t: "5:1", burst: confetti, x: 640, y: 120, n: 60, speed: 260, spread: 2, life: 2.4 }
  - { t: "5:1", sfx: powerup }
""",
    "blank": """# {{TITLE}} — studio-stickman scene (reference: studio-stickman docs)
scene:
  title: {{TITLE}}
  size: [1280, 720]
  fps: 30
  background: gradient

figures:
  hero: { color: "#f2f2f2", x: 640, outline: "#000000" }

timeline:
  hero:
    - { t: 1, do: wave }
""",
}

PLUGINS = {
    "action": '''"""{{NAME}} — a studio-stickman action (loaded from plugins/stickman/).

Use it in a scene:   timeline: { hero: [ { t: 2, do: {{NAME}}, height: 160 } ] }
"""
from studio_stickman.api import action


@action("{{NAME}}", params={"height": 150, "dur": 0.7}, doc="Describe the move in one line (shown by: studio-stickman list actions)")
def {{NAME}}(a):
    # a.t start (s) · a.x / a.face where the figure is · a.p the parameters · a.beat seconds per beat
    # a.key(dt, pose, **kw): a keyframe dt seconds after the start — kw: x, y (height), rot, face, ease,
    #   expr, fx, arc, in_ (transition seconds) and single angles (RS=120 …)
    # a.event(dt, sfx="thud") / text= / hit= / shake= / burst= …    a.key_for(other, dt, pose) for reactions
    d = a.p["dur"]
    a.key(0.12, "land", in_=0.12, ease="out")
    a.key(0.12 + d / 2, "jump", y=a.p["height"], rot=-180, in_=d / 2, ease="out")
    a.key(0.12 + d, "land", y=0, rot=-360, in_=d / 2, ease="in")
    a.key(0.36 + d, "stand", rot=0, in_=0)
    a.event(0.12 + d, sfx="land")
''',
    "pose": '''"""{{NAME}} — studio-stickman poses (loaded from plugins/stickman/).

Angles in degrees, 0 = hanging down / upright, positive = towards the side the figure faces:
T torso · H head · RS/RE near shoulder/elbow · LS/LE far shoulder/elbow · RH/RK near hip/knee · LH/LK far hip/knee
Optional: rot (whole body, 90 = lying) and y (height above the floor). Missing angles come from "stand".
Look at it:  studio-stickman poses {{NAME}} --preview
"""
from studio_stickman.api import pose

pose("{{NAME}}", doc="Describe the pose in one line", T=-6, H=-8, RS=160, RE=-25, LS=30, LE=90, RH=14, RK=-8, LH=-14, LK=-6)
''',
    "prop": '''"""{{NAME}} — a studio-stickman prop (loaded from plugins/stickman/).

Use it:   props: { thing: { kind: {{NAME}}, x: 600 } }            standing on the floor
          props: { thing: { kind: {{NAME}}, held_by: hero, hand: R } }   in a hand
"""
from studio_stickman.api import prop


@prop("{{NAME}}", params={"size": 60, "color": "#d0a040", "hold_angle": 80}, doc="Describe the prop in one line")
def {{NAME}}(c, p, t):
    # local coordinates: (0, 0) = where it stands (or the hand), -y is up, +x is forward; t = time (for animation)
    # c.line(a, b, width, color) · c.circle(center, r, fill, outline, width) · c.rect(x, y, w, h, fill, outline, width, radius)
    # c.poly(points, fill, outline, width) · c.ellipse(center, rx, ry, fill) · c.text(s, x, y, size, color) · c.at(origin, angle)
    s = p["size"]
    c.rect(-s / 2, -s, s, s, fill=p["color"], outline="#0c0d11", width=2.5, radius=6)
    c.circle((0, -s / 2), s * 0.2, fill="#ffffff")
''',
    "fx": '''"""{{NAME}} — a studio-stickman motion (continuous movement, used with fx:).

Use it:   timeline: { hero: [ { t: 1, pose: stand, fx: {{NAME}} } ] }     or   fx: { use: {{NAME}}, amount: 2 }
"""
import math

from studio_stickman.api import motion


@motion("{{NAME}}", params={"amount": 1.0}, doc="Describe the movement in one line")
def {{NAME}}(st, t, p, ctx):
    # st: the angles (T H RS RE LS LE RH RK LH LK) and x, y, rot, face — change them in place
    # ctx["beat"]: seconds per beat when the scene has a bpm (else None)
    st["RS"] += math.sin(t * 12) * 20 * p["amount"]
    st["H"] += math.sin(t * 6) * 6 * p["amount"]
''',
    "backdrop": '''"""{{NAME}} — a studio-stickman backdrop (loaded from plugins/stickman/).

Use it:   scene: { background: {{NAME}} }     or   background: { use: {{NAME}}, sky: "#203050" }
"""
from studio_stickman.api import backdrop


@backdrop("{{NAME}}", params={"sky": "#203050", "ground": "#2f3b2f"}, doc="Describe the place in one line")
def {{NAME}}(c, w, h, floor, p):
    # world coordinates: (0, 0) top left, the figures stand on y = floor; drawn once
    c.rect(0, 0, w, floor, fill=p["sky"])
    c.rect(0, floor, w, h - floor, fill=p["ground"])
    c.circle((w * 0.8, floor * 0.3), 46, fill="#f4f1d8")
''',
    "sound": '''"""{{NAME}} — a studio-stickman sound effect (loaded from plugins/stickman/).

Use it:   events: [ { t: 2, sfx: {{NAME}} } ]     or as the sound of a hit:  { do: punch, target: x, sfx: {{NAME}} }
"""
from studio_stickman.api import np, sound


@sound("{{NAME}}", params={"freq": 900}, doc="Describe the sound in one line")
def {{NAME}}(sr, p, rng):
    # return a numpy array: mono (n,) or stereo (n, 2), values around -0.6 … 0.6; rng = numpy random generator
    n = int(0.3 * sr)
    t = np.arange(n) / sr
    return np.sin(2 * np.pi * p["freq"] * np.exp(-t * 8) * t) * np.exp(-t * 10) * 0.6
''',
}
