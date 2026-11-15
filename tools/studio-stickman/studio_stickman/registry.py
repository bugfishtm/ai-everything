"""Registries (poses, actions, motions, props, backdrops, sounds, particles) + plugin loading.

Everything a scene can name lives in one of these tables. Built-ins register through the
same decorators as plugins (api.py), so they are equal citizens. Load order (later wins):
  1. built-ins
  2. pack items of kind "plugin" with meta.target = studio-stickman — when a scene lists the
     pack under `use:`; code of Global Space packs only after an admin reviewed it
  3. the project: plugins/stickman/*.py   <- this is where the AI extends the tool
A plugin that fails to load does not break other scenes: the error is kept in PLUGIN_ERRORS
and reported by check / render / the list commands, and whatever the plugin registered before
it failed is taken back out (a half-loaded plugin would otherwise act differently every run).
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class Entry:
    name: str
    fn: Callable | None
    params: dict = field(default_factory=dict)
    doc: str = ""
    source: str = "built-in"
    data: dict = field(default_factory=dict)  # poses: the angles


POSES: dict[str, Entry] = {}
ACTIONS: dict[str, Entry] = {}
MOTIONS: dict[str, Entry] = {}     # continuous modifiers ("fx": walk, type, shiver …)
PROPS: dict[str, Entry] = {}
BACKDROPS: dict[str, Entry] = {}
SOUNDS: dict[str, Entry] = {}
PARTICLES: dict[str, Entry] = {}
TABLES = {"pose": POSES, "action": ACTIONS, "motion": MOTIONS, "prop": PROPS, "backdrop": BACKDROPS, "sound": SOUNDS, "particle": PARTICLES}

WARNINGS: list[str] = []
# the same warnings for programs: message -> {"code", "where", "line"} (check --json warning_items)
WARNING_INFO: dict[str, dict] = {}
PLUGIN_ERRORS: list[dict] = []     # {"file": "plugins/stickman/x.py", "error": "SyntaxError: … (line 3)", "line": 3}
PLUGIN_FILES: list[str] = []       # plugin files that loaded (for `doctor`)
_current_source = "built-in"
_current_file: Path | None = None  # the plugin file that runs now (the line of a pose() call)
_loaded: set[str] = set()
# while a plugin file runs: what it registered, so a failure can take it back out again
# (an undo log instead of a staging area: a plugin may build on its own entries, e.g. pose(base=…))
_undo: list | None = None


def _warn(message: str, code: str, where: str | None = None, line: int | None = None) -> None:
    if message in WARNINGS:
        return
    WARNINGS.append(message)
    WARNING_INFO[message] = {k: v for k, v in (("code", code), ("where", where), ("line", line)) if v is not None}


def _plugin_line() -> int | None:
    """The line of the running plugin file that called into the registry (pose("x", …) on line 7)."""
    if _current_file is None:
        return None
    target = os.path.normcase(str(_current_file))
    f = sys._getframe(1)  # noqa: SLF001
    while f is not None:
        if os.path.normcase(os.path.abspath(f.f_code.co_filename)) == target:
            return f.f_lineno
        f = f.f_back
    return None


def _check_pose_limits(name: str, angles: dict) -> None:
    """A plugin or pack pose with a hinge angle the drawing clamps (an elbow bent backwards past -10,
    a knee forwards): it would be drawn differently from what the file says, without a word — warn."""
    try:
        from .skeleton import LIMITS
    except Exception:  # noqa: BLE001
        return
    bad = []
    for j, (lo, hi) in LIMITS.items():
        v = angles.get(j)
        if isinstance(v, (int, float)) and not lo <= v <= hi:
            bad.append(f"{j} {v:g} is drawn as {lo if v < lo else hi:g}")
    if not bad:
        return
    ranges: dict[tuple, list[str]] = {}
    for j, rng in LIMITS.items():
        ranges.setdefault(tuple(rng), []).append(j)
    allowed = ", ".join(f"{'/'.join(js)} {lo:g}..{hi:g}" for (lo, hi), js in ranges.items())
    where = _current_source.split(":", 1)[-1]
    line = _plugin_line()
    _warn(f'pose "{name}" ({where}{f" line {line}" if line else ""}): {", ".join(bad)} — hinge joints are clamped to their range while '
          f"drawing ({allowed}); change the value to one inside it", "pose-limits", where, line)


def register(kind: str, name: str, fn: Callable | None, params: dict | None = None, doc: str = "", data: dict | None = None) -> None:
    if kind not in TABLES:
        raise ValueError(f'unknown registry kind "{kind}" (kinds: {", ".join(TABLES)})')
    table = TABLES[kind]
    name = str(name)
    if _undo is not None:
        _undo.append((table, name, table.get(name)))
    if name in table and _current_source != "built-in" and table[name].source != _current_source:
        _warn(f'{kind} "{name}" from {_current_source} replaces the one from {table[name].source}', "plugin-replaces",
              _current_source.split(":", 1)[-1], _plugin_line())
    if kind == "pose" and _current_source != "built-in":
        _check_pose_limits(name, data or {})
    table[name] = Entry(name, fn, dict(params or {}), (doc or (fn.__doc__ if fn else "") or "").strip(), _current_source, dict(data or {}))


def _error_line(e: BaseException, path: Path) -> int | None:
    """The line of the plugin file where it went wrong (syntax errors carry it, others in the traceback)."""
    if isinstance(e, SyntaxError) and e.lineno:
        return int(e.lineno)
    line = None
    tb = e.__traceback__
    target = os.path.normcase(str(path.resolve()))
    while tb is not None:
        if os.path.normcase(os.path.abspath(tb.tb_frame.f_code.co_filename)) == target:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def load_file(path: Path, source: str) -> None:
    """Run one plugin file. Raises ImportError (never SystemExit or another BaseException) when it
    fails; everything it registered is then removed again."""
    global _current_source, _current_file, _undo
    path = Path(path)
    key = str(path.resolve())
    if key in _loaded:
        return
    _loaded.add(key)
    mod_name = f"studio_stickman_plugin_{re.sub(r'[^0-9A-Za-z_]', '_', path.stem)}_{len(_loaded)}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"plugin {path} failed: cannot load it as Python")
    module = importlib.util.module_from_spec(spec)
    # dataclasses, typing and pickle look a module up in sys.modules while it runs
    # (`from __future__ import annotations` + @dataclass crashed without this)
    sys.modules[mod_name] = module
    # a plugin may import a helper module next to it; appended, so it never shadows a real module
    folder = str(path.parent.resolve())
    added = folder not in sys.path
    if added:
        sys.path.append(folder)
    prev, _current_source = _current_source, source
    prev_file, _current_file = _current_file, path.resolve()
    prev_undo, _undo = _undo, []
    warn_mark = len(WARNINGS)
    failure: BaseException | None = None
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except KeyboardInterrupt:
        failure = KeyboardInterrupt()
    except BaseException as e:  # noqa: BLE001  (SystemExit too: a plugin must never end the command)
        failure = e
    finally:
        undo, _undo = _undo, prev_undo
        _current_source = prev
        _current_file = prev_file
        if added:
            try:
                sys.path.remove(folder)
            except ValueError:
                pass
    if failure is None:
        return
    # take back what the plugin registered before it failed
    for table, name, before in reversed(undo or []):
        if before is None:
            table.pop(name, None)
        else:
            table[name] = before
    for w in WARNINGS[warn_mark:]:
        WARNING_INFO.pop(w, None)
    del WARNINGS[warn_mark:]
    sys.modules.pop(mod_name, None)
    if isinstance(failure, KeyboardInterrupt):
        raise failure
    line = _error_line(failure, path)
    if isinstance(failure, SystemExit):
        what = f"SystemExit: the plugin called sys.exit({failure.code!r}) while loading — a plugin must only register things"
    elif isinstance(failure, SyntaxError):
        what = f"SyntaxError: {failure.msg}"
    else:
        what = f"{type(failure).__name__}: {failure}"
    if line and f"line {line}" not in what:
        what += f" (line {line})"
    err = ImportError(f"plugin {path} failed: {what}")
    err.plugin_line = line  # type: ignore[attr-defined]
    raise err from (None if isinstance(failure, SystemExit) else failure)


# --- where the project is ------------------------------------------------------------------
_anchor: Path | None = None
# the scene's folder, also for render worker processes that start fresh (spawn, Windows) and load the
# scene file again: they inherit the environment, so they find the same project and plugins
_ANCHOR_ENV = "STUDIO_STICKMAN_SCENE_DIR"


def use_scene(path: str | Path | None) -> None:
    """The command line calls this with the scene file before it loads it: the project (plugins,
    exports/, .studio/, audio files) is then found from the scene's folder, so the same scene gives
    the same result from whatever folder the command runs in."""
    global _anchor
    _anchor = Path(path).resolve().parent if path else None
    if _anchor is not None:
        os.environ[_ANCHOR_ENV] = str(_anchor)
    else:
        os.environ.pop(_ANCHOR_ENV, None)


def _marked(d: Path) -> str | None:
    if (d / "CLAUDE.md").is_file():
        return "CLAUDE.md"
    if (d / ".studio").is_dir():
        return ".studio/"
    if (d / "plugins" / "stickman").is_dir():
        return "plugins/stickman/"
    return None


def _walk_up(start: Path) -> tuple[Path, str] | None:
    for d in [start, *start.parents]:
        m = _marked(d)
        if m:
            return d, m
    return None


def project_dir_info() -> tuple[Path, str]:
    """The project folder and why it was chosen (for `doctor`)."""
    env = os.environ.get("STUDIO_PROJECT_DIR")
    if env:
        return Path(env), "STUDIO_PROJECT_DIR"
    cwd = Path.cwd()
    anchor = _anchor or (Path(os.environ[_ANCHOR_ENV]) if os.environ.get(_ANCHOR_ENV) else None)
    if anchor is not None:
        found = _walk_up(anchor)
        if found:
            return found[0], f"{found[1]} in or above the scene's folder"
        # scenes live in <project>/src/ by convention (`new src/x.stick.yaml`): its parent is the project
        if anchor.name.lower() == "src":
            return anchor.parent, "the scene is in a src/ folder (no CLAUDE.md, .studio/ or plugins/stickman/ found)"
    found = _walk_up(cwd)
    if found:
        return found[0], f"{found[1]} above the current folder"
    if anchor is not None and cwd not in (anchor, *anchor.parents):
        return anchor, "the scene's folder (no CLAUDE.md, .studio/ or plugins/stickman/ found)"
    return cwd, "the current folder (no CLAUDE.md, .studio/ or plugins/stickman/ found)"


def project_dir() -> Path:
    return project_dir_info()[0]


def load_project_plugins(base: Path | None = None) -> list[str]:
    base = base or project_dir()
    found = []
    folder = base / "plugins" / "stickman"
    if folder.is_dir():
        for f in sorted(folder.glob("*.py")):
            rel = f.relative_to(base).as_posix()
            try:
                load_file(f, f"project:{rel}")
            except ImportError as e:
                if not any(x["file"] == rel for x in PLUGIN_ERRORS):
                    PLUGIN_ERRORS.append({"file": rel, "error": str(e).split(" failed: ", 1)[-1], "line": getattr(e, "plugin_line", None)})
                continue
            if rel not in PLUGIN_FILES:
                PLUGIN_FILES.append(rel)
            found.append(rel)
    return found


def plugin_note() -> str:
    """Appended to "unknown action/pose/…" errors: the name may come from a plugin that did not load."""
    if not PLUGIN_ERRORS:
        return ""
    errs = "; ".join(f'{e["file"]} failed to load: {e["error"]}' for e in PLUGIN_ERRORS[:3])
    return f" (note: {errs} — fix it first)"


def load_pack(pack_id: str) -> list[str]:
    """`use: [pack-id]` in a scene: load the pack's stickman plugins and pose sets."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "python"))
    from studio_packs import find_pack  # noqa: E402

    pack = find_pack(pack_id)
    if pack is None:
        raise ImportError(f'pack "{pack_id}" not found (studio packs list)')
    loaded = []
    global _current_source
    for item in pack.items.values():
        meta = item.get("meta") or {}
        kind = item.get("kind")
        if kind == "plugin" and meta.get("target") == "studio-stickman":
            if not pack.code_allowed:
                raise ImportError(f'pack "{pack_id}" contains plugin code that an admin has not reviewed yet — it cannot run')
            path = pack.file(item)
            if path:
                load_file(path, f"pack:{pack_id}/{item['id']}")
                loaded.append(item["id"])
        elif kind == "pose" and isinstance(meta.get("angles"), dict):
            prev, _current_source = _current_source, f"pack:{pack_id}/{item['id']}"
            try:
                register("pose", item["id"], None, None, item.get("description") or item.get("name") or "", meta["angles"])
            finally:
                _current_source = prev
            loaded.append(item["id"])
    return loaded


_builtins = False


def load_builtins() -> None:
    global _builtins
    if _builtins:
        return
    _builtins = True
    from . import actions, poses, props, sfx  # noqa: F401  (registration side effects)

    sys.modules.setdefault("studio_stickman.api", importlib.import_module("studio_stickman.api"))


def suggest(word: str, options) -> str:
    import difflib

    close = difflib.get_close_matches(str(word), [str(o) for o in options], n=3, cutoff=0.5)
    return f" — did you mean {', '.join(close)}?" if close else ""


def close_matches(word: str, options, n: int = 3) -> list[str]:
    """The same matching as suggest(), as a list (for the "suggest" field of --json errors)."""
    import difflib

    return difflib.get_close_matches(str(word), [str(o) for o in options], n=n, cutoff=0.5)
