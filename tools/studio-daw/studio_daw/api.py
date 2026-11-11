"""Public plugin API for studio-daw.

A plugin is a .py file in <project>/plugins/daw/ (or a pack item of kind "plugin"):

    from studio_daw.api import instrument, effect, osc, adsr, lowpass, np

    @instrument("acid", params={"cutoff": 500, "resonance": 4.0, "decay": 0.25},
                doc="Squelchy 303-style bass")
    def acid(freq, dur, vel, sr, p):
        n = int(dur * sr)
        env = adsr(n, sr, 0.003, p["decay"], 0.0, 0.05)
        x = osc("saw", freq, len(env), sr)
        return lowpass(x, p["cutoff"] * (1 + 4 * env.max()), sr, q=p["resonance"]) * env * vel

    @effect("crusher", params={"bits": 6})
    def crusher(x, sr, p, ctx):
        return bitcrush(x, int(p["bits"]))

Parameters can carry UI hints for the knobs of the website DAW (optional — ranges are
guessed from names like cutoff/attack/mix otherwise):

    @instrument("acid", params={"cutoff": {"value": 500, "min": 50, "max": 8000, "unit": "Hz", "scale": "log"},
                                "wave": {"value": "saw", "options": ["saw", "square"]}})
    # or: @instrument("acid", params={"cutoff": 500}, ui={"cutoff": (50, 8000, "Hz", "log")})

Instrument functions get the note frequency (Hz), the held duration (seconds),
velocity (0..1), the sample rate and the merged params; they return a mono or
stereo numpy array (it may be longer than `dur` for release tails).
`drum=True` marks one-shot sounds (freq is still passed, usually ignored).

Effect functions get a stereo (n, 2) float array and return one of the same shape.
`ctx` has: bpm, beat (seconds per beat), stems (dict of rendered tracks), track.
"""
from __future__ import annotations

from typing import Callable

import numpy as np  # noqa: F401  (re-exported for plugins)

from .dsp import (  # noqa: F401  (re-exported)
    adsr,
    bandpass,
    bitcrush,
    chorus,
    compressor,
    db_to_amp,
    delay,
    distortion,
    exp_decay,
    filt,
    highpass,
    lowpass,
    osc,
    pan,
    phase,
    reverb,
    to_stereo,
    tremolo,
)
from .notation import midi_to_freq, note_to_midi  # noqa: F401
from .registry import register


def instrument(name: str, params: dict | None = None, doc: str = "", drum: bool = False, ui: dict | None = None) -> Callable:
    """Register an instrument. params: defaults (or {"value": x, "min": …, "max": …} specs), ui: optional knob hints."""

    def deco(fn: Callable) -> Callable:
        register("voice", name, fn, params, doc, drum, ui)
        return fn

    return deco


def effect(name: str, params: dict | None = None, doc: str = "", ui: dict | None = None) -> Callable:
    """Register an effect: fn(x, sr, p, ctx) -> x (stereo (n, 2) arrays)."""

    def deco(fn: Callable) -> Callable:
        register("effect", name, fn, params, doc, ui=ui)
        return fn

    return deco
