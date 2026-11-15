"""studio-stickman command line.

The contract for programs (an AI agent, Studio's web UI, studio-video), see README "Command line":
- `--json` (before or after the command) prints ONE JSON object as the last line of stdout, with
  "ok", "command" and "version". Files are always a {kind: path} dict. A failure also has "error"
  (the message; one line per problem) and "errors" (a list of {message, where, line, col, code,
  got, suggest}). "warnings" stay plain strings (Studio's web UI prints them as text);
  "warning_items" carry where / line / code for programs.
- Progress goes to stderr: lines of text, or JSON lines ({"phase": …}) with --json.
- Exit codes: 0 ok · 1 the scene (or a name in it) is wrong · 2 the command line is wrong ·
  3 warnings under check --strict · 4 something outside the scene is missing (ffmpeg, an encoder,
  a folder that cannot be written) · 70 an internal error (a bug — the message says where).
"""
from __future__ import annotations

import argparse
import inspect
import json
import keyword
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

from . import __version__, registry
from .templates import PLUGINS, SCENES

EXIT_OK, EXIT_SCENE, EXIT_USAGE, EXIT_STRICT, EXIT_ENV, EXIT_INTERNAL = 0, 1, 2, 3, 4, 70
_KIND_OF_EXIT = {EXIT_SCENE: "scene", EXIT_USAGE: "usage", EXIT_STRICT: "strict", EXIT_ENV: "environment", EXIT_INTERNAL: "internal"}
TOOL_DIR = Path(__file__).resolve().parents[1]
MAX_SHEET = 48            # frames on one contact sheet: more cannot be read in one picture anyway
RESOLUTIONS = {"360p": 360, "480p": 480, "540p": 540, "720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160, "4k": 2160}


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
class Fail(Exception):
    """Ends a command: the message, and the exit code that says what kind of problem it is."""

    def __init__(self, message: str, code: int = EXIT_SCENE, *, errors: list[dict] | None = None, kind: str | None = None,
                 got=None, suggest: list | None = None, where: str | None = None, **extra):
        super().__init__(message)
        self.message = message
        self.code = code
        if errors is None:
            item = {"message": message, "code": kind or _KIND_OF_EXIT.get(code, "error")}
            for k, v in (("where", where), ("got", got), ("suggest", suggest)):
                if v not in (None, [], ""):
                    item[k] = v
            errors = [item]
        self.errors = errors
        self.extra = extra

    @property
    def error_text(self) -> str:
        msgs = [str(e.get("message", "")) for e in self.errors]
        return msgs[0] if len(msgs) == 1 else "\n".join(msgs)


def _print_json(data: dict) -> None:
    sys.stdout.write(json.dumps(data, default=str) + "\n")
    sys.stdout.flush()


def _emit(args, data: dict, text: str) -> None:
    if getattr(args, "json", False):
        _print_json({"ok": data.pop("ok", True), "command": getattr(args, "cmd", None), "version": __version__, **data})
    else:
        print(text, flush=True)


def _report_failure(args, f: Fail) -> None:
    if getattr(args, "json", False):
        _print_json({"ok": False, "command": getattr(args, "cmd", None), "version": __version__, "error": f.error_text, "errors": f.errors,
                     "exit": f.code, **f.extra})
        return
    if len(f.errors) > 1:
        print(f"studio-stickman: {f.message}", file=sys.stderr)
        for e in f.errors:
            print(f"  - {e.get('message')}", file=sys.stderr)
    else:
        print(f"studio-stickman: {f.message}", file=sys.stderr)


class _Quiet:
    """Plugins may print(): while a command works that goes to stderr, so stdout stays clean JSON."""

    def __enter__(self):
        self.prev = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *exc):
        sys.stdout = self.prev


_WHERE_RX = re.compile(r"^((?:[A-Za-z_][\w\-]*|\[\d+\])(?:\.[\w\-]+|\[\d+\])*)(?: \(line (\d+)\))?: ")


def _line_of(scene, where: str | None) -> int | None:
    fn = getattr(scene, "line_of", None)
    if not fn or not where:
        return None
    try:
        return fn(where)
    except Exception:  # noqa: BLE001  (a line number is a nicety, never a reason to fail)
        return None


def _warning_item(scene, w: str) -> dict:
    d: dict = {"message": w, "code": "warning"}
    # "plugin plugins/stickman/x.py failed to load: …" or "plugins/stickman/x.py: plugin failed to load: …"
    pm = re.match(r"^(?:plugin (\S+?)|(\S+?\.py):\s*plugin) failed to load: .*?(?:\(line (\d+)\))?$", w)
    if pm:
        d.update({"code": "plugin-load", "where": pm.group(1) or pm.group(2)}, **({"line": int(pm.group(3))} if pm.group(3) else {}))
        return d
    m = _WHERE_RX.match(w)
    if m:
        d["where"] = m.group(1)
        line = int(m.group(2)) if m.group(2) else _line_of(scene, m.group(1))
        if line:
            d["line"] = line
    return d


class _Notes:
    """The warnings of one command: plain strings (what people and Studio's web UI read) and the same
    as items with where / line / code (what programs read)."""

    def __init__(self, scene=None):
        self.scene = scene
        self.text: list[str] = []
        self.items: list[dict] = []
        if scene is None:
            return
        ws = [str(w) for w in scene.warnings]
        items = list(getattr(scene, "warning_items", None) or [])
        if len(items) != len(ws):
            items = [_warning_item(scene, w) for w in ws]
        self.text = ws
        self.items = [{k: v for k, v in dict(i).items() if v is not None} for i in items]
        self.add_registry()

    def add_registry(self) -> None:
        """What loading the plugins found: a plugin that replaces a built-in, a pose outside the joint limits."""
        info = getattr(registry, "WARNING_INFO", {})
        for w in registry.WARNINGS:
            i = info.get(w, {})
            self.add(w, i.get("code", "plugin-replaces"), where=i.get("where", "plugins"), line=i.get("line"))

    def add(self, message: str, code: str = "warning", where: str | None = None, line: int | None = None) -> None:
        if message in self.text:
            return
        self.text.append(message)
        item: dict = {"message": message, "code": code}
        if where:
            item["where"] = where
        if line:
            item["line"] = line
        self.items.append(item)

    def add_scene_strings(self, ws) -> None:
        for w in ws or []:
            if str(w) not in self.text:
                self.text.append(str(w))
                self.items.append(_warning_item(self.scene, str(w)))

    def lines(self) -> list[str]:
        return [f"warning: {w}" for w in self.text]


# ---------------------------------------------------------------------------
# Scenes
# ---------------------------------------------------------------------------
_STDIN_TEXT: dict[str, str] = {}      # a scene read from stdin ("-"): kept for `info` (it re-reads the YAML)


def _scene_file(arg: str) -> Path | None:
    """The scene file a command line names; None for "-" (stdin). Forgives a missing .stick.yaml."""
    if arg == "-":
        return None
    p = Path(arg)
    if p.is_dir():
        found = sorted(str(f) for f in p.glob("*.stick.y*ml"))
        hint = f" — name a scene file in it, e.g. {', '.join(found[:4])}" if found else " (it has no *.stick.yaml files)"
        raise Fail(f"{arg} is a folder{hint}", EXIT_SCENE, kind="not-a-file", got=arg, suggest=found[:4])
    if p.is_file():
        return p
    for alt in (p.with_name(p.name + ".stick.yaml"), p.with_name(p.name + ".stick.yml")):
        if alt.is_file():
            return alt
    folder = p.parent if p.parent.is_dir() else None
    names = [f.name for f in folder.glob("*.stick.y*ml")] if folder else []
    close = [str(p.parent / n) for n in registry.close_matches(p.name, names)]
    raise Fail(f"file not found: {arg}" + (f" — did you mean {', '.join(close)}?" if close else ""), EXIT_SCENE, kind="file-not-found",
               got=arg, suggest=close)


def _error_items(e) -> list[dict]:
    """SceneError / SceneErrors -> [{message, where, line, col, code, got, suggest}] (fields that are known)."""
    out = []
    for x in getattr(e, "errors", None) or [e]:
        d: dict = {}
        if hasattr(x, "to_dict"):
            try:
                d = {k: v for k, v in x.to_dict().items() if v is not None}
            except Exception:  # noqa: BLE001
                d = {}
        msg = str(d.get("message") or x)
        d["message"] = msg
        m = _WHERE_RX.match(msg)
        if m and "where" not in d:
            d["where"] = m.group(1)
        if m and m.group(2) and "line" not in d:
            d["line"] = int(m.group(2))
        if "line" not in d:
            m2 = re.search(r"line (\d+), column (\d+)", msg)
            if m2:
                d["line"], d["col"] = int(m2.group(1)), int(m2.group(2))
        d.setdefault("code", "yaml-syntax" if "YAML syntax error" in msg else "scene")
        out.append(d)
    return out


def _scene_fail(e, arg: str) -> Fail:
    items = _error_items(e)
    message = items[0]["message"] if len(items) == 1 else f"{arg}: {len(items)} problems"
    # a name may be unknown because the plugin that defines it did not load: say so next to the error
    for pe in registry.PLUGIN_ERRORS:
        if any(pe["file"] in i["message"] for i in items):
            continue
        item = {"message": f'{pe["file"]} failed to load: {pe["error"]} — fix it first', "code": "plugin-load", "where": pe["file"]}
        if pe.get("line"):
            item["line"] = pe["line"]
        items.append(item)
    if len(items) > 1 and message == items[0]["message"]:
        message = f"{message}  (+{len(items) - 1} more)"
    return Fail(message, EXIT_SCENE, errors=items)


def _plugin_location(e: BaseException) -> str | None:
    """'plugins/stickman/x.py line 12' when the exception came out of a project or pack plugin.
    The renderer and the scene wrap a plugin's exception in their own (RenderError, SceneError —
    `raise … from None` still keeps it as __context__), so the whole chain is searched."""
    seen: set[int] = set()
    x: BaseException | None = e
    while x is not None and id(x) not in seen:
        seen.add(id(x))
        loc = None
        tb = x.__traceback__
        while tb is not None:
            name = str(tb.tb_frame.f_globals.get("__name__", ""))
            if name.startswith("studio_stickman_plugin_"):
                path = Path(tb.tb_frame.f_code.co_filename)
                try:
                    rel = path.resolve().relative_to(registry.project_dir().resolve()).as_posix()
                except ValueError:
                    rel = str(path)
                loc = f"{rel} line {tb.tb_lineno}"
            tb = tb.tb_next
        if loc:
            return loc
        x = x.__cause__ or x.__context__
    return None


def _draw_fail(e: BaseException, what: str = "drawing failed", where: str | None = None) -> Fail:
    """A frame could not be drawn: the renderer's RenderError (a plugin prop, backdrop or particle that
    raised, a worker that died, ffmpeg) or a SceneError found while drawing. That is a problem of the
    scene or of a plugin (exit 1) — or of ffmpeg (exit 4) — never "an internal error, please report it"."""
    from .scene import SceneError

    if isinstance(e, SceneError):
        return _scene_fail(e, where or "drawing")
    msg = str(e)
    loc = _plugin_location(e)
    if loc and loc not in msg:
        msg += f" (in {loc})"
    code = EXIT_ENV if msg.startswith("ffmpeg") else EXIT_SCENE
    item: dict = {"message": f"{what}: {msg}", "code": "render-failed"}
    m = re.fullmatch(r"(.+) line (\d+)", loc or "")
    if m:
        item["where"], item["line"] = m.group(1), int(m.group(2))
    elif where:
        item["where"] = where
    return Fail(item["message"], code, errors=[item])


def _load(args, arg: str | None = None):
    from .scene import SceneError, load_scene, load_scene_text

    arg = arg if arg is not None else args.scene
    path = _scene_file(arg)
    stdin_path = Path.cwd() / "stdin.stick.yaml"
    registry.use_scene(path or stdin_path)
    try:
        with _Quiet():
            if path is None:
                if "-" not in _STDIN_TEXT:
                    _STDIN_TEXT["-"] = sys.stdin.buffer.read().decode("utf-8-sig") if sys.stdin else ""
                return load_scene_text(_STDIN_TEXT["-"], stdin_path)
            return load_scene(path)
    except SceneError as e:
        raise _scene_fail(e, arg) from None
    except OSError as e:
        raise Fail(f"cannot read {arg}: {e.strerror or e}", EXIT_ENV, kind="read") from None
    except (ValueError, TypeError, KeyError, IndexError) as e:
        # a value of the wrong type that the loader did not catch itself: still a problem of the scene
        loc = _plugin_location(e)
        raise Fail(f"{arg}: {type(e).__name__}: {e}" + (f" (in {loc})" if loc else " — a value in the scene has the wrong type"),
                   EXIT_SCENE, kind="invalid-value") from None


def _name(args, scene=None) -> str:
    if getattr(args, "name", None):
        return str(args.name)
    arg = getattr(args, "scene", None) or "scene"
    if arg == "-":
        return "stdin"
    return Path(arg).name.split(".")[0] or "scene"


