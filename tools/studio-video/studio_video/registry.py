"""Registries (transitions, generators) + plugin loading.

Load order (later wins): built-ins → pack plugins (meta.target = studio-video, packs listed
under `use:`; Global Space code only after an admin reviewed it) → the project's
plugins/video/*.py. A plugin that fails to load does not break other videos (PLUGIN_ERRORS).
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))


@dataclass
class Entry:
    name: str
    fn: Callable | None
    params: dict = field(default_factory=dict)
    doc: str = ""
    source: str = "built-in"


TRANSITIONS: dict[str, Entry] = {}
GENERATORS: dict[str, Entry] = {}
TABLES = {"transition": TRANSITIONS, "generator": GENERATORS}

WARNINGS: list[str] = []
PLUGIN_ERRORS: list[dict] = []
_current_source = "built-in"
_loaded: set[str] = set()


def register(kind: str, name: str, fn: Callable | None, params: dict | None = None, doc: str = "") -> None:
    table = TABLES[kind]
    name = str(name)
    if name in table and _current_source != "built-in" and table[name].source != _current_source:
        WARNINGS.append(f'{kind} "{name}" from {_current_source} replaces the one from {table[name].source}')
    table[name] = Entry(name, fn, dict(params or {}), (doc or (fn.__doc__ if fn else "") or "").strip(), _current_source)


def load_file(path: Path, source: str) -> None:
    global _current_source
    key = str(Path(path).resolve())
    if key in _loaded:
        return
    _loaded.add(key)
    spec = importlib.util.spec_from_file_location(f"studio_video_plugin_{len(_loaded)}", path)
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


def load_project_plugins(base: Path | None = None) -> list[str]:
    base = base or project_dir()
    found = []
    folder = base / "plugins" / "video"
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


def load_pack(pack_id: str) -> list[str]:
    from studio_packs import find_pack

    pack = find_pack(pack_id)
    if pack is None:
        raise ImportError(f'pack "{pack_id}" not found (studio packs list)')
    loaded = []
    for item in pack.items.values():
        meta = item.get("meta") or {}
        if item.get("kind") == "plugin" and meta.get("target") == "studio-video":
            if not pack.code_allowed:
                raise ImportError(f'pack "{pack_id}" contains plugin code that an admin has not reviewed yet — it cannot run')
            path = pack.file(item)
            if path:
                load_file(path, f"pack:{pack_id}/{item['id']}")
                loaded.append(item["id"])
    return loaded


def pack_file(ref: str) -> Path | None:
    from studio_packs import PackError, resolve

    try:
        _pack, _item, path = resolve(ref)
    except PackError:
        return None
    return path


_builtins = False


def load_builtins() -> None:
    global _builtins
    if _builtins:
        return
    _builtins = True
    from . import effects  # noqa: F401  (registration side effects)

    sys.modules.setdefault("studio_video.api", importlib.import_module("studio_video.api"))


def suggest(word: str, options) -> str:
    import difflib

    close = difflib.get_close_matches(str(word), [str(o) for o in options], n=3, cutoff=0.5)
    return f" — did you mean {', '.join(close)}?" if close else ""
