"""Find Studio packs and their items — shared by studio-daw, studio-3d and future tools.

Packs are folders with a pack.json manifest (see packs/README.md). They are searched
in the directories of STUDIO_PACKS_PATH (colon separated, first match wins); the
Studio sets it to: <project>/packs, personal packs, Global Space packs, system packs.

    from studio_packs import resolve, find_pack, all_packs, search_items
    pack, item, path = resolve("gm-instruments/acoustic-grand-piano")
"""
from __future__ import annotations

import difflib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PATH = ["./packs", "/data/packs/global", "/opt/studio/packs"]
REF_RE = re.compile(r"^([a-z0-9][a-z0-9._-]*)/([a-z0-9][a-z0-9._-]*)$")


class PackError(Exception):
    pass


def pack_roots() -> list[Path]:
    raw = os.environ.get("STUDIO_PACKS_PATH")
    roots = [p for p in raw.split(":") if p] if raw else DEFAULT_PATH
    return [Path(r) for r in roots]


@dataclass
class Pack:
    root: Path
    dir: Path
    manifest: dict
    items: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)
    index: dict = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.manifest["id"]

    @property
    def type(self) -> str:
        return self.manifest.get("type", "general")

    @property
    def scope(self) -> str:
        return self.meta.get("scope") or ("system" if str(self.dir).startswith("/opt/studio/") else "project" if self.root.name == "packs" and (self.root.parent / "CLAUDE.md").exists() else "local")

    @property
    def code_allowed(self) -> bool:
        """Plugin code of Global Space packs runs only after an admin reviewed it."""
        return not (self.meta.get("scope") == "global" and not self.meta.get("trusted"))

    def item(self, item_id: str) -> dict:
        it = self.items.get(item_id)
        if it is None:
            close = difflib.get_close_matches(item_id, list(self.items), n=3)
            hint = f" — did you mean {', '.join(close)}?" if close else f" — see: studio packs show {self.id}"
            raise PackError(f'pack "{self.id}" has no item "{item_id}"{hint}')
        return it

    def file(self, item: dict) -> Path | None:
        f = item.get("file")
        if not f:
            return None
        p = (self.dir / f).resolve() if not str(f).startswith("/") else Path(f)
        return p

    def media(self, item_id: str) -> dict:
        return self.index.get(item_id, {})


_cache: dict[str, Pack | None] = {}


def _load(root: Path, d: Path) -> Pack | None:
    mf = d / "pack.json"
    if not mf.is_file():
        return None
    try:
        manifest = json.loads(mf.read_text("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise PackError(f"{mf}: invalid JSON ({e})") from e
    items = manifest.get("items", [])
    if isinstance(items, str):
        items = json.loads((d / items).read_text("utf-8"))
    meta, index = {}, {}
    for name, target in ((".studio-meta.json", "meta"), (".studio-index.json", "index")):
        try:
            data = json.loads((d / name).read_text("utf-8"))
            if target == "meta":
                meta = data
            else:
                index = data
        except Exception:  # noqa: BLE001
            pass
    return Pack(root=root, dir=d, manifest=manifest, items={it["id"]: it for it in items if "id" in it}, meta=meta, index=index)


def find_pack(pack_id: str) -> Pack | None:
    if pack_id in _cache:
        return _cache[pack_id]
    found = None
    for root in pack_roots():
        d = root / pack_id
        if (d / "pack.json").is_file():
            found = _load(root, d)
            break
    _cache[pack_id] = found
    return found


def all_packs() -> list[Pack]:
    seen: dict[str, Pack] = {}
    for root in pack_roots():
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if d.is_dir() and not d.name.startswith(".") and d.name not in seen:
                try:
                    p = _load(root, d)
                except PackError:
                    continue
                if p:
                    seen[d.name] = p
    return list(seen.values())


def is_ref(text: str) -> bool:
    return bool(REF_RE.match(text or ""))


def resolve(ref: str) -> tuple[Pack, dict, Path | None]:
    """'pack-id/item-id' -> (pack, item, absolute file path or None)."""
    m = REF_RE.match(ref or "")
    if not m:
        raise PackError(f'"{ref}" is not a pack reference (expected pack-id/item-id)')
    pack = find_pack(m.group(1))
    if pack is None:
        ids = [p.id for p in all_packs()]
        close = difflib.get_close_matches(m.group(1), ids, n=3)
        hint = f" — did you mean {', '.join(close)}?" if close else " — list packs with: studio packs list"
        raise PackError(f'pack "{m.group(1)}" not found{hint}')
    item = pack.item(m.group(2))
    return pack, item, pack.file(item)


def search_items(query: str = "", type: str | None = None, kind: str | None = None, limit: int = 50) -> list[tuple[Pack, dict]]:
    words = [w for w in query.lower().split() if w]
    out = []
    for p in all_packs():
        if type and p.type != type:
            continue
        for it in p.items.values():
            if kind and it.get("kind") != kind:
                continue
            hay = " ".join([it["id"], it.get("name", ""), it.get("kind", ""), it.get("description", ""), " ".join(it.get("tags", [])), p.id]).lower()
            if all(w in hay for w in words):
                out.append((p, it))
                if len(out) >= limit:
                    return out
    return out
