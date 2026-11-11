"""Acid bass — example studio-daw instrument plugin shipped in the studio-synths pack.

Filter envelope (block-wise time-varying low-pass), accent on loud notes.
Use:  instruments: { acid: { use: studio-synths/acid, cutoff: 420 } }
"""
from studio_daw.api import adsr, instrument, lowpass, np, osc


@instrument("acid", params={"cutoff": 380, "resonance": 7.0, "envmod": 3.5, "decay": 0.22, "release": 0.04, "wave": "saw"},
            doc="303-style acid bass: resonant filter sweep per note, accent on velocity > 0.8")
def acid(freq, dur, vel, sr, p):
    n_note = max(1, int(dur * sr))
    amp = adsr(n_note, sr, 0.002, 0.3, 0.75, p["release"])
    n = len(amp)
    x = osc(p["wave"], freq, n, sr)
    accent = 1.6 if vel > 0.8 else 1.0
    fenv = np.exp(-np.arange(n) / (p["decay"] * sr))
    out = np.empty(n)
    block = 256
    for start in range(0, n, block):
        end = min(n, start + block)
        cut = p["cutoff"] * (1 + p["envmod"] * accent * fenv[start])
        # filter with one block of run-up so the changing cutoff does not click
        seg = x[max(0, start - block) : end]
        y = lowpass(seg, min(cut, sr * 0.45), sr, q=p["resonance"])
        out[start:end] = y[-(end - start) :]
    return np.tanh(out * 1.5) * amp * (vel**1.2) * 0.45
