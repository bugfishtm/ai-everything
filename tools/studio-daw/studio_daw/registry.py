"""Registries for instruments ("voices") and effects + plugin loading.

Plugins are plain Python files that call @instrument / @effect (see api.py).
They are loaded from, in this order (later wins):
  1. built-ins (synths.py, effects.py)
  2. pack items of kind "plugin" — only when referenced, and for Global Space
     packs only after an admin reviewed the code
  3. the project: plugins/daw/*.py   ← this is where Claude extends the DAW

A plugin that fails to load does not break the DAW: the error is recorded in
PLUGIN_ERRORS (shown by `check`, `instruments`, the website DAW) and songs that
do not use it keep working.
"""
from __future__ import annotations

import hashlib
import importlib.util
import inspect
import math
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class Entry:
    name: str
    fn: Callable
    params: dict = field(default_factory=dict)
    doc: str = ""
    source: str = "built-in"
    kind: str = "voice"  # voice | effect
    drum: bool = False
    specs: dict = field(default_factory=dict)  # param name -> UI hints (min, max, step, unit, scale, options)
    file: str | None = None  # file that defined it (cache keys of rendered sounds)

    def ui(self) -> dict:
        """UI hints for every parameter: explicit ones from the plugin, guessed for the rest."""
        out = {}
        for k, v in self.params.items():
            explicit = self.specs.get(k, {})
            spec = {**param_spec(k, v), **explicit}
            if "type" not in explicit:
                if explicit.get("options"):
                    spec["type"] = "select"
                elif isinstance(v, (int, float)) and not isinstance(v, bool) and ("min" in explicit or "max" in explicit):
                    spec["type"] = "number"
            out[k] = spec
        return out

    def code_hash(self) -> str:
        return file_hash(self.file) if self.file else ""


VOICES: dict[str, Entry] = {}
EFFECTS: dict[str, Entry] = {}
_current_source = "built-in"
_current_file: str | None = None
_loaded_files: set[str] = set()
WARNINGS: list[str] = []
PLUGIN_ERRORS: list[dict] = []  # {"file": "plugins/daw/x.py", "source": ..., "error": "..."}

SPEC_KEYS = {"min", "max", "step", "unit", "scale", "options", "label", "type", "doc"}


def _split_params(params: dict | None) -> tuple[dict, dict]:
    """params may hold plain defaults or specs: {"cutoff": {"value": 500, "min": 50, "max": 8000, "unit": "Hz"}}."""
    values, specs = {}, {}
    for k, v in (params or {}).items():
        if isinstance(v, dict) and ("value" in v or "default" in v) and (set(v) - {"value", "default"}) <= SPEC_KEYS:
            values[k] = v.get("value", v.get("default"))
            specs[k] = {kk: vv for kk, vv in v.items() if kk in SPEC_KEYS}
        else:
            values[k] = v
    return values, specs


def register(kind: str, name: str, fn: Callable, params: dict | None = None, doc: str = "", drum: bool = False, ui: dict | None = None) -> None:
    table = VOICES if kind == "voice" else EFFECTS
    if name in table and table[name].source != _current_source and _current_source != "built-in":
        WARNINGS.append(f'{kind} "{name}" from {_current_source} replaces the one from {table[name].source}')
    values, specs = _split_params(params)
    for k, v in (ui or {}).items():
        if isinstance(v, (list, tuple)) and v and all(isinstance(x, str) for x in v):
            v = {"options": list(v)}
        elif isinstance(v, (list, tuple)):  # (min, max[, unit[, scale]])
            v = dict(zip(("min", "max", "unit", "scale"), v))
        if isinstance(v, dict):
            specs[k] = {**specs.get(k, {}), **{kk: vv for kk, vv in v.items() if kk in SPEC_KEYS}}
    src_file = _current_file
    if src_file is None:
        try:
            src_file = inspect.getsourcefile(fn)
        except TypeError:
            src_file = None
    table[name] = Entry(name, fn, values, (doc or (fn.__doc__ or "")).strip(), _current_source, kind, drum, specs, src_file)