def _is_num(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def _time(scene, v, where: str) -> float:
    from .scene import SceneError

    try:
        return float(scene.clock.at(float(v) if _is_num(v) else str(v).strip(), 0.0, where))
    except SceneError as e:
        raise Fail(str(e), EXIT_USAGE, kind="bad-time", got=str(v), where=where) from None


def _clamped(scene, v, where: str, notes: _Notes) -> float:
    """A time inside the scene; one outside is moved to the start / end, with a warning."""
    t = _time(scene, v, where)
    if t < 0 or t > scene.duration + 1e-9:
        c = min(max(0.0, t), scene.duration)
        notes.add(f"clamped {where} {v} to {c:g}s ({'the start' if t < 0 else 'the end'} of the scene)", "clamped", where=where)
        return c
    return t


def _range(args, scene, notes: _Notes) -> tuple[float, float]:
    """--from / --to as seconds. Nonsense (an empty or reversed range, a start after the end) is an
    error: silently rendering one frame of the wrong moment helps nobody."""
    dur = scene.duration
    f, to = getattr(args, "from_t", None), getattr(args, "to_t", None)
    t0 = _time(scene, f, "--from") if f is not None else 0.0
    t1 = _time(scene, to, "--to") if to is not None else dur
    if t0 < 0:
        raise Fail(f"--from {f} is before the start (times start at 0)", EXIT_USAGE, kind="range", got=f)
    if t0 >= dur - 1e-6:
        raise Fail(f"--from {f} is at or after the end of the scene ({dur:g}s)", EXIT_USAGE, kind="range", got=f)
    if t1 <= t0 + 1e-6:
        raise Fail(f"--to {to} must be after --from {f if f is not None else 0} ({t1:g}s is not after {t0:g}s)", EXIT_USAGE, kind="range", got=to)
    if t1 > dur + 1e-6:
        notes.add(f"clamped --to {to} to {dur:g}s (the end of the scene)", "clamped", where="--to")
        t1 = dur
    return t0, t1


def _accepts(fn, name: str) -> bool:
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def _keep_previous(png: Path) -> Path | None:
    """Keep the picture an earlier run wrote as <name>.prev.png: an agent can compare before / after."""
    if not png.is_file():
        return None
    prev = png.with_name(png.stem + ".prev" + png.suffix)
    try:
        os.replace(png, prev)
    except OSError:
        return None
    return prev


def _sheet_path(args, scene, selection: str = "", focus: str | None = None) -> Path:
    """One naming for `sheet` and `render --preview`: the selection is part of the name, so a sheet of
    3-6 s does not replace the one of the whole scene."""
    tag = re.sub(r"[^0-9A-Za-z_.:+-]", "_", selection + (f"-{focus}" if focus else "")).replace(":", "_")
    return registry.project_dir() / ".studio" / "previews" / f"{_name(args, scene)}-sheet{tag}.png"


def _writable(folder: Path) -> None:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=folder, prefix=".write-test-", delete=True):
            pass
    except OSError as e:
        raise Fail(f"cannot write to {folder}: {e.strerror or e}", EXIT_ENV, kind="not-writable") from None


# ---------------------------------------------------------------------------
# ffmpeg and the environment
# ---------------------------------------------------------------------------
_PATH_NOTE: list[str] = []


def _repair_windows_path() -> None:
    """Git Bash splits PATH="C:/tools/bin:$PATH" at the colon of the drive: Windows programs then see
    the entries "C" and "<Git folder>\\tools\\bin", and an ffmpeg in C:/tools/bin is not found. Join such
    pairs again (only when the joined folder exists) and remember it for `doctor`."""
    if os.name != "nt":
        return
    parts = os.environ.get("PATH", "").split(os.pathsep)
    roots = [p[: -len("\\usr\\bin")] for p in parts if p.lower().endswith("\\usr\\bin")]
    out: list[str] = []
    i = 0
    while i < len(parts):
        p = parts[i]
        joined = None
        if len(p) == 1 and p.isalpha() and i + 1 < len(parts):
            nxt = parts[i + 1]
            for root in roots:
                if nxt.lower().startswith(root.lower() + "\\"):
                    cand = p + ":\\" + nxt[len(root) + 1:]
                    if os.path.isdir(cand):
                        joined = cand
                        break
        if joined:
            out.append(joined)
            _PATH_NOTE.append(joined)
            i += 2
        else:
            out.append(p)
            i += 1
    if _PATH_NOTE:
        os.environ["PATH"] = os.pathsep.join(out)


_FFMPEG: dict = {}


def _ffmpeg_list(what: str) -> set[str] | None:
    """Encoders or filters of the ffmpeg on PATH (None: could not ask it)."""
    if what not in _FFMPEG:
        exe = shutil.which("ffmpeg")
        names = None
        if exe:
            try:
                r = subprocess.run([exe, "-hide_banner", f"-{what}"], capture_output=True, text=True, timeout=30)
                # lines like " V....D libx264  …" (encoders) or " .. palettegen  V->V …" (filters)
                found = set(re.findall(r"^\s*[A-Z.|]{2,6}\s+([\w-]+)\s", r.stdout, re.M))
                names = found if len(found) >= 10 else None       # an output we do not understand: do not guess
            except (OSError, subprocess.SubprocessError):
                names = None
        _FFMPEG[what] = names
    return _FFMPEG[what]


def _need_ffmpeg(*, gif: bool, webm: bool, audio: bool) -> None:
    """Fail in a fraction of a second, before sound and frames are made, when the video cannot be written."""
    exe = shutil.which("ffmpeg")
    if not exe:
        hint = ""
        if os.name == "nt" and any(len(p) == 1 for p in os.environ.get("PATH", "").split(os.pathsep)):
            hint = " (in Git Bash write PATH entries as /c/… — \"C:/…\" is split at the colon)"
        raise Fail("ffmpeg is not installed or not on PATH — the video cannot be written" + hint +
                   "; pictures work without it (sheet, still, sprite). Run: studio-stickman doctor", EXIT_ENV, kind="ffmpeg-missing")
    enc = _ffmpeg_list("encoders")
    if enc is not None:
        need = ["libx264"] + (["aac"] if audio else []) + (["libvpx-vp9"] if webm else []) + (["libopus"] if webm and audio else [])
        missing = [e for e in need if e not in enc]
        if missing:
            raise Fail(f"the ffmpeg at {exe} has no {', '.join(missing)} encoder" + ("" if not webm else " (needed for --webm)") +
                       " — install a full ffmpeg build. Run: studio-stickman doctor", EXIT_ENV, kind="encoder-missing", got=missing)
    if gif:
        flt = _ffmpeg_list("filters")
        if flt is not None and not {"palettegen", "paletteuse"} <= flt:
            raise Fail(f"the ffmpeg at {exe} has no palettegen/paletteuse filter (needed for --gif). Run: studio-stickman doctor", EXIT_ENV,
                       kind="filter-missing")


class Progress:
    """Signs of life on stderr while a render runs: without them an agent cannot tell a slow render
    from a hung one (and its command may run into a timeout without a word)."""

    def __init__(self, mode: str):
        self.mode = mode                   # none | text | json
        self.t0 = time.time()
        self.phase_t = self.t0
        self.last = -1e9
        self.reported = -1
        self.first: tuple[float, int] | None = None

    def _put(self, data: dict, text: str) -> None:
        if self.mode == "json":
            print(json.dumps({**data, "elapsed_s": round(time.time() - self.t0, 1)}), file=sys.stderr, flush=True)
        elif self.mode == "text":
            print(text, file=sys.stderr, flush=True)

    def phase(self, name: str, text: str, **info) -> None:
        if self.mode == "none":
            return
        self.phase_t = time.time()
        if text or self.mode == "json":
            self._put({"phase": name, **info}, f"  {text}")

    def frames(self, done: int, of: int) -> None:
        now = time.time()
        if self.mode == "none" or done == self.reported:
            return
        if self.first is None:
            # the first frame also pays for starting the workers: the speed is measured from here on
            self.first = (now, done)
            if done < of:
                return
        if done < of and now - self.last < 1.0:
            return
        self.last, self.reported = now, done
        t_first, d_first = self.first
        rate = (done - d_first) / (now - t_first) if done > d_first and now > t_first else done / max(1e-6, now - self.phase_t)
        eta = (of - done) / rate if rate > 0 else None
        tail = f", ~{eta:.0f} s left)" if done < of and eta is not None else ")"
        self._put({"phase": "frames", "done": done, "of": of, "fps": round(rate, 1), "eta_s": None if eta is None else round(eta, 1)},
                  f"  frames {done}/{of} ({100 * done // max(1, of)}%, {rate:.1f} fps{tail}")


def _progress_mode(args) -> str:
    mode = getattr(args, "progress", None) or "auto"
    if mode == "auto":
        return "json" if getattr(args, "json", False) else "text"
    return mode


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_new(args):
    path = Path(args.file)
    if not path.name.endswith((".stick.yaml", ".stick.yml")):
        path = path.with_name(path.name.split(".")[0] + ".stick.yaml")
    if path.exists() and not args.force:
        raise Fail(f"{path} exists (use --force to overwrite)", EXIT_SCENE, kind="exists")
    title = path.name.split(".")[0].replace("-", " ").replace("_", " ").title() or "Scene"
    # json.dumps gives a quoted YAML string: a scene called yes, 1e3, [draft] or "a: b" keeps its title
    text = SCENES[args.template].replace("{{TITLE_YAML}}", json.dumps(title, ensure_ascii=False)).replace("{{TITLE}}", title)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8")
    _emit(args, {"ok": True, "file": str(path), "template": args.template, "files": {"scene": str(path)}},
          f"Created {path} — look at it first: studio-stickman sheet {path}   then: studio-stickman render {path} --draft")


def _summary(scene, notes: _Notes) -> dict:
    return {
        "ok": True,
        "title": scene.title,
        "seconds": scene.duration,
        "fps": scene.fps,
        "size": [scene.w, scene.h],
        "bpm": scene.clock.bpm,
        "figures": {f.name: {"keys": len(f.raw), "x": [round(min(k.x for k in f.keys)), round(max(k.x for k in f.keys))]} for f in scene.figures.values()},
        "props": len(scene.props),
        "events": len(scene.events),
        "warnings": notes.text,
        "warning_items": notes.items,
    }


def _fx_at(fig, t: float) -> str:
    """'fx "wobble" (project:plugins/stickman/wobble.py) ' — the motions a figure runs at t."""
    import bisect

    try:
        i = max(0, bisect.bisect_right(fig.times, t) - 1)
        names = [n for n, _ in fig.keys[i].fx]
    except Exception:  # noqa: BLE001
        return ""
    if not names:
        return ""
    srcs = [f'"{n}" ({registry.MOTIONS[n].source})' if n in registry.MOTIONS else f'"{n}"' for n in names]
    return "fx " + ", ".join(srcs) + " "


PROBE_MAX = 3000          # samples per figure / plugin prop in `check`: every frame up to 100 s at 30 fps


def _frame_times(scene) -> list[float]:
    """The times a full render draws (one per frame; beyond PROBE_MAX frames evenly spread), and the end."""
    dur, fps = scene.duration, scene.fps
    n = max(1, int(round(dur * fps)))
    ts = [i / fps for i in range(n)] if n <= PROBE_MAX else [dur * i / PROBE_MAX for i in range(PROBE_MAX)]
    return ts + [dur]


def _plugin_fx(f) -> list[str]:
    """The fx of a figure that come from plugins (a project or pack): they run on every frame."""
    names = set()
    for k in getattr(f, "keys", None) or []:
        for n, _ in list(getattr(k, "fx", None) or []) + list(getattr(k, "nfx", None) or []):
            names.add(str(n))
    if getattr(f, "talk_spans", None):
        names.add("talk")                  # speaking figures gesture with `talk` (a plugin may replace it)
    return sorted(n for n in names if n in registry.MOTIONS and registry.MOTIONS[n].source != "built-in")


def _key_times(f, dur: float) -> list[float]:
    """Every key of a figure: each key's values and fx are evaluated once (enough for built-in motion:
    the loader already ran every fx once with its parameters, so a crash between keys is a tool bug)."""
    ts = {min(max(0.0, float(t)), dur) for t in (getattr(f, "times", None) or [k.t for k in f.keys])}
    return sorted(ts | {0.0, dur})


class _ProbeFail(Exception):
    def __init__(self, fail: Fail):
        super().__init__(fail.message)
        self.fail = fail


def _probe_plugin_drawing(scene, r, frames: list[float]) -> None:
    """Plugin props and particles may fail only at some times (`if t > 2: …`): call them at every frame
    time they are drawn, on the probe's small canvas, without drawing the rest of the frame."""
    from PIL import Image

    from .draw import Canvas

    img = Image.new("RGBA", r.size, (0, 0, 0, 0))
    for p in scene.props:
        e = registry.PROPS.get(p.kind)
        if e is None or e.source == "built-in":
            continue
        for t in frames:
            if not (p.t_from <= t < p.t_to):
                continue
            c = Canvas(img, r.view(t))
            try:
                if p.held_by:
                    hold = float(p.params.get("hold_angle", 0)) + float(getattr(p, "angle", 0) or 0)
                    cc = c.at((0.0, 0.0), scale=p.scale).at((0, 0), angle=-hold)
                else:
                    x, y, rot = p.at(t)
                    cc = c.at((x, y), angle=rot, flip=p.flip, scale=p.scale)
                e.fn(cc, p.params, t)
            except Exception as ex:  # noqa: BLE001
                loc = _plugin_location(ex)
                raise _ProbeFail(Fail(f'drawing failed at {t:.2f}s: prop "{p.name}" ({p.kind}, {e.source}) failed: {type(ex).__name__}: {ex}'
                                      + (f" (in {loc})" if loc else ""), EXIT_SCENE, kind="draw-failed", where=f"props.{p.name}")) from None
    draw_particles = getattr(r, "_particles", None)
    for b in list(getattr(r, "bursts", None) or []):
        e = registry.PARTICLES.get(str(b.get("name")))
        if draw_particles is None or e is None or e.source == "built-in":
            continue
        t0, t1 = float(b["t"]), float(b["t"]) + float(b.get("life") or 1.0) * 1.05
        for t in frames:
            if t0 <= t <= t1:
                try:
                    draw_particles(Canvas(img, r.view(t)), t)
                except Exception as ex:  # noqa: BLE001
                    loc = _plugin_location(ex)
                    raise _ProbeFail(Fail(f"drawing failed at {t:.2f}s: {ex}" + (f" (in {loc})" if loc else ""), EXIT_SCENE, kind="draw-failed")) from None


