"""Starter files for `studio-3d new` and `studio-3d plugin new`."""

SCENE_TEMPLATES = {
    "basic": """# {{NAME}} — studio-3d scene (reference: studio-3d docs)
# Y is up, 1 unit = 1 metre, shapes stand on y = 0 and are centred on x/z.
scene:
  name: {{NAME}}

materials:
  walls: { color: "#e9e1d3", roughness: 0.9 }
  roof:  { color: "#a8432f", roughness: 0.8 }
  door:  dark-wood                    # built-in preset (studio-3d materials)

objects:
  - { name: ground, shape: plane, size: [12, 12], material: grass }
  - name: house
    group:
      - { name: body, shape: box, size: [4, 2.6, 3.2], material: walls }
      - { name: roof, shape: cone, radius: 3.3, height: 1.6, segments: 4, rotation: [0, 45, 0], position: [0, 2.6, 0], material: roof }
      - { name: door, shape: box, size: [0.9, 1.9, 0.08], position: [0, 0, 1.62], material: door }
      - name: windows
        shape: box
        size: [0.8, 0.8, 0.06]
        position: [-1.3, 1.2, 1.62]
        repeat: { count: 2, offset: [2.6, 0, 0] }
        material: glass
  - name: path
    shape: box
    size: [0.9, 0.02, 0.6]
    position: [0, 0, 2.3]
    repeat: { count: 5, offset: [0, 0, 0.8] }
    material: stone
  - name: bushes
    shape: sphere
    radius: 0.35
    detail: 1
    modifiers: [ { type: noise, amount: 0.06, scale: 3 }, flat ]
    position: [0, 0, 0]
    scatter: { count: 14, area: [11, 11], seed: 3, scale: [0.7, 1.4], avoid: [[0, 0, 3.2], [0, 3.5, 1]] }
    material: leaves

camera: { position: [9, 6, 10], target: [0, 1, 0] }
""",
    "props": """# {{NAME}} — a few props showing booleans, lathe, extrude and tubes
scene:
  name: {{NAME}}

objects:
  - name: arch
    boolean:
      op: difference
      objects:
        - { shape: box, size: [3, 3, 0.6] }
        - { shape: cylinder, radius: 0.9, height: 1, rotation: [90, 0, 0], position: [0, 1.4, -0.5] }
        - { shape: box, size: [1.8, 1.4, 1] }          # doorway, through the whole wall
    material: stone
  - name: vase
    shape: lathe
    profile: [[0, 0], [0.25, 0], [0.35, 0.3], [0.2, 0.7], [0.15, 0.9], [0.22, 1.0], [0, 1.0]]
    segments: 40
    position: [2.5, 0, 0]
    material: { color: "#2f6f9a", roughness: 0.25 }
  - name: sign
    shape: extrude
    points: [[-0.6, 0], [0.6, 0], [0.6, 0.1], [-0.6, 0.1]]
    height: 0.5
    position: [-2.5, 0.8, 0]
    material: wood
  - name: rail
    shape: tube
    path: [[-3, 0.9, 1], [-1, 1.1, 1.2], [1, 0.9, 1], [3, 1.1, 1.2]]
    radius: 0.05
    material: chrome
  - name: coins
    shape: cylinder
    radius: 0.15
    height: 0.03
    position: [2.5, 0, 1.2]
    repeat: { count: 6, offset: [0, 0.03, 0], rotate: [0, 17, 0] }
    material: gold
""",
    "terrain": """# {{NAME}} — terrain with scattered rocks and trees (uses the basic-3d pack)
scene:
  name: {{NAME}}

objects:
  - { name: land, shape: terrain, size: [40, 40], resolution: 80, height: 3, seed: 5, flat: 6, material: grass }
  - name: rocks
    use: basic-3d/rock
    params: { size: 0.8 }
    scatter: { count: 25, area: [36, 36], seed: 9, scale: [0.5, 1.6], avoid: [[0, 0, 6]] }
    material: rock
  - name: trees
    use: basic-3d/tree
    scatter: { count: 30, area: [38, 38], seed: 2, scale: [0.8, 1.3], min_distance: 2.5, avoid: [[0, 0, 7]] }

camera: { position: [28, 18, 28], target: [0, 0, 0] }
""",
    "organic": """# {{NAME}} — organic modelling: loft (smooth bodies) + blob (melted, sculpted parts)
# All parts of the fish use `absolute: true`: their coordinates are kept as written
# (one coordinate system for the whole model) instead of standing on y = 0.
scene:
  name: {{NAME}}

materials:
  scales: { color: "#ff6a00", roughness: 0.45 }
  fins:   { color: "#ff9a3c", roughness: 0.55, opacity: 0.9 }
  eye:    { color: "#0b0f19", roughness: 0.05 }
  seabed: { color: "#b89a62", roughness: 1.0 }

objects:
  - { name: seabed, shape: disc, radius: 0.9, segments: 64, material: seabed }

  - name: fish
    position: [0, 0, 0]
    group:
      - name: body                      # length along x, head at +x
        shape: loft
        axis: x
        absolute: true
        segments: 48
        smooth: 10
        sections:                        # [at, width, height, y]
          - [-0.50, 0.03, 0.08, 0.60]    # tail root
          - [-0.35, 0.10, 0.20, 0.60]
          - [-0.10, 0.20, 0.36, 0.61]
          - [ 0.15, 0.22, 0.38, 0.61]
          - [ 0.38, 0.16, 0.26, 0.60]
          - [ 0.52, 0.04, 0.06, 0.58]    # nose
        modifiers: [ { type: smooth, iterations: 3 } ]
        material: scales
      - name: tail                       # two thin lobes melted together
        shape: blob
        absolute: true
        blend: 0.03
        resolution: 96
        parts:
          - { ellipsoid: [0.15, 0.045, 0.010], at: [-0.61, 0.68, 0], rotation: [0, 0, -35] }
          - { ellipsoid: [0.15, 0.045, 0.010], at: [-0.61, 0.52, 0], rotation: [0, 0, 35] }
          - { sphere: 0.035, at: [-0.50, 0.60, 0] }
        material: fins
      - name: fins
        shape: blob
        absolute: true
        blend: 0.02
        resolution: 110
        parts:
          - { ellipsoid: [0.17, 0.07, 0.008], at: [0.0, 0.80, 0], rotation: [0, 0, -12] }       # dorsal
          - { ellipsoid: [0.08, 0.012, 0.04], at: [0.20, 0.53, 0.12], rotation: [0, -30, -25] } # pectoral
          - { ellipsoid: [0.08, 0.012, 0.04], at: [0.20, 0.53, -0.12], rotation: [0, 30, -25] }
        material: fins
      - { name: eye-left,  shape: sphere, radius: 0.028, detail: 3, position: [0.40, 0.632, 0.072], material: eye }
      - { name: eye-right, shape: sphere, radius: 0.028, detail: 3, position: [0.40, 0.632, -0.072], material: eye }

camera: { position: [1.4, 1.1, 1.9], target: [0, 0.55, 0] }
""",
    "textured": """# {{NAME}} — textures: procedural ones (made by studio-image), UV projections, relief
# A texture is an image file (assets/x.png), a studio-image picture (src/x.image.yaml) or a procedural
# texture written right here (resolution = its size in pixels). What exists: studio-3d textures
scene:
  name: {{NAME}}

materials:
  bricks:                               # box projection (the default): the same scale on every side
    texture: { type: bricks, colors: ["#3a2b26", "#8f3f2c", "#b5563c"], width: 128, height: 64, mortar: 8, vary: 0.5, resolution: 512 }
    bump: 1.5                           # relief from the texture itself (mortar is dark = low)
    roughness: 0.9
    texture_scale: 1.2                  # metres per repeat
  planks:
    texture: { type: wood, colors: ["#5a3a1e", "#a8763e"], rings: 7, grain: 0.4, resolution: 512 }
    bump: 0.5
    roughness: 0.7
    texture_scale: 1.5
  tiles:
    texture: { type: checker, colors: ["#d9d4c7", "#3b4252"], size: 64, resolution: 128 }
    roughness: 0.25
    texture_scale: 2                    # one repeat = 2 x 2 tiles = 2 m
  label:                                # wrapped around the can, exactly twice
    texture: { type: stripes, colors: ["#c0392b", "#f4f1e8"], width: 64, angle: 0, resolution: 256 }
    uv: { projection: cylinder, repeat: [2, 1] }
    roughness: 0.35
  planet:
    texture: { type: clouds, colors: ["#1f5fae", "#2f8f4e", "#e9e4d0"], scale: 120, cover: 0.55, resolution: 512 }
    uv: sphere
    roughness: 0.6
  sign:                                 # a whole picture written inline, shown once on the board
    texture:
      size: [512, 256]
      background: "#f2e8c9"
      layers:
        - { rect: [10, 10, 492, 236], radius: 18, fill: none, stroke: "#5a3a1e", stroke_width: 10 }
        - { text: "{{NAME}}", at: [256, 128], size: 72, font: bold, fill: "#3a2616", width: 440 }
    uv: fit                             # the picture exactly once, seen from the front (+z)
    roughness: 0.8
  plate:
    use: steel                          # built on a preset: the texture replaces its plain color
    texture: { type: cells, colors: ["#6f757c", "#c9ced4"], count: 60, resolution: 256 }
    roughness_map: { type: noise, scale: 32, resolution: 256 }
    bump: 0.4
    texture_scale: 0.8

objects:
  - { name: floor, shape: plane, size: [8, 8], material: tiles }
  - { name: wall, shape: box, size: [6, 2.4, 0.3], position: [0, 0, -3], material: bricks }
  - { name: crate, shape: box, size: [1, 1, 1], position: [-1.8, 0, -0.6], rotation: [0, 20, 0], material: planks }
  - { name: can, shape: cylinder, radius: 0.25, height: 0.7, position: [-0.2, 0, 0.6], material: label }
  - { name: planet, shape: sphere, radius: 0.6, detail: 4, position: [1.4, 0.9, -0.4], material: planet }
  - { name: stand, shape: cylinder, radius: 0.08, height: 0.3, position: [1.4, 0, -0.4], material: plate }
  - name: sign
    position: [-1.2, 0, -2.7]
    group:
      - { name: post, shape: box, size: [0.08, 1.4, 0.08], material: dark-wood }
      - { name: board, shape: box, size: [1.4, 0.7, 0.05], position: [0, 1.3, 0.06], material: sign }
  - { name: plate, shape: box, size: [1.2, 0.06, 1.2], position: [1.4, 0, 1.6], material: plate }

camera: { position: [5.5, 3.6, 6.5], target: [0, 0.9, -0.6] }
""",
}

