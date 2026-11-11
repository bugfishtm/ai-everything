"""Shapes + modifiers registries and plugin loading (same model as studio-daw).

Order (later wins): built-ins → pack plugins (when referenced; Global Space code only
after an admin review) → project plugins in plugins/3d/*.py.
A project plugin that fails to load does not break other scenes: the error is kept in PLUGIN_ERRORS
(scenes that use its shapes then say "unknown shape").
"""
from __future__ import annotations

import importlib.util
import os
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
    ui: dict = field(default_factory=dict)  # optional hints for the website editor: {param: {min, max, step, int, choices}}


SHAPES: dict[str, Entry] = {}
MODIFIERS: dict[str, Entry] = {}
WARNINGS: list[str] = []
PLUGIN_ERRORS: list[dict] = []
_current_source = "built-in"
_loaded: set[str] = set()


def register(kind: str, name: str, fn: Callable, params: dict | None, doc: str, ui: dict | None = None) -> None:
    table = SHAPES if kind == "shape" else MODIFIERS
    name = str(name)
    if name in table and _current_source != "built-in" and table[name].source != _current_source:
        WARNINGS.append(f'{kind} "{name}" from {_current_source} replaces the one from {table[name].source}')
    table[name] = Entry(name, fn, dict(params or {}), (doc or fn.__doc__ or "").strip(), _current_source, dict(ui or {}))


def load_file(path: Path, source: str) -> None:
    global _current_source
    key = str(path.resolve())
    if key in _loaded:
        return
    _loaded.add(key)
    spec = importlib.util.spec_from_file_location(f"studio3d_plugin_{len(_loaded)}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load plugin {path}")
    module = importlib.util.module_from_spec(spec)
    prev, _current_source = _current_source, source
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except Exception as e:  # noqa: BLE001
        raise ImportError(f"plugin {path} failed: {type(e).__name__}: {e}") from e
    finally:
        _current_source = prev


def project_dir() -> Path:
    env = os.environ.get("STUDIO_PROJECT_DIR")
    if env:
        return Path(env)
    p = Path.cwd()
    for d in [p, *p.parents]:
        if (d / "CLAUDE.md").exists() or (d / ".studio").is_dir():
            return d
    return p


def load_project_plugins() -> list[str]:
    base = project_dir()
    folder = base / "plugins" / "3d"
    found = []
    if folder.is_dir():
        for f in sorted(folder.glob("*.py")):
            rel = f.relative_to(base).as_posix()
            try:
                load_file(f, f"project:{rel}")
            except ImportError as e:
                if not any(x["file"] == rel for x in PLUGIN_ERRORS):
                    PLUGIN_ERRORS.append({"file": rel, "error": str(e).split(" failed: ", 1)[-1]})
                continue
            found.append(rel)
    return found


_builtins = False


def load_builtins() -> None:
    global _builtins
    if not _builtins:
        _builtins = True
        from . import modifiers, shapes  # noqa: F401

        del modifiers, shapes