def _probe(scene, notes: _Notes) -> None:
    """What only shows when a scene is played.
    - Figures: one whose keys use a plugin fx is evaluated at every frame time a render uses (at most
      PROBE_MAX per figure, about 45 ms); the others at every key (plugin actions already ran while
      loading, and the loader ran every fx once with its parameters: built-in fx crash only on a tool bug).
    - Drawing: two small frames (scenery, figures, props, texts), and every plugin prop and plugin
      particle at every frame time it is drawn, on its own (a prop that fails only at 3 s fails here too).
    About 10–60 ms for a typical scene."""
    from . import render as R
    from .scene import SceneError

    dur = scene.duration
    frames = _frame_times(scene)
    for f in scene.figures.values():
        dense = _plugin_fx(f)
        for t in (frames if dense else _key_times(f, dur)):
            try:
                f.joints(t)
            except SceneError as e:
                fail = _scene_fail(e, f"figures.{f.name}")
                loc = _plugin_location(e)
                if loc and loc not in fail.message:       # the line of the plugin fx that raised
                    fail.message += f" (in {loc})"
                    fail.errors[0]["message"] = str(fail.errors[0].get("message", "")) + f" (in {loc})"
                raise fail from None
            except Exception as e:  # noqa: BLE001
                loc = _plugin_location(e)
                raise Fail(f"figures.{f.name} at {t:.2f}s: {_fx_at(f, t)}failed: {type(e).__name__}: {e}" + (f" (in {loc})" if loc else ""),
                           EXIT_SCENE, kind="motion-failed", where=f"figures.{f.name}") from None
    later = [e["t"] + 0.05 for e in scene.events if e["kind"] in ("say", "text", "title", "caption", "hit") and e["t"] < dur]
    times = [dur * 0.5, min(later[0], dur) if later else dur * 0.2]
    t: float | None = times[0]
    try:
        with _Quiet():
            r = R.Renderer(scene, ss=1, scale=0.25)
            for t in times:
                r.frame(t)
            t = None
            _probe_plugin_drawing(scene, r, frames)
    except SceneError as e:
        raise _scene_fail(e, "drawing") from None
    except _ProbeFail as e:
        raise e.fail from None
    except Exception as e:  # noqa: BLE001
        loc = _plugin_location(e)
        at = f" at {t:.2f}s" if t is not None else ""
        raise Fail(f"drawing failed{at}: {type(e).__name__}: {e}" + (f" (in {loc})" if loc else ""), EXIT_SCENE, kind="draw-failed") from None
    try:
        from . import sfx

        check_audio = getattr(sfx, "validate_audio", None)
        if check_audio:
            notes.add_scene_strings(check_audio(scene))
    except Exception as e:  # noqa: BLE001  (sound checks warn, they never stop a check)
        notes.add(f"audio: could not be checked: {type(e).__name__}: {e}", "audio")
    try:
        # words with letters the fonts cannot draw (they would show as boxes)
        check_text = getattr(R, "validate_text", None)
        if check_text:
            notes.add_scene_strings(check_text(scene))
    except Exception as e:  # noqa: BLE001
        notes.add(f"text: could not be checked: {type(e).__name__}: {e}", "text")


def _check_one(args, arg: str) -> tuple[dict, str]:
    scene = _load(args, arg)
    notes = _Notes(scene)
    _probe(scene, notes)
    data = {**_summary(scene, notes), "file": arg}
    lines = [f"OK — {scene.title}: {scene.duration:g}s at {scene.fps} fps, {len(scene.figures)} figure(s), {len(scene.events)} event(s)"]
    lines += notes.lines()
    return data, "\n".join(lines)


def cmd_check(args):
    results: list[tuple[dict, str]] = []
    worst = 0
    for arg in args.scenes:
        try:
            results.append(_check_one(args, arg))
        except Fail as f:
            if len(args.scenes) == 1:
                raise
            worst = max(worst, f.code)
            results.append(({"ok": False, "file": arg, "error": f.error_text, "errors": f.errors, "exit": f.code},
                            f"FAIL {arg}: " + "\n  ".join(str(e.get("message")) for e in f.errors)))
    warned = [d for d, _ in results if d.get("ok") and d.get("warnings")]
    strict = bool(args.strict and warned)
    if len(results) == 1:
        data, text = results[0]
        if strict:
            data["strict"] = "failed"
            data["exit"] = EXIT_STRICT
        _emit(args, data, text)
        if strict and not args.json:
            print(f"studio-stickman: --strict: {len(data['warnings'])} warning(s)", file=sys.stderr)
        return EXIT_STRICT if strict else 0
    code = worst or (EXIT_STRICT if strict else 0)
    lines = [(f"OK   {d['file']}: " + t.split("\n", 1)[0][5:] + "".join(f"\n  {w}" for w in t.split("\n")[1:])) if d.get("ok") else t
             for d, t in results]
    data: dict = {"ok": not worst, "scenes": [d for d, _ in results], "exit": code, **({"strict": "failed"} if strict else {})}
    failed = [d for d, _ in results if not d.get("ok")]
    if failed:
        # the same failure fields as a single scene has: every problem, with the file it is in
        data["error"] = "\n".join(f"{d['file']}: {e.get('message')}" for d in failed for e in d["errors"])
        data["errors"] = [{**e, "file": d["file"]} for d in failed for e in d["errors"]]
    _emit(args, data, "\n".join(lines))
    return code


# --- info / at: the timeline as text ------------------------------------------------------------
def _raw_scene(scene) -> dict:
    """The scene file as written (for the parameters of each timeline item)."""
    import yaml

    try:
        from .scene import _Loader as loader
    except ImportError:
        loader = yaml.SafeLoader
    try:
        text = _STDIN_TEXT["-"] if scene.path.name == "stdin.stick.yaml" and "-" in _STDIN_TEXT else Path(scene.path).read_text("utf-8")
        data = yaml.load(text, Loader=loader) or {}
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _script_items(scene) -> list[tuple[dict, str | None, dict]]:
    """scene.script with the YAML path of each item and its parameters as written."""
    from .scene import EVENT_KINDS

    raw = _raw_scene(scene)
    by_where: dict[str, dict] = {}
    per_fig: dict[str, list[str]] = {}
    for name, items in ((raw.get("timeline") or {}) if isinstance(raw.get("timeline"), dict) else {}).items():
        lst = per_fig.setdefault(str(name), [])
        for i, it in enumerate(items if isinstance(items, list) else []):
            if not isinstance(it, dict):
                continue
            # the same rule as Scene._timeline: an item makes a script line when something is left
            # after its time and the events written next to it
            rest = {k: v for k, v in it.items() if k != "t" and (k not in EVENT_KINDS or k == "hit") and not (k == "say_dur" and "say" in it)}
            if "do" in it or rest:
                where = f"timeline.{name}[{i}]"
                lst.append(where)
                by_where[where] = rest
    out, seen = [], {}
    for it in scene.script:
        where = it.get("where")
        if where is None:
            i = seen.get(it["who"], 0)
            seen[it["who"]] = i + 1
            lst = per_fig.get(str(it["who"]), [])
            where = lst[i] if i < len(lst) else None
        params = dict(by_where.get(where) or {}) if where else {}
        out.append((it, where, params))
    return out


def _who_of(where: str | None) -> str | None:
    m = re.match(r"^timeline\.([^\[]+)\[", where or "")
    return m.group(1) if m else None


def _hit_text(ev: dict) -> str:
    v = ev["value"]
    target = f'{v.get("on")} ({v.get("part", "chest")})' if isinstance(v, dict) else f"at {v}"
    return f"hit → {target}" + (f'  "{ev["word"]}"' if ev.get("word") else "")


def _timeline_rows(scene) -> list[dict]:
    rows: list[dict] = []
    for f in scene.figures.values():
        k = f.raw[0]
        face = "right" if k.get("face", 1) > 0 else "left"
        rows.append({"t": 0.0, "end": 0.0, "who": f.name, "kind": "start", "pose": k.get("pose"), "x": k["x"], "face": face, "where": f"figures.{f.name}",
                     "what": f"starts: pose {k.get('pose')} at x {k['x']:g}, facing {face}"})
    hits: dict[str, list[dict]] = {}
    for ev in scene.events:
        if ev["kind"] == "hit":
            hits.setdefault(ev["_where"], []).append(ev)
    for it, where, params in _script_items(scene):
        what = str(it["what"])
        row = {"t": it["t"], "end": it["end"], "who": it["who"], "what": what, "where": where}
        if what.startswith("do "):
            row["kind"] = "action"
            row["name"] = str(params.pop("do", what.split()[1] if len(what.split()) > 1 else ""))
        else:
            row["kind"] = "key"
            if "pose" in params:
                row["name"] = str(params["pose"])
        row["params"] = {k: v for k, v in params.items() if k not in ("do",)}
        impacts = [round(h["t"], 3) for h in hits.get(where or "", [])]
        if impacts:
            row["impacts"] = impacts
        rows.append(row)
    for ev in scene.events:
        v = ev["value"]
        from_tl = ev["_where"].startswith("timeline.")
        if ev["kind"] == "hit":
            rows.append({"t": ev["t"], "end": ev["t"], "who": _who_of(ev["_where"]) or "·", "kind": "hit", "what": _hit_text(ev), "where": ev["_where"],
                         "target": v.get("on") if isinstance(v, dict) else None, "part": v.get("part", "chest") if isinstance(v, dict) else None})
            continue
        if from_tl and ev["kind"] not in ("say", "text", "title", "caption"):
            continue                      # sounds and effects an action added by itself
        who = "·" if ev["kind"] != "say" or not ev.get("who") else str(ev["who"])
        word = ev.get("word") or (v if not isinstance(v, (dict, list)) else json.dumps(v))
        rows.append({"t": ev["t"], "end": ev["t"], "who": who, "kind": ev["kind"], "what": f"{ev['kind']}: {word}", "where": ev["_where"]})
    for i, c in enumerate(scene.camera):
        what = f"zoom {c.zoom:g}" + (f", follows {c.follow}" if c.follow else "") + (f", at {c.x:g}/{c.y:g}" if c.x is not None and c.y is not None else "")
        rows.append({"t": c.t, "end": c.t, "who": "camera", "kind": "camera", "what": what, "where": f"camera[{i}]"})
    rows.sort(key=lambda r: r["t"])
    for r in rows:
        r["t"], r["end"] = round(r["t"], 3), round(r["end"], 3)
        line = _line_of(scene, r.get("where"))
        if line:
            r["line"] = line
        if r.get("where") is None:
            r.pop("where", None)
    return rows


def cmd_info(args):
    scene = _load(args)
    notes = _Notes(scene)
    rows = _timeline_rows(scene)
    lines = [f"{scene.title} — {scene.duration:g}s, {scene.fps} fps, {scene.w}×{scene.h}" + (f", {scene.clock.bpm:g} bpm" if scene.clock.bpm else "")]
    for r in rows:
        span = scene.clock.label(r["t"]) + (f" → {r['end']:.2f}s" if r["end"] - r["t"] > 0.01 else "")
        extra = ("   lands " + ", ".join(f"{t:.2f}s" for t in r["impacts"])) if r.get("impacts") else ""
        mark = "⚡ " if r["kind"] == "hit" else ""
        lines.append(f"  {span:<28} {r['who']:<10} {mark}{r['what']}{extra}")
    lines += notes.lines()
    _emit(args, {**_summary(scene, notes), "timeline": rows}, "\n".join(lines))


def _event_window(ev: dict) -> float:
    """How long an event can be seen or heard (the renderer's own defaults for open lengths)."""
    k, v = ev["kind"], str(ev["value"])
    if ev.get("dur"):
        return float(ev["dur"])
    return {"say": 0.9 + 0.055 * len(v), "caption": 1.0 + 0.06 * len(v), "hit": 0.25, "sfx": 0.3, "burst": float(ev.get("life") or 0.8)}.get(k, 0.5)


def _camera_at(scene, r, t: float) -> tuple[float, float, float]:
    """Where the camera of the rendered frame looks at t and its zoom: the renderer's own camera
    (smoothed follow, zoom punches, kept inside the scenery, zoomed in while shaking). Without a
    renderer (it could not be built): the camera keys as written."""
    if r is None:
        return scene.cam_at(t)
    m = r.view(t)
    kk = m[0]
    return (r.k * scene.w / 2 - m[4]) / kk, (r.k * scene.h / 2 - m[5]) / kk, kk / r.k


def _moment(scene, t: float, script: list, r=None) -> dict:
    cx, cy, zoom = _camera_at(scene, r, t)
    vw, vh = scene.w / zoom, scene.h / zoom
    view = [round(cx - vw / 2, 1), round(cy - vh / 2, 1), round(cx + vw / 2, 1), round(cy + vh / 2, 1)]
    figs = {}
    for f in scene.figures.values():
        st, P = f.joints(t)
        pts = {k: [round(P[k][0], 1), round(P[k][1], 1)] for k in ("head", "Rhand", "Lhand", "Rfoot", "Lfoot") if k in P}
        xs = [p[0] for p in pts.values()] or [st["x"]]
        ys = [p[1] for p in pts.values()] or [scene.floor]
        in_view = max(xs) >= view[0] and min(xs) <= view[2] and max(ys) >= view[1] and min(ys) <= view[3]
        last_pose, next_pose = None, None
        for k in sorted(f.raw, key=lambda k: k["t"]):
            if "pose" in k:
                if k["t"] <= t + 1e-9:
                    last_pose = {"pose": str(k["pose"]), "t": round(k["t"], 3)}
                elif next_pose is None:
                    next_pose = {"pose": str(k["pose"]), "t": round(k["t"], 3)}
        doing = None
        for it, where, _ in script:
            if it["who"] == f.name and it["t"] - 1e-9 <= t < max(it["end"], it["t"] + 1e-3):
                doing = {"what": it["what"], "t": round(it["t"], 3), "end": round(it["end"], 3), "where": where}
        figs[f.name] = {
            "x": round(st["x"], 1), "y": round(st["y"], 1), "rot": round(st["rot"], 1), "face": "right" if st["face"] > 0 else "left",
            "expr": st.get("expr"), "look": st.get("look"), "fx": st.get("fx") or [], "visible": bool(st.get("visible", True)),
            "pose": last_pose, "next_pose": next_pose, "doing": doing, "points": pts, "in_view": bool(in_view and st.get("visible", True)),
        }
    names = list(figs)
    gaps = {f"{a}-{b}": round(abs(figs[a]["x"] - figs[b]["x"]), 1) for i, a in enumerate(names) for b in names[i + 1:]}
    events = []
    for ev in scene.events:
        if ev["t"] - 1e-6 <= t < ev["t"] + _event_window(ev):
            v = ev["value"]
            d = {"kind": ev["kind"], "t": round(ev["t"], 3), "where": ev["_where"]}
            if ev["kind"] == "hit":
                d["text"] = _hit_text(ev)
            else:
                d["text"] = str(v) if not isinstance(v, (dict, list)) else json.dumps(v)
            if ev["kind"] == "say" and ev.get("who"):
                d["who"] = str(ev["who"])
            events.append(d)
    return {"t": round(t, 3), "label": scene.clock.label(t), "camera": {"x": round(cx, 1), "y": round(cy, 1), "zoom": round(zoom, 3), "view": view},
            "figures": figs, "gaps": gaps, "events": events}