PLUGIN_SHAPE = '''"""{{NAME}} — a studio-3d shape plugin (loaded from plugins/3d/).

Use it:  objects: [ { name: x, shape: {{NAME}}, height: 2 } ]
Conventions: Y up, metres, stand on y = 0, centred on x/z.
"""
from studio3d.api import box, cylinder, place, shape


@shape("{{NAME}}", params={"height": 2.0, "width": 1.0, "legs": 4}, doc="Describe the shape in one line (studio-3d shapes)")
def {{NAME}}(p):
    top = place(box([p["width"], 0.08, p["width"]]), y=p["height"])
    parts = [(top, "wood")]
    off = p["width"] / 2 - 0.06
    corners = [(-off, -off), (off, -off), (off, off), (-off, off)][: int(p["legs"])]
    for x, z in corners:
        parts.append((place(cylinder(radius=0.04, height=p["height"], segments=10), x=x, z=z), "metal"))
    return parts      # a mesh, or [(mesh, material-name), …]
'''

PLUGIN_MODIFIER = '''"""{{NAME}} — a studio-3d modifier plugin (loaded from plugins/3d/).

Use it:  modifiers: [ { type: {{NAME}}, amount: 0.1 } ]
"""
from studio3d.api import modifier, np


@modifier("{{NAME}}", params={"amount": 0.1}, doc="Describe the modifier in one line")
def {{NAME}}(mesh, p):
    m = mesh.copy()
    m.vertices = m.vertices + m.vertex_normals * p["amount"] * np.sin(m.vertices[:, 1] * 6)[:, None]
    return m
'''