def load_file(path: Path, source: str) -> None:
    global _current_source, _current_file
    key = str(path.resolve())
    if key in _loaded_files:
        return
    _loaded_files.add(key)
    spec = importlib.util.spec_from_file_location(f"studio_daw_plugin_{len(_loaded_files)}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load plugin {path}")
    module = importlib.util.module_from_spec(spec)
    prev, prev_file = _current_source, _current_file
    _current_source, _current_file = source, key
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except Exception as e:  # noqa: BLE001
        raise ImportError(f"plugin {path} failed: {type(e).__name__}: {e}") from e
    finally:
        _current_source, _current_file = prev, prev_file


def project_dir() -> Path:
    env = os.environ.get("STUDIO_PROJECT_DIR")
    if env:
        return Path(env)
    p = Path.cwd()
    for d in [p, *p.parents]:
        if (d / "CLAUDE.md").exists() or (d / ".studio").is_dir():
            return d
    return p


def load_project_plugins(base: Path | None = None, strict: bool = False) -> list[str]:
    """Load plugins/daw/*.py. A broken plugin is recorded in PLUGIN_ERRORS (or raised with strict=True)."""
    base = base or project_dir()
    found = []
    folder = base / "plugins" / "daw"
    if folder.is_dir():
        for f in sorted(folder.glob("*.py")):
            rel = str(f.relative_to(base))
            try:
                load_file(f, f"project:{rel}")
            except ImportError as e:
                if strict:
                    raise
                if not any(x["file"] == rel for x in PLUGIN_ERRORS):
                    PLUGIN_ERRORS.append({"file": rel, "source": f"project:{rel}", "error": str(e).split(" failed: ", 1)[-1]})
                continue
            found.append(rel)
    return found


def plugin_error_hint() -> str:
    if not PLUGIN_ERRORS:
        return ""
    return " — note: " + "; ".join(f'{e["file"]} failed to load ({e["error"]})' for e in PLUGIN_ERRORS)


_builtins_loaded = False


def load_builtins() -> None:
    global _builtins_loaded
    if _builtins_loaded:
        return
    _builtins_loaded = True
    from . import automation, effects, synths  # noqa: F401  (registration side effects)

    del automation, effects, synths
    sys.modules.setdefault("studio_daw.api", importlib.import_module("studio_daw.api"))


# ---------------------------------------------------------------------------
# Content hashes (cache keys for rendered sounds)
# ---------------------------------------------------------------------------
_hashes: dict[str, str] = {}


def file_hash(path: str | Path | None) -> str:
    if not path:
        return ""
    key = str(path)
    if key not in _hashes:
        try:
            _hashes[key] = hashlib.sha1(Path(key).read_bytes()).hexdigest()[:16]
        except OSError:
            _hashes[key] = "missing"
    return _hashes[key]


def engine_hash() -> str:
    """Changes when the DSP code of the DAW itself changes."""
    here = Path(__file__).resolve().parent
    return file_hash(here / "dsp.py") + file_hash(here / "instruments.py")


# ---------------------------------------------------------------------------
# UI hints for parameters (knobs in the website DAW). Plugins can be explicit:
#   @instrument("x", params={"cutoff": {"value": 800, "min": 50, "max": 8000, "unit": "Hz", "scale": "log"}})
# or  @instrument("x", params={"cutoff": 800}, ui={"cutoff": (50, 8000, "Hz", "log"), "wave": ["saw", "square"]})
# Everything else is guessed from the name and the default value.
# ---------------------------------------------------------------------------
_SECONDS = {"attack", "decay", "release", "predelay", "hold", "fade", "in", "out", "length", "glide", "portamento"}
_UNIT = {"sustain", "mix", "amount", "depth", "brightness", "tine", "click", "snappy", "sub", "leslie", "gate", "wet", "dry",
         "noise", "level", "damp", "bite", "move", "air", "body", "tone_mix", "accent", "feedback", "spread_mix", "width_mix"}
_HZ = {"cutoff", "tone", "freq", "frequency", "center", "start", "end", "low_freq", "mid_freq", "high_freq", "lfo_freq", "hp", "lp"}
_DB = {"db", "gain", "low", "mid", "high", "threshold", "ceiling", "makeup", "boost", "cut"}
_OSC = ["sine", "triangle", "square", "saw", "noise"]