def cmd_at(args):
    from . import render as R

    scene = _load(args)
    notes = _Notes(scene)
    script = _script_items(scene)
    times = [_clamped(scene, v, "time", notes) for v in args.times]
    try:
        with _Quiet():
            r = R.Renderer(scene, ss=1, scale=0.25)     # its camera is the one the frames are drawn with
    except Exception as e:  # noqa: BLE001
        r = None
        notes.add(f"camera: shown as written, not as drawn (the frame could not be set up: {e})", "camera")
    moments = [_moment(scene, t, script, r) for t in times]
    lines = []
    for m in moments:
        c = m["camera"]
        lines.append(f"{m['label']} — camera at {c['x']:g}, {c['y']:g}, zoom {c['zoom']:g} (sees x {c['view'][0]:g}…{c['view'][2]:g})")
        for name, f in m["figures"].items():
            pose = f["pose"]["pose"] + f" (since {f['pose']['t']:g}s)" if f["pose"] else "-"
            if f["next_pose"] and f["next_pose"]["t"] - m["t"] < 1.0:
                pose += f" → {f['next_pose']['pose']} at {f['next_pose']['t']:g}s"
            state = f"x {f['x']:g}" + (f" y {f['y']:g}" if abs(f["y"]) > 0.5 else "") + (f" rot {f['rot']:g}" if abs(f["rot"]) > 0.5 else "")
            seen = "in view" if f["in_view"] else ("HIDDEN" if not f["visible"] else "OUT OF VIEW")
            lines.append(f"  {name:<8} {state}  facing {f['face']}  pose {pose}  expr {f['expr']}  fx {'+'.join(f['fx']) or '-'}  {seen}")
            if f["doing"]:
                d = f["doing"]
                lines.append(f"           doing: {d['what']}  {d['t']:.2f}s → {d['end']:.2f}s" + (f"  [{d['where']}]" if d["where"] else ""))
            p = f["points"]
            if p:
                lines.append("           " + "  ".join(f"{k} {v[0]:g},{v[1]:g}" for k, v in p.items()))
        if m["gaps"]:
            lines.append("  gaps: " + ", ".join(f"{k.replace('-', ' ↔ ')} {v:g} px" for k, v in m["gaps"].items()))
        if m["events"]:
            lines.append("  events: " + " · ".join((e["text"] if e["kind"] == "hit" else f"{e['kind']} {e['text']}") + (f" ({e['who']})" if e.get("who") else "")
                                                   for e in m["events"]))
    lines += notes.lines()
    _emit(args, {"ok": True, "title": scene.title, "seconds": scene.duration, "moments": moments, "warnings": notes.text, "warning_items": notes.items},
          "\n".join(lines))


# --- render -------------------------------------------------------------------------------------
def _render_scale(args, scene) -> float:
    if args.scale is not None:
        scale = args.scale
    elif args.res:
        scale = RESOLUTIONS[args.res] / scene.h
    else:
        scale = 0.5 if args.draft else 1.0
    w, h = max(2, int(round(scene.w * scale / 2)) * 2), max(2, int(round(scene.h * scale / 2)) * 2)
    # 4K is the limit (as for scene.size): an 8K frame takes seconds to draw and a render would run for hours
    if max(w, h) > 3840 or w * h > 3840 * 2160:
        raise Fail(f"{w}×{h} is too large (at most 4K: 3840×2160 or 2160×3840) — use a smaller --scale or --res", EXIT_USAGE, kind="too-large")
    if min(w, h) < 32:
        raise Fail(f"{w}×{h} is too small (at least 32 px) — use a larger --scale", EXIT_USAGE, kind="too-small")
    return scale


def cmd_render(args):
    from . import render as R
    from .scene import SceneError
    from .sfx import AudioError, build_audio, write_wav

    scene = _load(args)
    t_start = time.time()
    notes = _Notes(scene)
    t0, t1 = _range(args, scene, notes)
    fps = args.fps or (15 if args.draft else scene.fps)
    scale = _render_scale(args, scene)
    ss = 1 if args.draft else 2
    # before minutes of sound and frames: is there an ffmpeg that can write all of it?
    _need_ffmpeg(gif=args.gif, webm=args.webm, audio=not args.no_audio)
    project = registry.project_dir()
    out_dir = Path(args.out) if args.out else project / "exports"
    _writable(out_dir)
    partial = t0 > 0 or t1 < scene.duration - 1e-6
    base = _name(args, scene) + (f"-{t0:g}-{t1:g}s" if partial else "")
    stem = base + (".draft" if args.draft else "")      # a draft never replaces the final export
    mp4 = out_dir / f"{stem}.mp4"
    prog = Progress(_progress_mode(args))
    files: dict[str, str] = {}
    audio_info: dict = {"sfx": 0, "music": None, "peak_db": None}
    n_frames = len(R.frame_times(t0, t1, fps))
    w, h = max(2, int(round(scene.w * scale / 2)) * 2), max(2, int(round(scene.h * scale / 2)) * 2)
    try:
        with _Quiet(), tempfile.TemporaryDirectory() as tmp:
            wav = None
            if not args.no_audio:
                prog.phase("audio", "sound effects and music …")
                try:
                    buf, audio_info = build_audio(scene, t0, t1)
                    if buf is not None:
                        wav = Path(tmp) / "audio.wav"
                        write_wav(wav, buf)
                except AudioError as e:
                    notes.add(f"no sound: {e}", "audio")
                except Exception as e:  # noqa: BLE001
                    notes.add(f"no sound: {type(e).__name__}: {e}", "audio")
                notes.add_scene_strings((audio_info or {}).get("warnings"))
            prog.phase("frames", f"rendering {n_frames} frames, {w}×{h} at {fps} fps …", of=n_frames, size=[w, h], fps=fps)
            # the PNG sequence, GIF and WebM come out of the same pass as the MP4 when the renderer can do
            # that (frames rendered once, formats made from the frames instead of the lossy MP4)
            extra: dict = {}
            fdir = out_dir / f"{stem}-frames" if args.frames else None
            gif, webm = out_dir / f"{stem}.gif", out_dir / f"{stem}.webm"
            if fdir:
                fdir.mkdir(parents=True, exist_ok=True)
                if _accepts(R.render_video, "frames_dir"):
                    extra["frames_dir"] = fdir
            if args.gif and _accepts(R.render_video, "gif"):
                extra["gif"] = gif
            if args.webm and _accepts(R.render_video, "webm"):
                extra["webm"] = webm
            info = R.render_video(scene, mp4, t0=t0, t1=t1, fps=fps, scale=scale, ss=ss, jobs=args.jobs or R.default_jobs(), audio_wav=wav,
                                  crf=26 if args.draft else 18, progress=lambda i, n: prog.frames(min(i + 1, n), n), **extra)
            prog.frames(info["frames"], info["frames"])
            for w in info.get("warnings") or []:
                warnings.append(str(w))
            files["mp4"] = str(mp4)
            if args.gif:
                if "gif" not in extra:            # an older renderer: made from the MP4 afterwards
                    prog.phase("gif", "encoding GIF …")
                    R.convert(mp4, gif, "gif", fps, info["width"])
                files["gif"] = str(gif)
            if args.webm:
                if "webm" not in extra:
                    prog.phase("webm", "encoding WebM …")
                    R.convert(mp4, webm, "webm", fps, info["width"])
                files["webm"] = str(webm)
            if fdir:
                if "frames_dir" not in extra:     # an older renderer: a second, serial pass
                    prog.phase("png", f"writing {n_frames} PNG frames …")
                    r = R.Renderer(scene, ss=ss, scale=scale)
                    for i, t in enumerate(R.frame_times(t0, t1, fps)):
                        r.frame(t).save(str(fdir / f"{i:05d}.png"))
                files["frames"] = str(fdir)
            if args.preview:
                prog.phase("preview", "contact sheet …")
                png = _sheet_path(args, scene, f"-{t0:g}-{t1:g}s" if partial else "")
                prev = _keep_previous(png)
                R.contact_sheet(scene, R.key_moments(scene, t0, t1, 12), png)
                files["preview"] = str(png)
                if prev:
                    files["previous_preview"] = str(prev)
    except SceneError as e:
        raise _scene_fail(e, args.scene) from None
    except R.RenderError as e:
        raise _draw_fail(e, "render failed") from None
    except OSError as e:
        raise Fail(f"render failed: {e}", EXIT_ENV, kind="io") from None
    prog.phase("done", "", seconds=round(time.time() - t_start, 1))
    report = {
        "ok": True, "files": files, "seconds": round(t1 - t0, 3), "frames": info["frames"], "fps": fps, "size": [info["width"], info["height"]],
        "scale": round(scale, 4), "jobs": info.get("jobs"), "figures": list(scene.figures), "events": len(scene.events), "audio": audio_info, "draft": bool(args.draft),
        "warnings": notes.text, "warning_items": notes.items, "render_seconds": round(time.time() - t_start, 1),
    }
    lines = [f"Rendered {scene.title}: {report['seconds']}s, {info['frames']} frames at {fps} fps, {info['width']}×{info['height']} ({report['render_seconds']}s)"]
    lines += [f"  {k}: {v}" for k, v in files.items()]
    if audio_info.get("sfx") or audio_info.get("music"):
        lines.append(f"  sound: {audio_info.get('sfx', 0)} effect(s)" + (f", music {audio_info['music']['file']}" if audio_info.get("music") else ""))
    else:
        lines.append("  sound: none")
    if args.draft:
        lines.append(f"  draft ({info['width']}×{info['height']}, {fps} fps) — not the final export; that one: studio-stickman render {args.scene}")
    lines += notes.lines()
    if args.preview:
        lines.append(f"Look at the contact sheet: read {files['preview']}")
    _emit(args, report, "\n".join(lines))


# --- pictures -----------------------------------------------------------------------------------
def _step_times(scene, t0: float, t1: float, step: str) -> list[float]:
    """--step 1f (every frame), 2f, 0.05 (seconds) or 1b (beats): a frame-exact strip from --from to --to."""
    from .scene import SceneError

    s = str(step).strip().lower()
    m = re.fullmatch(r"([0-9]+)\s*f", s)
    if m:
        n = int(m.group(1))
        if n < 1:
            raise Fail("--step must be at least 1f", EXIT_USAGE, kind="bad-step")
        i0, i1 = math.ceil(t0 * scene.fps - 1e-6), math.floor(t1 * scene.fps + 1e-6)
        times = [i / scene.fps for i in range(i0, i1 + 1, n)]
    else:
        try:
            dt = scene.clock.span(s, "--step")
        except SceneError as e:
            raise Fail(f"{e} — or frames: --step 1f", EXIT_USAGE, kind="bad-step") from None
        if dt <= 0:
            raise Fail("--step must be longer than 0", EXIT_USAGE, kind="bad-step")
        times = [t0 + k * dt for k in range(int((t1 - t0) / dt + 1e-6) + 1)]
    times = [t for t in times if t <= scene.duration + 1e-9]
    if len(times) > MAX_SHEET:
        raise Fail(f"--step {step} from {t0:g}s to {t1:g}s gives {len(times)} frames (at most {MAX_SHEET} fit on a sheet) — narrow --from/--to "
                   "or take a larger step", EXIT_USAGE, kind="too-many-frames")
    return times


def cmd_sheet(args):
    from . import render as R
    from .scene import SceneError

    scene = _load(args)
    notes = _Notes(scene)
    if args.at:
        if args.from_t is not None or args.to_t is not None or args.step:
            raise Fail("--at names the exact times; it cannot be combined with --from/--to/--step", EXIT_USAGE, kind="usage")
        times = [_clamped(scene, v.strip(), "--at", notes) for v in args.at.split(",") if v.strip()]
        if not times:
            raise Fail("--at needs times, e.g. --at 2.1,2.4,2.7", EXIT_USAGE, kind="usage")
        if len(times) > MAX_SHEET:
            raise Fail(f"--at has {len(times)} times (at most {MAX_SHEET} fit on a sheet)", EXIT_USAGE, kind="too-many-frames")
        sel = "-at-" + ("_".join(f"{t:g}" for t in times) if len(times) <= 4 else f"{times[0]:g}-{times[-1]:g}x{len(times)}")
    else:
        t0, t1 = _range(args, scene, notes)
        partial = t0 > 0 or t1 < scene.duration - 1e-6
        if args.step:
            times = _step_times(scene, t0, t1, args.step)
            sel = f"-{t0:g}-{t1:g}s-step-{args.step}"
        else:
            times = R.key_moments(scene, t0, t1, args.count)
            sel = f"-{t0:g}-{t1:g}s" if partial else ""
    focus = args.focus
    if focus and focus != "action" and focus not in scene.figures:
        raise Fail(f'--focus: unknown figure "{focus}"{registry.suggest(focus, scene.figures)} (figures: {", ".join(scene.figures)}; or: action)',
                   EXIT_USAGE, kind="unknown-figure", got=focus, suggest=registry.close_matches(focus, scene.figures))
    png = Path(args.out) if args.out else _sheet_path(args, scene, sel, focus)
    prev = _keep_previous(png)
    kw: dict = {"cols": args.cols}
    if args.width:
        kw["thumb_w"] = args.width
    if focus:
        kw["focus"] = focus
    if getattr(args, "onion", 0):
        kw["onion"] = args.onion
    if getattr(args, "markers", False):
        kw["markers"] = True
    for k in [k for k in kw if not _accepts(R.contact_sheet, k)]:
        notes.add(f"this renderer does not support --{'width' if k == 'thumb_w' else k} yet — ignored", "unsupported")
        kw.pop(k)
    try:
        with _Quiet():
            R.contact_sheet(scene, times, png, **kw)
    except (SceneError, R.RenderError) as e:
        raise _draw_fail(e, "drawing the sheet failed", args.scene) from None
    size = None
    try:
        from PIL import Image

        with Image.open(png) as im:
            size = list(im.size)
    except Exception:  # noqa: BLE001
        pass
    if size and max(size) > 4000:
        notes.add(f"the sheet is {size[0]}×{size[1]} px — an image reader shrinks it until nothing can be seen; use fewer frames (--count), "
                  "more --cols or a smaller --width", "too-large")
    files = {"preview": str(png)}
    if prev:
        files["previous"] = str(prev)
    data = {"ok": True, "files": files, "times": [round(t, 3) for t in times], "labels": [scene.clock.label(t) for t in times], "size": size,
            "warnings": notes.text, "warning_items": notes.items}
    text = f"Contact sheet with {len(times)} frames" + (f" ({size[0]}×{size[1]} px)" if size else "") + f": {png}\nLook at it: read {png}"
    if prev:
        text += f"\n(the sheet before is kept: {prev} — compare them)"
    _emit(args, data, text + "".join(f"\n{w}" for w in notes.lines()))


