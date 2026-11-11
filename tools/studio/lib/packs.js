'use strict';
/**
 * Read Studio packs from STUDIO_PACKS_PATH (no server needed).
 * Same rules as tools/studio/python/studio_packs.py and the server.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = ['./packs', '/data/packs/global', '/opt/studio/packs'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TYPES = ['music', '3d', 'image', 'video', 'general'];

function roots() {
  const raw = process.env.STUDIO_PACKS_PATH;
  return (raw ? raw.split(':').filter(Boolean) : DEFAULT_PATH).map((r) => path.resolve(r));
}

function scopeOf(root, meta) {
  if (meta && meta.scope) return meta.scope === 'user' ? 'mine' : meta.scope;
  if (root.startsWith('/opt/studio/')) return 'system';
  if (fs.existsSync(path.join(root, '..', 'CLAUDE.md'))) return 'project';
  return 'local';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadPack(root, dir) {
  const manifest = readJson(path.join(dir, 'pack.json'));
  if (!manifest || typeof manifest !== 'object') return null;
  let items = manifest.items;
  if (typeof items === 'string') items = readJson(path.join(dir, items)) || [];
  if (!Array.isArray(items)) items = [];
  const meta = readJson(path.join(dir, '.studio-meta.json')) || {};
  const index = readJson(path.join(dir, '.studio-index.json')) || {};
  return { id: manifest.id || path.basename(dir), dir, root, manifest, items, meta, index, scope: scopeOf(root, meta) };
}

function allPacks() {
  const seen = new Map();
  for (const root of roots()) {
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      const p = loadPack(root, path.join(root, name));
      if (p) seen.set(name, p);
    }
  }
  return [...seen.values()];
}

function findPack(id) {
  return allPacks().find((p) => p.id === id) || null;
}

function kinds(items) {
  const c = {};
  for (const it of items) c[it.kind] = (c[it.kind] || 0) + 1;
  return c;
}

function searchItems(query, { type, kind, limit = 50 } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of allPacks()) {
    if (type && p.manifest.type !== type) continue;
    for (const it of p.items) {
      if (kind && it.kind !== kind) continue;
      const hay = [it.id, it.name, it.kind, it.description, (it.tags || []).join(' '), p.id, p.manifest.name].join(' ').toLowerCase();
      if (words.every((w) => hay.includes(w))) {
        out.push({ pack: p, item: it });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function resolveRef(ref) {
  const m = /^([a-z0-9][a-z0-9._-]*)(?:\/([a-z0-9][a-z0-9._-]*))?$/.exec(String(ref || ''));
  if (!m) throw new Error(`"${ref}" is not a pack reference (pack-id or pack-id/item-id)`);
  const pack = findPack(m[1]);
  if (!pack) throw new Error(`pack "${m[1]}" not found (studio packs list)`);
  if (!m[2]) return { pack, item: null, file: pack.dir };
  const item = pack.items.find((i) => i.id === m[2]);
  if (!item) throw new Error(`pack "${pack.id}" has no item "${m[2]}" (studio packs show ${pack.id})`);
  return { pack, item, file: item.file ? path.resolve(pack.dir, item.file) : null };
}

/** Validate a pack folder: returns { ok, errors[], warnings[], manifest }. */
function validate(dir) {
  const errors = [];
  const warnings = [];
  const file = path.join(dir, 'pack.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`${file}: ${e.code === 'ENOENT' ? 'missing' : 'invalid JSON — ' + e.message}`], warnings };
  }
  if (!ID_RE.test(manifest.id || '')) errors.push('id: lowercase letters, digits, . _ - (max 64)');
  if (manifest.id && path.basename(path.resolve(dir)) !== manifest.id) errors.push(`the folder name must equal the id "${manifest.id}"`);
  if (!manifest.name) errors.push('name is required');
  if (!TYPES.includes(manifest.type)) errors.push(`type must be one of ${TYPES.join(', ')}`);
  let items = manifest.items;
  if (typeof items === 'string') {
    items = readJson(path.join(dir, items));
    if (!items) errors.push(`items file ${manifest.items} missing or invalid`);
  }
  if (!Array.isArray(items)) errors.push('items must be a list (or the path of a JSON file with the list)');
  const ids = new Set();
  for (const [i, it] of (Array.isArray(items) ? items : []).entries()) {
    const where = `items[${i}]${it && it.id ? ` (${it.id})` : ''}`;
    if (!it || typeof it !== 'object') { errors.push(`${where}: must be an object`); continue; }
    if (!ID_RE.test(it.id || '')) errors.push(`${where}: invalid id`);
    if (ids.has(it.id)) errors.push(`${where}: duplicate id`);
    ids.add(it.id);
    if (!it.kind) errors.push(`${where}: kind is required`);
    if (it.file) {
      const abs = path.resolve(dir, it.file);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) errors.push(`${where}: file must be inside the pack`);
      else if (!fs.existsSync(abs)) errors.push(`${where}: file not found: ${it.file}`);
    }
    if (it.kind === 'plugin' && !(it.meta && it.meta.target)) warnings.push(`${where}: plugin items should set meta.target (studio-daw / studio-3d)`);
  }
  if (!manifest.description) warnings.push('add a description — Claude reads it to decide when to use the pack');
  return { ok: errors.length === 0, errors, warnings, manifest };
}

function scaffold(dir, id, type, name) {
  if (!ID_RE.test(id)) throw new Error('id: lowercase letters, digits, . _ - (max 64)');
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  const target = path.join(dir, id);
  if (fs.existsSync(path.join(target, 'pack.json'))) throw new Error(`${target}/pack.json already exists`);
  fs.mkdirSync(target, { recursive: true });
  const manifest = {
    id, name: name || id.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), version: '0.1.0', type,
    description: 'What is in this pack and when to use it.', license: 'CC0-1.0', tags: [], docs: 'README.md', items: [],
  };
  fs.writeFileSync(path.join(target, 'pack.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'README.md'), `# ${manifest.name}\n\nHow to use this pack (examples for song/scene files).\n`);
  return target;
}

module.exports = { roots, allPacks, findPack, searchItems, resolveRef, validate, scaffold, kinds, TYPES };