def _nice(x: float) -> float:
    if x <= 0:
        return 1.0
    e = 10 ** math.floor(math.log10(x))
    for m in (1, 2, 2.5, 5, 10):
        if m * e >= x:
            return m * e
    return 10 * e


def param_spec(name: str, default) -> dict:
    n = name.lower()
    if isinstance(default, bool):
        return {"type": "bool"}
    if isinstance(default, str):
        if n in ("wave", "shape", "osc", "waveform", "oscillator") or default in _OSC:
            return {"type": "select", "options": _OSC}
        return {"type": "text"}
    if isinstance(default, (list, tuple)):
        return {"type": "list"}
    if not isinstance(default, (int, float)):
        return {"type": "json"}
    d = float(default)
    is_int = isinstance(default, int)
    spec: dict = {"type": "number"}
    if n in _SECONDS or n.endswith("_time") or n.endswith("_s"):
        spec.update(min=0, max=max(4.0, _nice(abs(d) * 3)), unit="s", scale="pow")
    elif n in _UNIT or n.endswith("_mix") or n.endswith("_amount"):
        spec.update(min=0, max=max(1.0, _nice(abs(d) * 2)) if d > 1 else 1)
    elif n in _HZ or n.endswith("_hz") or n.endswith("_freq") or n.endswith("cutoff"):
        spec.update(min=20, max=max(20000.0, d * 2), unit="Hz", scale="log")
    elif n in ("resonance", "q", "res", "reso"):
        spec.update(min=0.1, max=max(20.0, d * 2), scale="log")
    elif n in ("detune", "cents", "spread"):
        spec.update(min=-100 if n == "detune" else 0, max=max(100.0, abs(d) * 2), unit="cents")
    elif n in ("pitch",):
        spec.update(min=20, max=max(400.0, d * 3), unit="Hz", scale="log")
    elif n in _DB or n.endswith("_db"):
        spec.update(min=-60 if n == "threshold" else -24, max=0 if n in ("threshold", "ceiling") else 24, unit="dB")
    elif n in ("drive", "index", "envmod", "punch_amount"):
        spec.update(min=0, max=max(10.0, _nice(abs(d) * 2)))
    elif n in ("voices", "bits", "downsample", "steps", "partials", "harmonics"):
        spec.update(min=1, max=max(16, int(abs(d) * 2)), step=1)
        is_int = True
    elif n in ("rate", "lfo", "speed"):
        spec.update(min=0.01, max=max(20.0, d * 2), unit="Hz", scale="log")
    elif n in ("ratio",):
        spec.update(min=0.25 if d < 1.5 else 1, max=max(16.0, d * 2), scale="log")
    elif n in ("pan", "value", "balance"):
        spec.update(min=-1, max=1)
    elif n in ("vibrato",):
        spec.update(min=0, max=max(2.0, d * 2), unit="st")
    elif n in ("octave", "transpose", "semitones"):
        spec.update(min=-24 if n != "octave" else 0, max=24 if n != "octave" else 8, step=1)
        is_int = True
    elif n in ("time",):
        spec.update(min=0, max=4, unit="beats")
    elif n in ("size",):
        spec.update(min=0.1, max=max(10.0, d * 2), unit="s", scale="pow")
    elif n in ("punch",):
        spec.update(min=20, max=max(1000.0, d * 3), unit="Hz", scale="log")
    elif d == 0:
        spec.update(min=-1 if n.startswith(("bend", "offset", "shift")) else 0, max=1)
    elif 0 < d <= 1:
        spec.update(min=0, max=1)
    elif d > 1:
        spec.update(min=0, max=_nice(d * 4))
    else:
        m = _nice(abs(d) * 4)
        spec.update(min=-m, max=m)
    if is_int:
        spec["step"] = 1
    elif "step" not in spec:
        span = float(spec.get("max", 1)) - float(spec.get("min", 0))
        spec["step"] = 10 ** math.floor(math.log10(span / 1000)) if span > 0 else 0.01
    return spec