def cmd_still(args):
    from . import render as R
    from .scene import SceneError

    scene = _load(args)
    notes = _Notes(scene)
    out_dir = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews"
    _writable(out_dir)
    tag = "" if abs(args.scale - 1.0) < 1e-9 else f"@{args.scale:g}"      # stills of another size do not replace these
    times = [_clamped(scene, v, "time", notes) for v in args.times]
    files: dict[str, str] = {}
    t = times[0]
    try:
        with _Quiet():
            r = R.Renderer(scene, ss=2, scale=args.scale)
            for t in times:
                p = out_dir / f"{_name(args, scene)}-{t:07.3f}{tag}.png"
                r.frame(t).save(str(p))
                files[f"{t:.3f}"] = str(p)
    except (SceneError, R.RenderError) as e:
        raise _draw_fail(e, f"drawing the frame at {t:.2f}s failed", args.scene) from None
    _emit(args, {"ok": True, "files": files, "times": [round(t, 3) for t in times], "size": [r.W, r.H], "warnings": notes.text, "warning_items": notes.items},
          "\n".join(list(files.values()) + notes.lines()))


SPRITE_MAX_SIDE = 16384         # the largest texture most engines and browsers accept
SPRITE_MAX_PIXELS = 8192 * 8192  # 67 M px: below Pillow's DecompressionBomb warning (89 M px); 256 MB as RGBA
SPRITE_WARN_SIDE = 4096         # a common limit of mobile GPUs


def _sprite_layout(frames: int, size: int, cols: int | None, notes: _Notes) -> int:
    """The columns of a sprite sheet, chosen before anything is drawn: up to 64 frames 8 per row (as
    before), more frames about as many rows as columns. A sheet that image tools or game engines
    cannot open fails at once (exit 2) with the largest --size that fits."""
    def largest(c: int) -> int:
        """The largest cell size that fits with c columns."""
        r = math.ceil(frames / c)
        return min(SPRITE_MAX_SIDE // max(c, r), int(math.sqrt(SPRITE_MAX_PIXELS / (c * r))))

    auto = cols is None
    square = min(frames, math.ceil(math.sqrt(frames)))    # the squarest layout fits the largest cells
    if auto:
        cols = min(frames, max(8, square))
    rows = math.ceil(frames / cols)
    w, h = cols * size, rows * size
    if max(w, h) > SPRITE_MAX_SIDE or w * h > SPRITE_MAX_PIXELS:
        hint = [f"--size {largest(cols)} or less"] if largest(cols) >= 16 else []
        if not auto and largest(square) > largest(cols):
            hint.append(f"--cols {square} (then --size up to {largest(square)})")
        hint.append("fewer --frames")
        raise Fail(f"the sprite sheet would be {w}×{h} px ({cols} columns × {rows} rows of {size} px) — more than image tools and game engines open "
                   f"(at most {SPRITE_MAX_SIDE} px a side and 8192×8192 = {SPRITE_MAX_PIXELS / 1e6:.0f} M pixels): use " + " or ".join(hint),
                   EXIT_USAGE, kind="too-large", got=[w, h])
    if max(w, h) > SPRITE_WARN_SIDE:
        notes.add(f"the sprite sheet is {w}×{h} px — larger than {SPRITE_WARN_SIDE} px, which many phones cannot use as one texture; "
                  "a smaller --size or fewer --frames keeps it below", "too-large")
    return cols


def cmd_sprite(args):
    from . import render as R
    from .scene import SceneError

    scene = _load(args)
    notes = _Notes(scene)
    if args.figure not in scene.figures:
        raise Fail(f'unknown figure "{args.figure}"{registry.suggest(args.figure, scene.figures)} (figures: {", ".join(scene.figures)})', EXIT_USAGE,
                   kind="unknown-figure", got=args.figure, suggest=registry.close_matches(args.figure, scene.figures))
    t0, t1 = _range(args, scene, notes)
    cols = _sprite_layout(args.frames, args.size, args.cols, notes)
    out_dir = Path(args.out) if args.out else registry.project_dir() / "exports"
    _writable(out_dir)
    png = out_dir / f"{_name(args, scene)}-{args.figure}-sprite.png"
    try:
        with _Quiet():
            meta = R.sprite_sheet(scene, args.figure, t0, t1, args.frames, args.size, png, cols)
    except (SceneError, R.RenderError) as e:
        raise _draw_fail(e, "drawing the sprite sheet failed", args.scene) from None
    _emit(args, {"ok": True, "files": {"png": str(png), "json": str(png.with_suffix(".json"))}, **meta, "warnings": notes.text, "warning_items": notes.items},
          f"Sprite sheet: {png} ({meta['columns']}×{meta['rows']} cells of {meta['cell']} px, {len(meta['frames'])} frames, {meta['fps']} fps)\n"
          f"Atlas: {png.with_suffix('.json')}" + "".join(f"\n{w}" for w in notes.lines()))


# --- catalogues ---------------------------------------------------------------------------------
TABLES = {
    "poses": ("pose", "pose: <name>  (single angles can be changed next to it: { pose: guard, RS: 60 })"),
    "actions": ("action", "do: <name>  with its parameters"),
    "fx": ("motion", "fx: <name>  or  fx: { use: <name>, <param>: … }  — continuous movement while a pose is held"),
    "props": ("prop", "props: { name: { kind: <name>, x: …, <param>: … } }   (hand props: held_by: figure, hand: R|L)"),
    "backdrops": ("backdrop", "scene: { background: <name> }  or  background: { use: <name>, <param>: … }"),
    "sounds": ("sound", "events: [ { t: 2, sfx: <name> } ]  — also audio files (assets/x.wav) and pack items (pack/item)"),
    "particles": ("particle", "events: [ { t: 2, burst: <name>, x: 600, y: 400, n: 20 } ]"),
}
EXTRA_TABLES = ("hats", "expressions", "eases", "events")
LIST_ALIASES = {
    "pose": "poses", "action": "actions", "do": "actions", "motion": "fx", "motions": "fx", "prop": "props", "backdrop": "backdrops",
    "background": "backdrops", "backgrounds": "backdrops", "sound": "sounds", "sfx": "sounds", "particle": "particles", "burst": "particles",
    "hat": "hats", "expression": "expressions", "expr": "expressions", "look": "expressions", "looks": "expressions", "ease": "eases",
    "event": "events",
}
FIGURE_OPTIONS = "glasses, tie, badge, belt, scarf, cape, hair, shoes, skin, eyes (true or a color); label, scale, build, outline, line, z"


def cmd_list(args):
    from .draw import HATS
    from .scene import EVENT_DEFAULTS, EXPRESSIONS, LOOKS
    from .skeleton import EASES

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    what = (args.what or "all").lower()
    words = [w.lower() for w in (args.words or [])]
    what = LIST_ALIASES.get(what, what)
    if what not in TABLES and what not in EXTRA_TABLES and what != "all":
        words.insert(0, what)
        what = "all"

    def hit(*texts) -> bool:
        return not words or any(w in " ".join(str(x) for x in texts).lower() for w in words)

    data: dict = {}
    lines: list[str] = []
    for key, (kind, usage) in TABLES.items():
        if what not in ("all", key):
            continue
        entries = [e for e in registry.TABLES[kind].values() if hit(e.name, e.doc, e.source)]
        if not entries and (words or what == "all"):
            continue
        data[key] = [{"name": e.name, "doc": e.doc.split("\n")[0], "params": e.params, "source": e.source, **({"angles": e.data} if kind == "pose" else {})}
                     for e in entries]
        lines.append(f"{key} — {usage}")
        for e in entries:
            params = ", ".join(f"{k}={json.dumps(v)}" for k, v in e.params.items())
            src = "" if e.source == "built-in" else f"  [{e.source}]"
            lines.append(f"  {e.name:<14} {e.doc.splitlines()[0] if e.doc else ''}{('  params: ' + params) if params else ''}{src}")
        lines.append("")
    extras = {
        "hats": ([h for h in HATS if hit(h, "hat")], lambda v: f"hats — figures: {{ hero: {{ hat: <name> }} }}: {', '.join(v)}   (more figure options: {FIGURE_OPTIONS})"),
        "expressions": ([x for x in EXPRESSIONS if hit(x, "expr expression face")], lambda v: f"expressions — expr: {', '.join(v)}   look: {', '.join(LOOKS)}"),
        "eases": ([x for x in EASES if hit(x, "ease")], lambda v: f"eases — ease: {', '.join(v)}   (how a keyframe or camera key is reached; default io)"),
        "events": ([k for k in EVENT_DEFAULTS if hit(k, " ".join(EVENT_DEFAULTS[k]), "event")],
                   lambda v: "events — " + "; ".join(f"{k} ({', '.join(EVENT_DEFAULTS[k])})" for k in v)),
    }
    for key, (vals, fmt) in extras.items():
        if what not in ("all", key) or not vals:
            continue
        data[key] = vals if key != "events" else {k: list(EVENT_DEFAULTS[k]) for k in vals}
        if key == "expressions":
            data["looks"] = LOOKS
        lines += [fmt(vals), ""]
    matched = {k: len(v) for k, v in data.items() if k != "looks"}
    for err in registry.PLUGIN_ERRORS:
        lines.append(f"plugin error: {err['file']}: {err['error']}")
    notes = _Notes()
    notes.add_registry()
    lines += notes.lines()
    if not matched:
        names: dict[str, list[str]] = {}
        for key, (kind, _) in TABLES.items():
            for n in registry.TABLES[kind]:
                names.setdefault(n, []).append(kind)
        for key, (vals, _) in extras.items():
            for n in {"hats": HATS, "expressions": EXPRESSIONS, "eases": list(EASES), "events": list(EVENT_DEFAULTS)}[key]:
                names.setdefault(n, []).append(key.rstrip("s"))
        close = []
        for w in words or [what]:
            close += [c for c in registry.close_matches(w, names, n=4) if c not in close]
        hint = (" — did you mean " + ", ".join(f"{c} ({', '.join(names[c])})" for c in close) + "?") if close else ""
        where = f" in {what}" if what != "all" else ""
        raise Fail(f"nothing matches{where}: {' '.join(words)}{hint} (everything: studio-stickman list)", EXIT_SCENE, kind="no-match",
                   got=" ".join(words), suggest=close, pluginErrors=registry.PLUGIN_ERRORS)
    data["matched"] = matched
    data["pluginErrors"] = registry.PLUGIN_ERRORS
    data["warnings"], data["warning_items"] = notes.text, notes.items
    _emit(args, {"ok": True, **data}, "\n".join(lines).rstrip())


def cmd_poses(args):
    from . import render as R

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    words = [w.lower() for w in (args.words or [])]
    # several words = several poses: any of them may match (a name, or a word of the description)
    names = [e.name for e in registry.POSES.values() if not words or any(w in f"{e.name} {e.doc}".lower() for w in words)]
    if not names:
        raise Fail(f"no pose matches: {' '.join(words)}{registry.suggest(words[0], registry.POSES)} (all poses: studio-stickman poses)", EXIT_SCENE,
                   kind="no-match", got=" ".join(words), suggest=registry.close_matches(words[0], registry.POSES))
    files = {}
    if args.preview:
        png = Path(args.out) if args.out else registry.project_dir() / ".studio" / "previews" / "poses.png"
        with _Quiet():
            R.pose_sheet(names, png)
        files["preview"] = str(png)
    lines = [f"  {e.name:<14} {e.doc}" + ("" if e.source == "built-in" else f"  [{e.source}]") for e in registry.POSES.values() if e.name in names]
    lines.append(f"Look at the catalogue: read {files['preview']}" if args.preview else "Add --preview for a picture of them.")
    notes = _Notes()
    notes.add_registry()
    for err in registry.PLUGIN_ERRORS:
        lines.append(f"plugin error: {err['file']}: {err['error']}")
    lines += notes.lines()
    _emit(args, {"ok": True, "poses": [{"name": n, "doc": registry.POSES[n].doc, "angles": registry.POSES[n].data} for n in names], "files": files,
                 "pluginErrors": registry.PLUGIN_ERRORS, "warnings": notes.text, "warning_items": notes.items},
          "\n".join(lines))


def cmd_plugin(args):
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    if not name.isidentifier() or keyword.iskeyword(name):
        raise Fail(f'"{args.name}" cannot be a plugin name: use a word of letters, digits and _ that is not a Python keyword', EXIT_USAGE, kind="bad-name")
    path = registry.project_dir() / "plugins" / "stickman" / f"{name}.py"
    if path.exists():
        raise Fail(f"{path} already exists", EXIT_SCENE, kind="exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(PLUGINS[args.kind].replace("{{NAME}}", name), "utf-8")
    use = {"action": f"do: {name}", "pose": f"pose: {name}", "prop": f"props: {{ x: {{ kind: {name} }} }}", "fx": f"fx: {name}",
           "backdrop": f"background: {name}", "sound": f"sfx: {name}", "particle": f"events: [ {{ t: 1, burst: {name}, x: 640, y: 300 }} ]"}[args.kind]
    _emit(args, {"ok": True, "file": str(path), "files": {"plugin": str(path)}, "kind": args.kind, "use": use},
          f"Created {path}. Use it in a scene: {use}   (check it: studio-stickman list {name})")


# --- docs / schema ------------------------------------------------------------------------------
DOC_TOPICS = {
    "start": "", "commands": "Command line", "scene": "Scene file", "time": "Time", "keyframes": "Keyframes", "actions": "Actions",
    "figures": "Figures", "props": "Props", "camera": "Camera", "events": "Events", "output": "Output", "plugins": "Extending the tool",
    "tips": "Tips for good animation",
}


def _doc_sections() -> dict[str, str]:
    """The README cut at its ## / ### headings (the text before the first one is "start")."""
    text = (TOOL_DIR / "README.md").read_text("utf-8")
    sections: dict[str, str] = {}
    head, buf = "", []
    in_code = False
    for line in text.splitlines():
        if line.startswith("```"):
            in_code = not in_code
        if not in_code and re.match(r"^#{2,3} ", line):
            sections[head] = "\n".join(buf).strip()
            head, buf = line.lstrip("#").strip(), [line]
            continue
        buf.append(line)
    sections[head] = "\n".join(buf).strip()
    return sections


def cmd_docs(args):
    sections = _doc_sections()
    topic = (args.topic or "").lower()
    if not topic:
        if args.json:
            _emit(args, {"ok": True, "topics": list(DOC_TOPICS), "sections": {(k or "start"): v for k, v in sections.items()}}, "")
        else:
            print((TOOL_DIR / "README.md").read_text("utf-8"))
        return
    head = DOC_TOPICS.get(topic)
    if head is None:
        found = [h for h in sections if h and topic in h.lower()]
        head = found[0] if found else None
    else:
        head = next((h for h in sections if h == head or (head and h.lower().startswith(head.lower()))), None)
    if head is None:
        raise Fail(f'no docs topic "{topic}"{registry.suggest(topic, DOC_TOPICS)} (topics: {", ".join(DOC_TOPICS)})', EXIT_USAGE, kind="no-match",
                   got=topic, suggest=registry.close_matches(topic, DOC_TOPICS))
    _emit(args, {"ok": True, "topic": topic, "heading": head or "start", "markdown": sections[head]}, sections[head])


def _param_schema(name: str, default) -> dict:
    if name in ("dur", "hold", "gap", "in", "in_"):
        s = {"$ref": "#/$defs/span"}
    elif isinstance(default, bool):
        s = {"type": "boolean"}
    elif isinstance(default, (int, float)):
        s = {"type": "number"}
    elif isinstance(default, str):
        s = {"type": "string"}
    elif isinstance(default, list):
        s = {"type": "array"}
    elif isinstance(default, dict):
        s = {"type": "object"}
    else:
        s = {}
    if default is not None:
        s["default"] = default
    return s


def _schema() -> dict:
    """JSON Schema (draft 2020-12) of *.stick.yaml, made from the registries: every action with its
    parameters, every pose, prop, backdrop, sound and particle — plugins of the project included."""
    from .draw import HATS
    from .scene import EVENT_DEFAULTS, EVENT_KINDS, EXPRESSIONS, KEY_FIELDS, LOOKS
    from .skeleton import ANGLES, EASES

    with _Quiet():
        registry.load_builtins()
        registry.load_project_plugins()
    num = {"type": "number"}
    unit = r"(s|sec|b|beat|beats|bar|bars)?"
    time_s = {"description": 'seconds (2.5), "bar:beat" ("3:1", needs scene.bpm) or after the previous item ("+0.4", "+1b")',
              "anyOf": [{"type": "number", "minimum": 0}, {"type": "string", "pattern": r"^(\+\s*[0-9]*\.?[0-9]+\s*" + unit + r"|[0-9]+:[0-9]*\.?[0-9]+|[0-9]*\.?[0-9]+\s*" + unit + ")$"}]}
    span = {"description": 'a length: seconds 1.5, beats "2b", bars "1bar"',
            "anyOf": [{"type": "number", "minimum": 0}, {"type": "string", "pattern": r"^[0-9]*\.?[0-9]+\s*" + unit + "$"}]}
    color_s = {"description": "#rrggbb, #rgb, #rrggbbaa, a color name or [r, g, b]", "anyOf": [{"type": "string"}, {"type": "array", "items": num, "minItems": 3, "maxItems": 4}]}
    face = {"anyOf": [{"type": "string", "pattern": r"^\s*([Ll]([Ee][Ff][Tt])?|[Rr]([Ii][Gg][Hh][Tt])?|[+-]?1)\s*$"}, {"enum": [1, -1]}]}
    fx_s = {"description": 'continuous movement: a name, "a+b", { use: name, param: … } or a list',
            "anyOf": [{"type": "string"}, {"type": "object", "properties": {"use": {"$ref": "#/$defs/motion"}}, "required": ["use"]}, {"type": "array"}]}
    sound_s = {"description": "a sound (list sounds), an audio file of the project or pack/item", "type": "string"}
    # what many places use is defined once and referenced ($ref): the file stays small for editors
    defs = {"time": time_s, "span": span, "color": color_s, "face": face, "fx": fx_s, "sound_or_file": sound_s, "ease": {"enum": list(EASES)},
            **{kind: {"enum": sorted(table)} for kind, table in registry.TABLES.items()}}

    def ref(name: str) -> dict:
        return {"$ref": f"#/$defs/{name}"}

    def names(kind: str) -> dict:
        return ref(kind)

    time_s, span, color_s, face, fx_s, sound_s = ref("time"), ref("span"), ref("color"), ref("face"), ref("fx"), ref("sound_or_file")
    inline = {"say": {"type": "string"}, "say_dur": span, "sfx": sound_s, "text": {"type": "string"}, "shake": num, "flash": {}, "burst": names("particle"),
              "caption": {"type": "string"}, "title": {"type": "string"}, "fade": {"enum": ["in", "out"]}}
    inline = {k: v for k, v in inline.items() if k in EVENT_KINDS or k == "say_dur"}
    key_props = {"t": time_s, "pose": names("pose"), "x": num, "y": num, "rot": num, "face": face, "ease": ref("ease"),
                 "expr": {"enum": list(EXPRESSIONS)}, "look": {"enum": list(LOOKS)}, "fx": fx_s, "arc": num, "in": {"anyOf": [span, {"enum": ["full", "all"]}]},
                 "hold": span, "visible": {"type": "boolean"}, **{a: num for a in ANGLES}}
    key_props = {k: v for k, v in key_props.items() if k in KEY_FIELDS or k in ANGLES}
    key_item = {"description": "a keyframe: be in this state AT t", "type": "object", "properties": {**key_props, **inline}, "additionalProperties": False}
    actions = []
    for n, e in sorted(registry.ACTIONS.items()):
        props = {"do": {"const": n}, "t": time_s, **inline, **{k: _param_schema(k, v) for k, v in e.params.items()}}
        actions.append({"if": {"properties": {"do": {"const": n}}, "required": ["do"]},
                        "then": {"description": (e.doc or "").split("\n")[0], "properties": props, "additionalProperties": False}})
    item = {"type": "object", "if": {"required": ["do"]}, "then": {"properties": {"do": names("action")}, "allOf": actions}, "else": key_item}
    extras = {k: {"anyOf": [{"type": "boolean"}, color_s]} for k in ("glasses", "tie", "badge", "cape", "hair", "eyes", "belt", "scarf", "shoes", "skin")}
    figure = {"type": "object", "additionalProperties": False, "properties": {
        "color": color_s, "outline": color_s, "scale": {"type": "number", "minimum": 0.2, "maximum": 4},
        "build": {"type": "object", "additionalProperties": num}, "line": num, "z": num, "label": {"type": "string"}, "x": num, "y": num, "face": face,
        "pose": names("pose"), "expr": {"enum": list(EXPRESSIONS)}, "fx": fx_s, "visible": {"type": "boolean"},
        "talk": {"type": "boolean", "description": "false: no automatic gestures while the figure speaks"},
        "hat": {"anyOf": [{"enum": list(HATS)}, {"type": "boolean"},
                          {"type": "object", "additionalProperties": False, "properties": {"kind": {"enum": list(HATS)}, "color": color_s}}]}, **extras}}
    prop_common = {"kind": names("prop"), "x": num, "y": num, "rot": num, "scale": num, "flip": {"type": "boolean"}, "layer": {"enum": ["back", "front"]},
                   "from": time_s, "to": time_s, "held_by": {"type": "string"}, "hand": {"type": "string", "pattern": "^[RrLl]"}, "angle": num,
                   "keys": {"type": "array", "items": {"type": "object", "required": ["t"], "properties": {
                       "t": time_s, "x": num, "y": num, "rot": num, "arc": num, "ease": ref("ease")}}}}
    prop_kinds = [{"if": {"properties": {"kind": {"const": n}}, "required": ["kind"]},
                   "then": {"properties": {**prop_common, **{k: _param_schema(k, v) for k, v in e.params.items()}}, "additionalProperties": False}}
                  for n, e in sorted(registry.PROPS.items())]
    cam_key = {"type": "object", "additionalProperties": False, "properties": {
        "t": time_s, "x": num, "y": num, "zoom": {"type": "number", "minimum": 0.2, "maximum": 8}, "ease": ref("ease"),
        "follow": {"type": "string"}, "dx": num, "dy": num, "cut": {"type": "boolean"}}}
    ev_value = {"text": {"type": "string"}, "say": {"type": "string"}, "caption": {"type": "string"}, "title": {"type": "string"},
                "hit": {"anyOf": [{"type": "array", "items": num, "minItems": 2, "maxItems": 2},
                                  {"type": "object", "properties": {"on": {"type": "string"}, "part": {"enum": ["head", "chest", "hip", "hand", "foot", "knee", "neck"]}},
                                   "required": ["on"]}]},
                "sfx": sound_s, "shake": num, "flash": {}, "burst": names("particle"), "fade": {"enum": ["in", "out"]}}
    events = [{"if": {"required": [k]}, "then": {"properties": {"t": time_s, k: ev_value.get(k, {}), **{o: _param_schema(o, v) for o, v in EVENT_DEFAULTS[k].items()}},
                                                 **({} if k in ("sfx", "burst") else {"additionalProperties": False})}}
              for k in EVENT_KINDS]
    event = {"type": "object", "anyOf": [{"required": [k]} for k in EVENT_KINDS], "allOf": events}
    scene = {"type": "object", "additionalProperties": False, "properties": {
        "title": {"type": "string"}, "size": {"type": "array", "items": {"type": "integer", "minimum": 64}, "minItems": 2, "maxItems": 2},
        "fps": {"type": "number", "minimum": 5, "maximum": 60},
        "background": {"anyOf": [{"type": "string", "description": "a backdrop (" + ", ".join(sorted(registry.BACKDROPS)) + ") or a color"},
                                 {"type": "object", "properties": {"use": names("backdrop")}}, color_s, {"type": "null"}, {"const": False}]},
        "bpm": {"type": "number", "minimum": 20, "maximum": 400}, "time": {"type": "string", "pattern": r"^[0-9]+/[0-9]+$"},
        "audio": {"type": "string"}, "audio_gain": num, "audio_offset": span, "sfx_gain": num, "floor": num,
        "world": {"type": "array", "items": num, "minItems": 2, "maxItems": 2}, "blend": span, "duration": span, "seed": {"type": "integer"},
        "footsteps": {"type": "boolean", "description": "automatic footstep sounds of walking, running and sneaking figures (default true)"},
        "style": {"type": "object", "additionalProperties": False, "properties": {
            "line": num, "outline": {"type": "boolean"}, "shadow": {"type": "boolean"}, "vignette": num, "grain": num, "faces": {"type": "boolean"},
            "highlight": {"type": "boolean"}, "smear": {"type": "boolean"}}}}}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://everything.studio/schemas/stick.schema.json",
        "$defs": defs,
        "title": "studio-stickman scene (*.stick.yaml)",
        "description": f"made by studio-stickman {__version__} schema — names from the registries, project plugins included",
        "type": "object", "additionalProperties": False, "required": ["figures"],
        # top-level keys starting with _ or x- are ignored by the loader (room for YAML anchors)
        "patternProperties": {"^(_|x-)": {}},
        "properties": {
            "scene": scene,
            "use": {"type": "array", "items": {"type": "string"}},
            "figures": {"type": "object", "minProperties": 1, "additionalProperties": {"anyOf": [figure, {"type": "string"}, {"type": "null"}]}},
            "props": {"type": "object", "additionalProperties": {"type": "object", "properties": prop_common, "allOf": prop_kinds}},
            "timeline": {"type": "object", "additionalProperties": {"anyOf": [{"type": "array", "items": item}, item, {"type": "null"}]}},
            "camera": {"anyOf": [{"type": "array", "items": cam_key}, cam_key]},
            "events": {"type": "array", "items": event},
        },
    }


def cmd_schema(args):
    schema = _schema()
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(schema, indent=1), "utf-8")
        _emit(args, {"ok": True, "files": {"schema": str(out)}},
              f"Wrote {out}\nEditors with the YAML language server use it with this first line in a scene:\n"
              f"  # yaml-language-server: $schema={os.path.relpath(out, Path.cwd() / 'src').replace(os.sep, '/')}")
    elif args.json:
        _emit(args, {"ok": True, "schema": schema}, "")
    else:
        print(json.dumps(schema, indent=1))


