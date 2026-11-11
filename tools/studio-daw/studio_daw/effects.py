"""Built-in effects. Signature: fn(stereo, sr, params, ctx) -> stereo."""
from __future__ import annotations

from . import dsp
from .api import effect


@effect("gain", params={"db": 0.0}, doc="Volume change in dB.")
def gain(x, sr, p, ctx):
    return x * dsp.db_to_amp(p["db"])


@effect("pan", params={"value": 0.0}, doc="Stereo position -1 (left) … 1 (right).")
def pan(x, sr, p, ctx):
    return dsp.pan(x, p["value"])


@effect("width", params={"amount": 1.3}, doc="Stereo width (0 mono, 1 unchanged, >1 wider).")
def width(x, sr, p, ctx):
    return dsp.width(x, p["amount"])


@effect("eq", params={"low": 0.0, "mid": 0.0, "high": 0.0, "low_freq": 200, "mid_freq": 1200, "high_freq": 5000},
        doc="3-band EQ (dB): low shelf, mid peak, high shelf.")
def eq(x, sr, p, ctx):
    y = x
    if p["low"]:
        y = dsp.filt(y, "lowshelf", p["low_freq"], sr, 0.707, p["low"])
    if p["mid"]:
        y = dsp.filt(y, "peak", p["mid_freq"], sr, 0.9, p["mid"])
    if p["high"]:
        y = dsp.filt(y, "highshelf", p["high_freq"], sr, 0.707, p["high"])
    return y


@effect("lowpass", params={"cutoff": 2000, "q": 0.707}, doc="Low-pass filter.")
def lowpass(x, sr, p, ctx):
    return dsp.lowpass(x, p["cutoff"], sr, p["q"])


@effect("highpass", params={"cutoff": 120, "q": 0.707}, doc="High-pass filter.")
def highpass(x, sr, p, ctx):
    return dsp.highpass(x, p["cutoff"], sr, p["q"])


@effect("reverb", params={"mix": 0.25, "size": 2.0, "damp": 0.5, "predelay": 0.015}, doc="Room/hall reverb (size = decay seconds).")
def reverb(x, sr, p, ctx):
    return dsp.reverb(x, sr, p["mix"], p["size"], p["damp"], p["predelay"])


@effect("delay", params={"time": 0.75, "feedback": 0.35, "mix": 0.25, "pingpong": False},
        doc="Echo; time in beats (0.75 = dotted eighth).")
def delay(x, sr, p, ctx):
    return dsp.delay(x, sr, p["time"] * ctx["beat"], p["feedback"], p["mix"], bool(p["pingpong"]))


@effect("chorus", params={"depth": 0.003, "rate": 0.8, "mix": 0.4}, doc="Chorus / ensemble.")
def chorus(x, sr, p, ctx):
    return dsp.chorus(x, sr, p["depth"], p["rate"], p["mix"])


@effect("distortion", params={"drive": 2.5, "mix": 1.0}, doc="Tanh saturation / overdrive.")
def distortion(x, sr, p, ctx):
    return dsp.distortion(x, p["drive"], p["mix"])


@effect("compressor", params={"threshold": -18, "ratio": 3, "attack": 0.01, "release": 0.12, "makeup": 0.0}, doc="Compressor (dB).")
def compressor(x, sr, p, ctx):
    return dsp.compressor(x, sr, p["threshold"], p["ratio"], p["attack"], p["release"], p["makeup"])


@effect("limiter", params={"ceiling": -1.0}, doc="Peak limiter (ceiling in dBFS).")
def limiter(x, sr, p, ctx):
    return dsp.limiter(x, sr, p["ceiling"])


@effect("sidechain", params={"source": "kick", "amount": 0.6, "release": 0.18},
        doc="Duck this track when another track (source) plays — the classic pumping effect.")
def sidechain(x, sr, p, ctx):
    src = ctx["stems"].get(p["source"])
    if src is None:
        ctx["warnings"].append(f'sidechain on "{ctx["track"]}": source track "{p["source"]}" not found')
        return x
    return dsp.sidechain(x, src, sr, p["amount"], p["release"])


@effect("tremolo", params={"rate": 5.0, "depth": 0.5}, doc="Volume wobble (rate in Hz).")
def tremolo(x, sr, p, ctx):
    return dsp.tremolo(x, sr, p["rate"], p["depth"])


@effect("bitcrush", params={"bits": 8, "downsample": 1}, doc="Lo-fi bit reduction.")
def bitcrush(x, sr, p, ctx):
    return dsp.bitcrush(x, int(p["bits"]), int(p["downsample"]))


@effect("fade", params={"in": 0.0, "out": 0.0}, doc="Fade in/out (seconds).")
def fade(x, sr, p, ctx):
    return dsp.fade(x, sr, p["in"], p["out"])
