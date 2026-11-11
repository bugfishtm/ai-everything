# Studio Synths

Presets for the built-in synths plus one plugin instrument.

```yaml
instruments:
  bass: { use: studio-synths/acid, cutoff: 420, octave: 2 }   # plugin (code in plugins/acid.py)
  pad:  { use: studio-synths/warm-pad }                        # preset = built-in synth + settings
  keys: { use: studio-synths/lofi-keys }
  lead: { use: studio-synths/chip-lead, octave: 5 }
  sub:  { use: studio-synths/sub-bass, octave: 1 }
  bell: { use: studio-synths/glass-bell, octave: 5 }
```

A preset is a JSON file `{ "use": "<synth>", …params }`; settings written in the song override it.
`plugins/acid.py` shows how to write an instrument with `studio_daw.api` — copy it into your
project's `plugins/daw/` to change it, or make your own with `studio-daw plugin new <name>`.