# --- doctor / watch -----------------------------------------------------------------------------
def cmd_doctor(args):
    import multiprocessing as mp
    import platform

    checks: list[dict] = []

    def add(name: str, status: str, message: str, **data) -> None:
        checks.append({"name": name, "status": status, "message": message, **data})

    add("python", "ok", f"Python {platform.python_version()} ({sys.executable}) on {platform.system()} {platform.release()}; studio-stickman {__version__}")
    for mod in ("yaml", "PIL", "numpy", "scipy"):
        try:
            m = __import__(mod)
            add(mod, "ok", f"{mod} {getattr(m, '__version__', '')}".strip())
        except ImportError as e:
            add(mod, "fail", f"{mod} is missing: {e} (pip install pyyaml pillow numpy scipy)")
    if _PATH_NOTE:
        add("path", "warn", "PATH had entries that Git Bash split at the drive colon (\"C:/…\"); joined again for this run: " + ", ".join(_PATH_NOTE)
            + " — write them as /c/… in Git Bash")
    exe = shutil.which("ffmpeg")
    if not exe:
        add("ffmpeg", "fail", "ffmpeg is not on PATH — render cannot write video (sheet, still, sprite, check work without it)")
    else:
        try:
            ver = subprocess.run([exe, "-version"], capture_output=True, text=True, timeout=30).stdout.splitlines()[0]
        except (OSError, subprocess.SubprocessError, IndexError):
            ver = "ffmpeg (version unknown)"
        add("ffmpeg", "ok", f"{ver.split(' Copyright')[0]} at {exe}", path=exe)
        enc = _ffmpeg_list("encoders") or set()
        flt = _ffmpeg_list("filters") or set()
        need = [e for e in ("libx264", "aac") if e not in enc]
        add("encoders", "fail" if need else "ok", ("missing: " + ", ".join(need) + " (needed for every render)") if need else "libx264 (video), aac (sound)")
        opt = [e for e in ("libvpx-vp9", "libopus") if e not in enc] + [f for f in ("palettegen", "paletteuse") if f not in flt]
        add("formats", "warn" if opt else "ok", ("missing: " + ", ".join(opt) + " — --webm / --gif will fail") if opt else "--webm (libvpx-vp9, libopus) and --gif (palettegen) work")
    try:
        from . import render as R

        jobs = R.default_jobs()
    except Exception as e:  # noqa: BLE001
        R, jobs = None, 1
        add("render", "fail", f"the renderer cannot be imported: {type(e).__name__}: {e}")
    if "fork" in mp.get_all_start_methods():
        add("parallel", "ok", f"frames render in {jobs} processes (fork)")
    elif R is not None and hasattr(R, "_spawn_init"):
        add("parallel", "ok", f"no fork on this platform: longer renders start up to {jobs} worker processes that load the scene file again "
            "(slower to start); short ones render in one process")
    else:
        add("parallel", "warn", "no fork on this platform: frames render in one process (--jobs is ignored), so long renders are slower")
    project, why = registry.project_dir_info()
    add("project", "ok", f"{project} — {why}", path=str(project))
    for sub in ("exports", ".studio"):
        d = project / sub
        target = d if d.exists() else project
        ok = os.access(target, os.W_OK)
        add(f"writable {sub}/", "ok" if ok else "fail", f"{d} " + ("can be written" if ok else "cannot be written"))
    with _Quiet():
        try:
            registry.load_builtins()
            registry.load_project_plugins(project)
        except Exception as e:  # noqa: BLE001
            add("plugins", "fail", f"built-ins failed to load: {type(e).__name__}: {e}")
    counts = ", ".join(f"{len(t)} {k}s" for k, t in registry.TABLES.items())
    add("registry", "ok", counts)
    if registry.PLUGIN_ERRORS:
        add("plugins", "warn", "; ".join(f"{e['file']}: {e['error']}" for e in registry.PLUGIN_ERRORS), errors=registry.PLUGIN_ERRORS)
    else:
        add("plugins", "ok", (f"{len(registry.PLUGIN_FILES)} loaded: " + ", ".join(registry.PLUGIN_FILES)) if registry.PLUGIN_FILES else "none in plugins/stickman/")
    try:
        from .draw import _font_path

        fonts = {k: _font_path(k) for k in ("bold", "regular", "mono")}
        missing = [k for k, v in fonts.items() if not v]
        add("fonts", "warn" if missing else "ok", ("no TrueType font for " + ", ".join(missing) + " — texts fall back to a small bitmap font (install DejaVu)")
            if missing else ", ".join(f"{k}: {Path(v).name}" for k, v in fonts.items()))
    except Exception as e:  # noqa: BLE001
        add("fonts", "warn", f"could not be checked: {type(e).__name__}: {e}")
    if R is not None:
        from .scene import load_scene_text

        try:
            with _Quiet():
                scene = load_scene_text(SCENES["blank"].replace("{{TITLE_YAML}}", '"Doctor"').replace("{{TITLE}}", "Doctor"), project / "doctor.stick.yaml")
                r = R.Renderer(scene, ss=2, scale=1.0)
                t = time.perf_counter()
                r.frame(1.0)
                ms = (time.perf_counter() - t) * 1000
            per10 = ms * 300 / 1000 / (jobs if "fork" in mp.get_all_start_methods() else 1)
            add("test frame", "ok", f"{r.W}×{r.H} at full quality in {ms:.0f} ms (a simple scene) — about {per10:.0f} s of rendering per 10 s of "
                "video at 30 fps; busy scenes take longer")
            if exe:
                with tempfile.TemporaryDirectory() as tmp, _Quiet():
                    R.render_video(scene, Path(tmp) / "doctor.mp4", t0=0.0, t1=0.3, fps=10, scale=0.25, ss=1, jobs=1, audio_wav=None)
                add("test video", "ok", "a 0.3 s MP4 was encoded")
        except Exception as e:  # noqa: BLE001
            add("test render", "fail", f"{type(e).__name__}: {e}")
    ok = not any(c["status"] == "fail" for c in checks)
    lines = [f"studio-stickman doctor — {'everything needed is there' if ok else 'something is missing'}"]
    lines += [f"  {c['status']:<5} {c['name']}: {c['message']}" for c in checks]
    _emit(args, {"ok": ok, "checks": checks, "exit": 0 if ok else EXIT_ENV}, "\n".join(lines))
    return 0 if ok else EXIT_ENV


