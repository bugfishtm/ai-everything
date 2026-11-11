// The scene file as the editor sees it: the object tree read from the YAML, and every edit as a
// surgical change of the text (comments and layout stay; see daw/yamlEdit.ts).
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { SongDoc as YamlDoc, type YPath } from '../daw/yamlEdit';
import type { Transform, Vec3 } from './types';

export { YamlDoc };
export type { YPath };

export type Kind = 'shape' | 'use' | 'model' | 'group' | 'boolean' | 'object';
type Spec = Record<string, unknown>;

export interface ObjNode {
  id: string; // the YAML path joined with dots — the same id the engine puts on the nodes of the .glb
  path: YPath;
  listPath: YPath; // the list this object is an item of
  index: number;
  spec: Spec;
  kind: Kind;
  label: string;
  type: string; // shape name, pack item, model file, "group", "difference" …
  children: ObjNode[];
  parent: ObjNode | null;
  operand: boolean; // an object inside a boolean
  depth: number;
}

/** Object keys that are not shape parameters (the engine's OBJ_KEYS; the catalog sends the current list). */
export const OBJECT_KEYS = new Set([
  'name', 'shape', 'model', 'use', 'group', 'boolean', 'params', 'position', 'rotation', 'scale', 'material', 'modifiers', 'repeat', 'scatter',
  'visible', 'note', 'uv', 'shading', 'smooth_angle',
]);

const KINDS: Kind[] = ['group', 'boolean', 'shape', 'use', 'model'];
export const isObj = (v: unknown): v is Spec => !!v && typeof v === 'object' && !Array.isArray(v);
const HEX = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export function kindOf(spec: Spec): Kind {
  return KINDS.find((k) => k in spec) ?? 'object';
}

function make(spec: unknown, path: YPath, listPath: YPath, index: number, parent: ObjNode | null, operand: boolean): ObjNode {
  const s = isObj(spec) ? spec : {};
  const kind = kindOf(s);
  const own = s[kind];
  const type = kind === 'group' ? 'group' : kind === 'boolean' ? String((isObj(own) && own.op) || 'difference') : typeof own === 'string' ? own : kind;
  const node: ObjNode = {
    id: path.join('.'),
    path,
    listPath,
    index,
    spec: s,
    kind,
    label: typeof s.name === 'string' && s.name ? s.name : typeof s.name === 'number' ? String(s.name) : type,
    type,
    children: [],
    parent,
    operand,
    depth: parent ? parent.depth + 1 : 0,
  };
  if (kind === 'group' && Array.isArray(own)) {
    const lp = [...path, 'group'];
    node.children = own.map((c, i) => make(c, [...lp, i], lp, i, node, false));
  } else if (kind === 'boolean' && isObj(own) && Array.isArray(own.objects)) {
    const lp = [...path, 'boolean', 'objects'];
    node.children = own.objects.map((c, i) => make(c, [...lp, i], lp, i, node, true));
  }
  return node;
}

export function readTree(doc: YamlDoc): ObjNode[] {
  const objects = doc.get(['objects']);
  return Array.isArray(objects) ? objects.map((s, i) => make(s, ['objects', i], ['objects'], i, null, false)) : [];
}

