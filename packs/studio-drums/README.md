# Studio Drums

Synthesized one-shots (CC0) and two kits.

```yaml
instruments:
  drums: { use: studio-drums/kit }        # rows: kick snare clap rim hat ohat tom1 tom2 tom3 crash ride shaker cowbell
  trap:  { use: studio-drums/kit-808 }    # same rows, 808 kick, clap as snare
  boom:  { use: studio-drums/kick-808 }   # a single sample: play it with notes or a grid row
patterns:
  beat:
    drums: |
      kick:  x-----x---x-----
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-x-x-
```

Samples: kick-punchy, kick-deep, kick-808, snare-tight, snare-fat, clap, rim, hat-closed, hat-open,
tom-high, tom-mid, tom-low, crash, ride, shaker, cowbell (`studio packs path studio-drums/<id>`).