def _run_self(argv: list[str]) -> tuple[int, dict | None, str]:
    """Run a command of this tool in a fresh process (plugins and the scene are read again)."""
    code = f"import sys; sys.path.insert(0, {str(TOOL_DIR)!r}); from studio_stickman.cli import main; main(sys.argv[1:])"
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    r = subprocess.run([sys.executable, "-c", code, *argv, "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    try:
        return r.returncode, json.loads((r.stdout or "").strip().splitlines()[-1]), r.stderr
    except (ValueError, IndexError):
        return r.returncode, None, (r.stderr or r.stdout)[-500:]


def cmd_watch(args):
    scene_path = _scene_file(args.scene)
    if scene_path is None:
        raise Fail("watch needs a scene file (not stdin)", EXIT_USAGE, kind="usage")
    registry.use_scene(scene_path)
    project = registry.project_dir()

    def snapshot() -> dict:
        files = [scene_path, *sorted((project / "plugins" / "stickman").glob("*.py"))]
        out = {}
        for f in files:
            try:
                out[str(f)] = f.stat().st_mtime_ns
            except OSError:
                pass
        return out

    last: dict | None = None
    prev_warnings: list[str] | None = None
    runs = 0
    started = time.time()
    if not args.json:
        print(f"watching {scene_path} (and plugins/stickman/) — Ctrl+C ends", file=sys.stderr, flush=True)
    try:
        while True:
            snap = snapshot()
            if snap != last:
                time.sleep(0.15)                  # an editor may still be writing: wait until the file is complete
                snap = snapshot()
                last = snap
                runs += 1
                code, data, err = _run_self(["check", str(scene_path)] + (["--strict"] if args.strict else []))
                data = data or {"ok": False, "error": err.strip() or f"check failed (exit {code})"}
                warns = list(data.get("warnings") or [])
                new = [w for w in warns if prev_warnings is None or w not in prev_warnings]
                fixed = [w for w in (prev_warnings or []) if w not in warns]
                if data.get("ok"):
                    prev_warnings = warns
                report = {"run": runs, "at": time.strftime("%H:%M:%S"), "ok": bool(data.get("ok")), "exit": code, "check": data, "new_warnings": new,
                          "fixed_warnings": fixed}
                if data.get("ok") and args.sheet:
                    sheet_args = ["sheet", str(scene_path)] + (["--at", args.at] if args.at else []) + (["--focus", args.focus] if args.focus else [])
                    scode, sdata, serr = _run_self(sheet_args)
                    report["sheet"] = (sdata or {}).get("files", {}).get("preview") if scode == 0 else None
                    if scode != 0:
                        report["sheet_error"] = (sdata or {}).get("error") or serr.strip()[-300:]
                if args.json:
                    _print_json(report)
                else:
                    head = f"[{report['at']}] "
                    if data.get("ok"):
                        print(head + f"OK — {data.get('title')}: {data.get('seconds')}s, {len(warns)} warning(s)" +
                              (f" (+{len(new)} new, -{len(fixed)} fixed)" if runs > 1 and (new or fixed) else ""), flush=True)
                        for w in (new if runs > 1 else warns):
                            print(f"  + warning: {w}", flush=True)
                        for w in fixed:
                            print(f"  - fixed: {w}", flush=True)
                    else:
                        print(head + "FAIL", flush=True)
                        for e in data.get("errors") or [{"message": data.get("error")}]:
                            print(f"  {e.get('message')}", flush=True)
                    if report.get("sheet"):
                        print(f"  sheet: read {report['sheet']}", flush=True)
                    elif report.get("sheet_error"):
                        print(f"  sheet failed: {report['sheet_error']}", flush=True)
                if args.max_runs and runs >= args.max_runs:
                    break
            if args.timeout and time.time() - started > args.timeout:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------------------
# The command line itself
# ---------------------------------------------------------------------------
class _Parser(argparse.ArgumentParser):
    """argparse with its errors as JSON when --json was given (anywhere on the command line)."""

    json_wanted = False
    command = None           # the command named on the command line (the top parser reports unknown options)

    def error(self, message: str):
        parts = self.prog.split()
        cmd = parts[1] if len(parts) > 1 else _Parser.command
        if _Parser.json_wanted:
            _print_json({"ok": False, "command": cmd, "version": __version__, "error": message,
                         "errors": [{"code": "usage", "message": message, "usage": self.format_usage().strip()}], "exit": EXIT_USAGE})
            sys.exit(EXIT_USAGE)
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n  (all options: studio-stickman help{' ' + cmd if cmd else ''})\n")

    def print_help(self, file=None):
        # `render -h --json` / `--json render --help`: argparse's own help action ends up here
        if _Parser.json_wanted:
            parts = self.prog.split()
            _print_json(_help_json(parts[1] if len(parts) > 1 else None, self))
            return
        super().print_help(file)


def _int_in(lo: int, hi: int):
    def conv(v: str) -> int:
        try:
            n = int(str(v).strip())
        except ValueError:
            raise argparse.ArgumentTypeError(f"must be a whole number from {lo} to {hi}, got {v!r}") from None
        if not lo <= n <= hi:
            raise argparse.ArgumentTypeError(f"must be from {lo} to {hi}, got {n}")
        return n

    return conv


def _float_in(lo: float, hi: float):
    def conv(v: str) -> float:
        try:
            x = float(str(v).strip())
        except ValueError:
            raise argparse.ArgumentTypeError(f"must be a number from {lo:g} to {hi:g}, got {v!r}") from None
        if not (lo <= x <= hi) or math.isnan(x):
            raise argparse.ArgumentTypeError(f"must be from {lo:g} to {hi:g}, got {x:g}")
        return x

    return conv


SUMMARIES = {
    "new": "create a starter scene from a template",
    "check": "validate scenes fast: names, parameters, timing; plays them through to catch plugin and drawing errors",
    "sheet": "contact sheet PNG of the key moments (or --at / --step frames) — read it before rendering",
    "at": "the state at a time as text: pose, position, action, camera view, events, gaps between figures",
    "info": "who does what when, with the moment each strike lands",
    "render": "render the video: MP4 with sound (+ GIF, WebM, PNG frames, contact sheet); --draft for a quick look",
    "still": "single frames as PNG",
    "sprite": "transparent sprite sheet + atlas JSON of one figure, for games",
    "list": "what scenes can use: poses, actions, fx, props, backdrops, sounds, particles, hats, expressions, eases, events",
    "poses": "the pose catalogue (--preview: a picture of every pose with its name)",
    "plugin": "write a starter plugin that extends the tool (plugins/stickman/<name>.py)",
    "watch": "check (and sheet) a scene again every time it or a plugin is saved",
    "schema": "JSON Schema of the scene format, made from the registries (editors, self-checks)",
    "doctor": "check the setup: Python, ffmpeg and its encoders, parallel rendering, project folder, plugins, fonts, a test render",
    "docs": "the format reference (README), or one part of it: docs actions",
    "help": "help for one command: help render",
}


def _build_parser() -> tuple[_Parser, dict[str, _Parser]]:
    p = _Parser(prog="studio-stickman", add_help=False, allow_abbrev=False)
    p.add_argument("-h", "--help", action="store_true")
    p.add_argument("--version", action="store_true")
    p.add_argument("--json", action="store_true", default=False)
    p.add_argument("--usage-json", action="store_true", help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest="cmd", parser_class=_Parser, metavar="<command>")
    common = _Parser(add_help=False, allow_abbrev=False)
    # SUPPRESS: when the flag is not given here, the value from before the command is kept
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS,
                        help="print one JSON object on stdout (for programs); also accepted before the command")
    subs: dict[str, _Parser] = {}

    def add(name: str, fn, description: str = "") -> _Parser:
        sp = sub.add_parser(name, parents=[common], help=SUMMARIES[name], description=SUMMARIES[name] + ("\n\n" + description if description else ""),
                            allow_abbrev=False, formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(fn=fn)
        subs[name] = sp
        return sp

    def scene_arg(sp) -> None:
        sp.add_argument("scene", help="the scene file (*.stick.yaml; the extension may be left out)")

    def rng(sp, what: str = "") -> None:
        sp.add_argument("--from", dest="from_t", metavar="T", help=f"start time{what}: seconds (2.5) or bar:beat (\"3:1\"); default 0")
        sp.add_argument("--to", dest="to_t", metavar="T", help="end time; default the end of the scene")

    sp = add("new", cmd_new, "examples:\n  studio-stickman new src/duel.stick.yaml --template fight")
    sp.add_argument("file", help="the new scene file (.stick.yaml is added when missing)")
    sp.add_argument("--template", default="fight", choices=list(SCENES), help="what the starter shows (default: fight)")
    sp.add_argument("--force", action="store_true", help="overwrite an existing file")

    sp = add("check", cmd_check, "exit codes: 0 ok, 1 invalid, 3 warnings with --strict\nexamples:\n  studio-stickman check src/duel.stick.yaml\n"
             "  studio-stickman check src/*.stick.yaml --strict\n  cat draft.stick.yaml | studio-stickman check - --json")
    sp.add_argument("scenes", nargs="+", metavar="scene", help="scene file(s); - reads one scene from stdin")
    sp.add_argument("--strict", action="store_true", help="exit 3 when there are warnings (also plugins that failed to load)")

    sp = add("sheet", cmd_sheet, "examples:\n  studio-stickman sheet src/duel.stick.yaml\n  studio-stickman sheet src/duel.stick.yaml --at 6.0,6.2,6.4 --focus red\n"
             "  studio-stickman sheet src/duel.stick.yaml --from 4.4 --to 4.8 --step 1f      # every frame of the impact")
    scene_arg(sp)
    sp.add_argument("--at", metavar="T,T,…", help="exactly these times (seconds or bar:beat, comma separated)")
    rng(sp, " of the key moments")
    sp.add_argument("--count", type=_int_in(1, MAX_SHEET), default=12, metavar="N", help=f"number of key moments, 1–{MAX_SHEET} (default: 12)")
    sp.add_argument("--step", metavar="S", help="every S from --from to --to instead of key moments: 1f = every frame, 2f, 0.05 (s), 1b (beat)")
    sp.add_argument("--cols", type=_int_in(1, 12), default=4, metavar="N", help="pictures per row, 1–12 (default: 4)")
    sp.add_argument("--width", type=_int_in(160, 1280), metavar="PX", help="width of each picture in px, 160–1280 (default: the renderer's, about 560)")
    sp.add_argument("--focus", metavar="NAME", help="crop each picture around one figure, or 'action' (all visible figures)")
    sp.add_argument("--onion", type=_int_in(0, 6), default=0, metavar="N",
                    help="onion skin: N faint earlier poses behind each figure, to see the motion in one picture (0–6, default 0)")
    sp.add_argument("--markers", action="store_true", help="draw the floor line with x ticks, the feet (green: on the floor, red: in the air) and the hands")
    sp.add_argument("--out", metavar="FILE", help="the PNG to write (default: .studio/previews/<name>-sheet[-selection].png)")
    sp.add_argument("--name", metavar="N", help="name for the output files (default: the scene file's name)")

    sp = add("at", cmd_at, "examples:\n  studio-stickman at src/duel.stick.yaml 4.6\n  studio-stickman at src/duel.stick.yaml 4.5 4.6 4.7 --json")
    scene_arg(sp)
    sp.add_argument("times", nargs="+", metavar="t", help="times: seconds or bar:beat")

    sp = add("info", cmd_info)
    scene_arg(sp)

    sp = add("render", cmd_render, "files: exports/<name>.mp4 (a draft: exports/<name>.draft.mp4 — it never replaces the final export)\n"
             "examples:\n  studio-stickman render src/duel.stick.yaml --draft --from 3 --to 6\n  studio-stickman render src/duel.stick.yaml --res 1080p --preview")
    scene_arg(sp)
    sp.add_argument("--preview", action="store_true", help="also a contact sheet PNG of the key moments (the same file `sheet` writes)")
    sp.add_argument("--draft", action="store_true", help="fast look: half size, 15 fps, plain quality → <name>.draft.mp4")
    rng(sp)
    sp.add_argument("--fps", type=_int_in(5, 60), metavar="N", help="frames per second, 5–60 (default: scene.fps; 15 with --draft)")
    size = sp.add_mutually_exclusive_group()
    size.add_argument("--scale", type=_float_in(0.1, 4), metavar="F", help="size factor for the video, 0.1–4, at most 4K (scene.size × F; default 1, 0.5 with --draft)")
    size.add_argument("--res", choices=list(RESOLUTIONS), help="video height (the width follows scene.size): " + ", ".join(RESOLUTIONS))
    sp.add_argument("--gif", action="store_true", help="also a GIF (at most 640 px wide, 15 fps)")
    sp.add_argument("--webm", action="store_true", help="also a WebM (VP9 + Opus)")
    sp.add_argument("--frames", action="store_true", help="also every frame as PNG: <name>-frames/00000.png …")
    sp.add_argument("--no-audio", action="store_true", help="no sound track (faster)")
    sp.add_argument("--jobs", type=_int_in(1, 64), metavar="N", help="worker processes, 1–64 (default: the CPUs, at most 8)")
    sp.add_argument("--progress", choices=["auto", "text", "json", "none"], default="auto",
                    help="progress on stderr: text lines, JSON lines, or none (default: json with --json, else text)")
    sp.add_argument("--out", metavar="DIR", help="folder for the files (default: exports/ of the project)")
    sp.add_argument("--name", metavar="N", help="name for the output files (default: the scene file's name)")

    sp = add("still", cmd_still, "examples:\n  studio-stickman still src/duel.stick.yaml 2.5 \"3:1\" --scale 0.5")
    scene_arg(sp)
    sp.add_argument("times", nargs="+", metavar="t", help="times: seconds or bar:beat")
    sp.add_argument("--scale", type=_float_in(0.05, 4), default=1.0, metavar="F", help="size factor, 0.05–4 (default: 1 = scene.size)")
    sp.add_argument("--out", metavar="DIR", help="folder for the PNGs (default: .studio/previews/)")
    sp.add_argument("--name", metavar="N", help="name for the output files (default: the scene file's name)")

    sp = add("sprite", cmd_sprite, "examples:\n  studio-stickman sprite src/duel.stick.yaml --figure red --from 1 --to 2.6 --frames 8")
    scene_arg(sp)
    sp.add_argument("--figure", required=True, metavar="NAME", help="the figure to draw")
    rng(sp)
    sp.add_argument("--frames", type=_int_in(1, 256), default=8, metavar="N", help="number of frames, 1–256 (default: 8)")
    sp.add_argument("--size", type=_int_in(16, 1024), default=128, metavar="PX", help="cell size in px, 16–1024 (default: 128)")
    sp.add_argument("--cols", type=_int_in(1, 64), metavar="N", help="cells per row, 1–64 (default: up to 8)")
    sp.add_argument("--out", metavar="DIR", help="folder (default: exports/)")
    sp.add_argument("--name", metavar="N", help="name for the output files (default: the scene file's name)")

    sp = add("list", cmd_list, "kinds: poses actions fx props backdrops sounds particles hats expressions eases events (singular works too)\n"
             "examples:\n  studio-stickman list actions\n  studio-stickman list kick      # search every catalogue")
    sp.add_argument("what", nargs="?", metavar="kind", help="a catalogue (or a search word)")
    sp.add_argument("words", nargs="*", metavar="word", help="search words: names and descriptions")

    sp = add("poses", cmd_poses)
    sp.add_argument("words", nargs="*", metavar="word", help="pose names or words of their description (any of them)")
    sp.add_argument("--preview", action="store_true", help="a picture of the poses with their names")
    sp.add_argument("--out", metavar="FILE", help="the PNG (default: .studio/previews/poses.png)")

    sp = add("plugin", cmd_plugin, "examples:\n  studio-stickman plugin new backflip --kind action")
    sp.add_argument("action", choices=["new"], help="new: write a starter")
    sp.add_argument("name", help="the name scenes will use")
    sp.add_argument("--kind", default="action", choices=list(PLUGINS), help="what it adds (default: action)")

    sp = add("watch", cmd_watch, "with --json: one JSON object per run on stdout (JSON lines)\nexamples:\n"
             "  studio-stickman watch src/duel.stick.yaml --sheet")
    scene_arg(sp)
    sp.add_argument("--sheet", action="store_true", help="also write the contact sheet after every passing check")
    sp.add_argument("--at", metavar="T,T,…", help="the sheet shows these times")
    sp.add_argument("--focus", metavar="NAME", help="the sheet crops around this figure (or 'action')")
    sp.add_argument("--strict", action="store_true", help="warnings count as a failed check")
    sp.add_argument("--interval", type=_float_in(0.1, 60), default=0.5, metavar="S", help="seconds between looks at the files (default: 0.5)")
    sp.add_argument("--max-runs", type=_int_in(1, 100000), metavar="N", help="stop after N checks")
    sp.add_argument("--timeout", type=_float_in(1, 86400), metavar="S", help="stop after S seconds")

    sp = add("schema", cmd_schema, "examples:\n  studio-stickman schema --out .studio/stick.schema.json")
    sp.add_argument("--out", metavar="FILE", help="write it to a file (default: print it)")

    add("doctor", cmd_doctor)

    sp = add("docs", cmd_docs, "topics: " + ", ".join(DOC_TOPICS))
    sp.add_argument("topic", nargs="?", help="one part of the reference (default: all of it)")

    sp = add("help", None)
    sp.add_argument("topic", nargs="?", metavar="command", help="the command")
    return p, subs


def _synopsis(sp: argparse.ArgumentParser) -> str:
    parts = [sp.prog]
    for a in sp._actions:  # noqa: SLF001  (argparse has no public list of its arguments)
        if isinstance(a, argparse._HelpAction) or a.dest == "json" or a.help == argparse.SUPPRESS:  # noqa: SLF001
            continue
        if not a.option_strings:
            many = "…" if a.nargs in ("+", "*") else ""
            name = "|".join(a.choices) if a.choices and not a.metavar else f"<{a.metavar or a.dest}>"
            parts.append(f"[{name}{many}]" if a.nargs in ("?", "*") else f"{name}{many}")
            continue
        opt = a.option_strings[-1]
        if a.nargs == 0:
            parts.append(f"[{opt}]")
        else:
            val = "|".join(a.choices) if a.choices and len(a.choices) <= 8 else (a.metavar or a.dest.upper())
            parts.append(f"{opt} {val}" if a.required else f"[{opt} {val}]")
    # a non-breaking space inside each [...] keeps an option and its value on one line when wrapped
    return " ".join(x.replace(" ", "\u00a0") for x in parts)


def _usage_list(subs: dict[str, _Parser]) -> list[dict]:
    return [{"name": n, "usage": _synopsis(sp).replace(" ", " "), "description": SUMMARIES[n]} for n, sp in subs.items() if n != "help"]


def _options(sp: argparse.ArgumentParser) -> list[dict]:
    """The arguments of a command for programs: name, flags, help, default, choices, required."""
    out = []
    for a in sp._actions:  # noqa: SLF001
        if isinstance(a, argparse._HelpAction) or a.help == argparse.SUPPRESS:  # noqa: SLF001
            continue
        d: dict = {"name": a.option_strings[-1] if a.option_strings else (a.metavar or a.dest), "flags": list(a.option_strings),
                   "positional": not a.option_strings, "help": a.help or ""}
        if a.option_strings and a.nargs == 0:
            d["flag"] = True
        if a.default not in (None, False, argparse.SUPPRESS):
            d["default"] = a.default
        if a.choices:
            d["choices"] = list(a.choices)
        if a.required or (not a.option_strings and a.nargs not in ("?", "*")):
            d["required"] = True
        if a.nargs in ("+", "*"):
            d["many"] = True
        out.append(d)
    return out


def _help_json(topic: str | None, sp: argparse.ArgumentParser | None = None) -> dict:
    """help, -h and a bare call with --json: the help text and the same facts structured."""
    if topic is None or sp is None:
        _, subs = _build_parser()
        return {"ok": True, "command": "help", "version": __version__, "topic": None, "text": _help(subs), "commands": _usage_list(subs)}
    return {"ok": True, "command": "help", "version": __version__, "topic": topic, "description": SUMMARIES.get(topic, ""),
            "usage": _synopsis(sp).replace(" ", " "), "options": _options(sp), "text": sp.format_help()}


def _help(subs: dict[str, _Parser]) -> str:
    lines = ["studio-stickman — stick figure animation from text (scenes are YAML files: studio-stickman docs)", ""]
    for name, sp in subs.items():
        if name == "help":
            continue
        lines.append(f"  {name:<8} {SUMMARIES[name]}")
        lines += [x.replace("\u00a0", " ") for x in textwrap.wrap(_synopsis(sp), width=110, initial_indent="           ",
                                                                  subsequent_indent="               ", break_on_hyphens=False, break_long_words=False)]
    lines += [
        "",
        "Work in this order: check → sheet (read the PNG) → render --draft → render.",
        'Times: seconds (2.5) or, with scene.bpm, bars and beats ("3:1" = bar 3, beat 1).',
        "--json (before or after the command): one JSON object on stdout; progress goes to stderr.",
        "Exit codes: 0 ok · 1 the scene is wrong · 2 the command line is wrong · 3 warnings with --strict · 4 ffmpeg/encoder/folder missing · 70 internal error",
        "All options of a command: studio-stickman help <command>",
    ]
    return "\n".join(lines)


def main(argv=None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    _Parser.json_wanted = "--json" in argv
    _repair_windows_path()
    p, subs = _build_parser()
    _Parser.command = next((a for a in argv if a in subs), None)
    args = p.parse_args(argv)
    if args.version:
        if args.json:
            _print_json({"ok": True, "command": "version", "version": __version__})
        else:
            print(f"studio-stickman {__version__}")
        return
    if args.usage_json:
        if args.json:
            _print_json({"ok": True, "command": "usage", "version": __version__, "commands": _usage_list(subs)})
        else:
            print(json.dumps({"version": __version__, "commands": _usage_list(subs)}, indent=1))
        return
    if args.help or not args.cmd:
        if args.json:
            _print_json(_help_json(None))
        else:
            print(_help(subs))
        return
    if args.cmd == "help":
        topic = getattr(args, "topic", None)
        if topic and topic not in subs:
            _report_failure(args, Fail(f'no command "{topic}"{registry.suggest(topic, subs)} (commands: {", ".join(subs)})', EXIT_USAGE, kind="usage"))
            sys.exit(EXIT_USAGE)
        if args.json:
            _print_json(_help_json(topic, subs[topic] if topic else None))
        else:
            print(subs[topic].format_help() if topic else _help(subs))
        return
    try:
        code = args.fn(args) or 0
    except Fail as f:
        _report_failure(args, f)
        sys.exit(f.code)
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001  (a clean message instead of a traceback)
        f = _classify(e, args)
        _report_failure(args, f)
        sys.exit(f.code)
    if code:
        sys.exit(code)


def _classify(e: Exception, args) -> Fail:
    """An exception no command caught, as a Fail with the right exit code: a wrapped plugin failure
    or a scene problem found while drawing is the scene's (exit 1); only the rest is a tool bug (70)."""
    from .scene import SceneError

    R = sys.modules.get(f"{__package__}.render")          # only loaded by commands that draw
    if isinstance(e, SceneError):
        return _scene_fail(e, getattr(args, "scene", None) or "scene")
    if R is not None and isinstance(e, R.RenderError):
        return _draw_fail(e, "render failed" if getattr(args, "cmd", None) == "render" else "drawing failed")
    loc = _plugin_location(e)
    if loc:
        return Fail(f"{type(e).__name__}: {e} (in {loc})", EXIT_SCENE, kind="plugin-failed", where=loc)
    if isinstance(e, (ValueError, TypeError, KeyError)):
        return Fail(f"{type(e).__name__}: {e} — probably a value of the wrong type in the scene", EXIT_SCENE, kind="invalid-value")
    import traceback

    fr = traceback.extract_tb(e.__traceback__)[-1]
    return Fail(f"internal error: {type(e).__name__}: {e} (at {Path(fr.filename).name}:{fr.lineno}) — please report it", EXIT_INTERNAL, kind="internal")