export function flatten(tree: ObjNode[]): ObjNode[] {
  const out: ObjNode[] = [];
  const walk = (n: ObjNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

/** Changes when objects are added, removed, moved or change their kind — then the ids of the last build no longer fit. */
export function signature(tree: ObjNode[]): string {
  return flatten(tree)
    .map((n) => `${n.id}:${n.kind}`)
    .join('|');
}

export const isAncestor = (a: ObjNode, of: ObjNode): boolean => {
  for (let p = of.parent; p; p = p.parent) if (p === a) return true;
  return false;
};

// ---- numbers and transforms ---------------------------------------------------------------
export function round(n: number, digits = 4): number {
  if (!Number.isFinite(n)) return 0;
  const k = 10 ** digits;
  return Math.round(n * k) / k + 0;
}

export function vec3(v: unknown, d: number): Vec3 {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v];
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return [v[0], v[1], v[2]];
  return [d, d, d];
}

export function transformOf(spec: Spec): Transform {
  return { position: vec3(spec.position, 0), rotation: vec3(spec.rotation, 0), scale: vec3(spec.scale, 1) };
}

/** The engine's transform: translation · rotation (x, then y, then z about fixed axes) · scale. */
export function composeMatrix(t: Transform): Matrix4 {
  const q = new Quaternion().setFromEuler(new Euler(MathUtils.degToRad(t.rotation[0]), MathUtils.degToRad(t.rotation[1]), MathUtils.degToRad(t.rotation[2]), 'ZYX'));
  return new Matrix4().compose(new Vector3(...t.position), q, new Vector3(...t.scale));
}

export function decomposeMatrix(m: Matrix4): Transform {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  const e = new Euler().setFromQuaternion(q, 'ZYX');
  return {
    position: [round(p.x), round(p.y), round(p.z)],
    rotation: [round(MathUtils.radToDeg(e.x), 2), round(MathUtils.radToDeg(e.y), 2), round(MathUtils.radToDeg(e.z), 2)],
    scale: [round(s.x), round(s.y), round(s.z)],
  };
}

export function worldMatrix(node: ObjNode | null): Matrix4 {
  const m = new Matrix4();
  const chain: ObjNode[] = [];
  for (let n = node; n; n = n.parent) chain.unshift(n);
  for (const n of chain) m.multiply(composeMatrix(transformOf(n.spec)));
  return m;
}

const same = (a: Vec3, b: Vec3) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

export function setTransform(doc: YamlDoc, path: YPath, t: Partial<Transform>): YamlDoc {
  let d = doc;
  for (const key of ['position', 'rotation', 'scale'] as const) {
    const v = t[key];
    if (!v) continue;
    const r: Vec3 = [round(v[0], key === 'rotation' ? 2 : 4), round(v[1], key === 'rotation' ? 2 : 4), round(v[2], key === 'rotation' ? 2 : 4)];
    const def: Vec3 = key === 'scale' ? [1, 1, 1] : [0, 0, 0];
    const has = d.has([...path, key]);
    if (same(r, def)) {
      if (has) d = d.delete([...path, key]);
    } else if (key === 'scale' && r[0] === r[1] && r[1] === r[2]) d = d.set([...path, key], r[0]);
    else d = d.set([...path, key], r);
  }
  return d;
}

export function setField(doc: YamlDoc, path: YPath, key: string, value: unknown): YamlDoc {
  return value === undefined ? doc.delete([...path, key]) : doc.set([...path, key], value);
}

// ---- shape parameters -----------------------------------------------------------------------
/** The parameters written for an object: inline keys that are not object keys, plus `params:`. */
export function paramsOf(spec: Spec): { values: Spec; inParams: Set<string> } {
  const values: Spec = {};
  const inParams = new Set<string>();
  for (const [k, v] of Object.entries(spec)) if (!OBJECT_KEYS.has(k)) values[k] = v;
  if (isObj(spec.params))
    for (const [k, v] of Object.entries(spec.params)) {
      values[k] = v;
      inParams.add(k);
    }
  return { values, inParams };
}

export function setParam(doc: YamlDoc, node: ObjNode, key: string, value: unknown): YamlDoc {
  const { inParams } = paramsOf(node.spec);
  // a parameter with the name of an object key (terrain: scale) can only live under params:
  const nested = inParams.has(key) || OBJECT_KEYS.has(key);
  if (value === undefined) {
    if (!nested) return doc.delete([...node.path, key]);
    const d = doc.delete([...node.path, 'params', key]);
    const left = d.get([...node.path, 'params']);
    return isObj(left) && !Object.keys(left).length ? d.delete([...node.path, 'params']) : d;
  }
  return doc.set(nested ? [...node.path, 'params', key] : [...node.path, key], value);
}

// ---- lists: add, remove, move ---------------------------------------------------------------
const startsWith = (p: YPath, prefix: YPath) => prefix.length < p.length && prefix.every((x, i) => p[i] === x);

/** A path after an item was inserted at listPath[index]. */
function afterInsert(p: YPath, listPath: YPath, index: number): YPath {
  if (!startsWith(p, listPath)) return p;
  const i = p[listPath.length];
  return typeof i === 'number' && i >= index ? [...p.slice(0, listPath.length), i + 1, ...p.slice(listPath.length + 1)] : p;
}

/** A path after the item listPath[index] was removed. */
function afterDelete(p: YPath, listPath: YPath, index: number): YPath {
  if (!startsWith(p, listPath)) return p;
  const i = p[listPath.length];
  return typeof i === 'number' && i > index ? [...p.slice(0, listPath.length), i - 1, ...p.slice(listPath.length + 1)] : p;
}

export function uniqueName(tree: ObjNode[], base: string): string {
  const names = new Set(flatten(tree).map((n) => n.label));
  const stem = base.replace(/-\d+$/, '') || 'object';
  if (!names.has(stem)) return stem;
  for (let i = 2; ; i++) if (!names.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

function childList(node: ObjNode): YPath | null {
  if (node.kind === 'group') return [...node.path, 'group'];
  if (node.kind === 'boolean') return [...node.path, 'boolean', 'objects'];
  return null;
}

export interface Edit {
  doc: YamlDoc;
  select?: string[];
}

/** Add an object at the end of a group (or of the scene). */
export function addObject(doc: YamlDoc, tree: ObjNode[], into: ObjNode | null, spec: Spec): Edit {
  const listPath = (into && childList(into)) || ['objects'];
  const count = into ? into.children.length : tree.length;
  const d = doc.seqInsert(listPath, count, spec, true);
  return { doc: d, select: [[...listPath, count].join('.')] };
}

/** Remove objects (children of removed objects go with them). */
export function removeObjects(doc: YamlDoc, nodes: ObjNode[]): Edit {
  const top = nodes.filter((n) => !nodes.some((o) => o !== n && isAncestor(o, n)));
  // from the back of the document, so the paths of the others stay valid
  top.sort((a, b) => comparePaths(b.path, a.path));
  let d = doc;
  for (const n of top) d = d.seqDelete(n.listPath, n.index);
  return { doc: d, select: [] };
}

function comparePaths(a: YPath, b: YPath): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (typeof a[i] === 'number' && typeof b[i] === 'number') return (a[i] as number) - (b[i] as number);
    return String(a[i]) < String(b[i]) ? -1 : 1;
  }
  return a.length - b.length;
}

export function duplicate(doc: YamlDoc, tree: ObjNode[], node: ObjNode): Edit {
  const spec: Spec = JSON.parse(JSON.stringify(node.spec));
  spec.name = uniqueName(tree, node.label);
  if (!node.operand) {
    const p = vec3(spec.position, 0);
    spec.position = [round(p[0] + 1), p[1], p[2]];
  }
  const d = doc.seqInsert(node.listPath, node.index + 1, ordered(spec), true);
  return { doc: d, select: [[...node.listPath, node.index + 1].join('.')] };
}

/** name first, then what the object is, then the rest — the order people write scene files in. */
function ordered(spec: Spec): Spec {
  const out: Spec = {};
  for (const k of ['name', 'shape', 'use', 'model', 'boolean']) if (k in spec) out[k] = spec[k];
  for (const [k, v] of Object.entries(spec)) if (!(k in out) && k !== 'group') out[k] = v;
  if ('group' in spec) out.group = spec.group;
  return out;
}

export function moveInList(doc: YamlDoc, node: ObjNode, to: number): Edit {
  return { doc: doc.seqMove(node.listPath, node.index, to), select: [[...node.listPath, to].join('.')] };
}

/**
 * Move an object into another group (or to the scene's top level) at `index`, keeping where it is in the world.
 * Operands of booleans stay in their boolean (they can only be reordered).
 */
export function reparent(doc: YamlDoc, tree: ObjNode[], node: ObjNode, target: ObjNode | null, index?: number): Edit {
  if (target && (target === node || isAncestor(node, target))) throw new Error('an object cannot be moved into itself');
  if (target && target.kind !== 'group') throw new Error('objects can only be moved into groups');
  if (node.operand) throw new Error('a part of a boolean stays in its boolean');
  const listPath = target ? [...target.path, 'group'] : ['objects'];
  const count = target ? target.children.length : tree.length;
  const sameList = listPath.join('.') === node.listPath.join('.');
  let at = index === undefined ? count : Math.max(0, Math.min(index, count));
  if (sameList) {
    if (at > node.index) at -= 1;
    return at === node.index ? { doc, select: [node.id] } : moveInList(doc, node, Math.min(at, count - 1));
  }
  const local = new Matrix4().copy(worldMatrix(target)).invert().multiply(worldMatrix(node));
  const spec: Spec = JSON.parse(JSON.stringify(node.spec));
  delete spec.position;
  delete spec.rotation;
  delete spec.scale;
  let d = doc.seqInsert(listPath, at, ordered(spec), true);
  d = setTransform(d, [...listPath, at], decomposeMatrix(local));
  const src = afterInsert(node.path, listPath, at);
  const srcList = src.slice(0, -1);
  const srcIndex = src[src.length - 1] as number;
  d = d.seqDelete(srcList, srcIndex);
  return { doc: d, select: [afterDelete([...listPath, at], srcList, srcIndex).join('.')] };
}

function siblings(nodes: ObjNode[]): ObjNode[] {
  if (!nodes.length) throw new Error('select objects first');
  const lp = nodes[0].listPath.join('.');
  if (nodes.some((n) => n.listPath.join('.') !== lp)) throw new Error('select objects of the same group (the same level in the list)');
  if (nodes.some((n) => n.operand)) throw new Error('parts of a boolean cannot be regrouped');
  return [...nodes].sort((a, b) => a.index - b.index);
}

/** Wrap objects of one list into a new group (the group sits at the origin of their parent, so nothing moves). */
export function groupNodes(doc: YamlDoc, tree: ObjNode[], nodes: ObjNode[]): Edit {
  const sel = siblings(nodes);
  const group: Spec = { name: uniqueName(tree, 'group'), group: sel.map((n) => n.spec) };
  let d = doc;
  for (const n of [...sel].reverse()) d = d.seqDelete(n.listPath, n.index);
  d = d.seqInsert(sel[0].listPath, sel[0].index, group, true);
  return { doc: d, select: [[...sel[0].listPath, sel[0].index].join('.')] };
}

/** Replace a group by its children; they keep their place in the world. */
export function ungroup(doc: YamlDoc, node: ObjNode): Edit {
  if (node.kind !== 'group') throw new Error('select a group');
  if (node.spec.repeat || node.spec.scatter) throw new Error('this group is repeated or scattered — remove repeat/scatter first');
  const g = composeMatrix(transformOf(node.spec));
  const identity = g.equals(new Matrix4());
  let d = doc.seqDelete(node.listPath, node.index);
  const ids: string[] = [];
  node.children.forEach((c, i) => {
    const spec: Spec = JSON.parse(JSON.stringify(c.spec));
    if (node.spec.material !== undefined && spec.material === undefined) spec.material = node.spec.material;
    const at = node.index + i;
    if (identity) d = d.seqInsert(node.listPath, at, ordered(spec), true);
    else {
      const m = new Matrix4().copy(g).multiply(composeMatrix(transformOf(c.spec)));
      delete spec.position;
      delete spec.rotation;
      delete spec.scale;
      d = d.seqInsert(node.listPath, at, ordered(spec), true);
      d = setTransform(d, [...node.listPath, at], decomposeMatrix(m));
    }
    ids.push([...node.listPath, at].join('.'));
  });
  return { doc: d, select: ids };
}

/** Combine objects into one boolean: the first is the base, the others are added to / cut out of it. */
export function booleanFrom(doc: YamlDoc, tree: ObjNode[], nodes: ObjNode[], op: 'difference' | 'union' | 'intersection'): Edit {
  const sel = siblings(nodes);
  if (sel.length < 2) throw new Error('select at least two objects: the first is the base, the others are cut out of it');
  if (sel.some((n) => n.kind === 'group')) throw new Error('groups cannot be parts of a boolean — ungroup first');
  if (sel.some((n) => n.spec.repeat || n.spec.scatter)) throw new Error('repeated or scattered objects cannot be parts of a boolean');
  const first = sel[0];
  const parts = sel.map((n) => {
    const s: Spec = { ...n.spec };
    delete s.material;
    delete s.visible;
    return s;
  });
  const suffix = op === 'difference' ? 'cut' : op === 'union' ? 'joined' : 'overlap';
  const spec: Spec = { name: uniqueName(tree, first.label === first.type ? 'solid' : `${first.label}-${suffix}`), boolean: { op, objects: parts } };
  if (first.spec.material !== undefined) spec.material = first.spec.material;
  let d = doc;
  for (const n of [...sel].reverse()) d = d.seqDelete(n.listPath, n.index);
  d = d.seqInsert(first.listPath, first.index, spec, true);
  return { doc: d, select: [[...first.listPath, first.index].join('.')] };
}

// ---- materials ------------------------------------------------------------------------------------
/** A material definition as a mapping: `door: dark-wood` → { use: dark-wood }, `x: "#ff0000"` → { color }. */
export function materialSpec(raw: unknown): Spec {
  if (isObj(raw)) return raw;
  if (typeof raw === 'string') return HEX.test(raw) ? { color: raw } : { use: raw };
  return {};
}

export function materialNames(doc: YamlDoc): string[] {
  const m = doc.get(['materials']);
  return isObj(m) ? Object.keys(m) : [];
}

export function setMaterialKey(doc: YamlDoc, name: string, key: string, value: unknown): YamlDoc {
  const raw = doc.get(['materials', name]);
  if (isObj(raw)) return value === undefined ? doc.delete(['materials', name, key]) : doc.set(['materials', name, key], value);
  const next: Spec = { ...materialSpec(raw) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return doc.set(['materials', name], next);
}

export function addMaterial(doc: YamlDoc, name: string, spec: Spec): YamlDoc {
  if (materialNames(doc).includes(name)) throw new Error(`the material "${name}" already exists`);
  return doc.set(['materials', name], spec);
}

/** Objects (at any depth) that use a material by name. */
export function usedBy(tree: ObjNode[], name: string): ObjNode[] {
  return flatten(tree).filter((n) => n.spec.material === name);
}

export function renameMaterial(doc: YamlDoc, tree: ObjNode[], from: string, to: string): YamlDoc {
  if (!to || to === from) return doc;
  if (materialNames(doc).includes(to)) throw new Error(`the material "${to}" already exists`);
  let d = doc.renameKey(['materials'], from, to);
  for (const n of usedBy(tree, from)) d = d.set([...n.path, 'material'], to);
  for (const other of materialNames(d)) {
    const raw = d.get(['materials', other]);
    if (raw === from) d = d.set(['materials', other], to);
    else if (isObj(raw) && raw.use === from) d = d.set(['materials', other, 'use'], to);
  }
  return d;
}

export function deleteMaterial(doc: YamlDoc, tree: ObjNode[], name: string): YamlDoc {
  let d = doc;
  for (const n of usedBy(tree, name)) d = d.delete([...n.path, 'material']);
  return d.delete(['materials', name]);
}

export function validName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error('enter a name');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/.test(n)) throw new Error('names: letters, digits, spaces, - _ . (starting with a letter or digit)');
  return n;
}
