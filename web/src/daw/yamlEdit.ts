// Surgical edits of a song file: every change replaces only the text of the touched node, so
// comments, alignment and everything else in the file stay exactly as they were (small git diffs,
// and the file stays as readable for people and for Claude as it was written).
import { isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';

export type YPath = (string | number)[];
type AnyNode = Node & { range?: [number, number, number] | null };

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

export function numStr(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

export function scalarStr(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numStr(v);
  const s = String(v);
  if (
    /^[A-Za-z_][A-Za-z0-9_ ./#+@-]*$/.test(s) &&
    !RESERVED.test(s) &&
    !/\s$/.test(s) &&
    !/ #/.test(s) &&
    !/^[-+]?(\d|\.\d)/.test(s)
  )
    return s;
  if (/^\d+\/\d+$/.test(s)) return s; // time signatures like 4/4
  return JSON.stringify(s);
}

function keyStr(k: string | number): string {
  const s = String(k);
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && !RESERVED.test(s) ? s : JSON.stringify(s);
}

export function formatInline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(formatInline).join(', ')}]`;
  if (v && typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return e.length ? `{ ${e.map(([k, x]) => `${keyStr(k)}: ${formatInline(x)}`).join(', ')} }` : '{}';
  }
  return scalarStr(v);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const multiline = (v: unknown): boolean =>
  typeof v === 'string' ? v.includes('\n') : Array.isArray(v) ? v.some(multiline) : isPlainObject(v) ? Object.values(v).some(multiline) : false;

export type Style = 'auto' | 'flow' | 'block';

/** Text after "key:" in a block mapping with the key at column `indent`. */
export function formatBlock(v: unknown, indent: number, style: Style = 'auto'): string {
  const pad = ' '.repeat(indent + 2);
  if (typeof v === 'string' && (v.includes('\n') || (style === 'block' && v.length > 0))) {
    const lines = v.replace(/\n$/, '').split('\n');
    if (lines.some((l) => /^\s/.test(l)) || /[\t]/.test(v)) return ` ${JSON.stringify(v)}`;
    const chomp = v.endsWith('\n') ? '|' : '|-';
    return ` ${chomp}\n${lines.map((l) => (l ? pad + l : '')).join('\n')}`;
  }
  if (isPlainObject(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    const inline = formatInline(v);
    if (style === 'flow' || (style === 'auto' && !multiline(v) && inline.length <= 110)) return ` ${inline}`;
    if (!entries.length) return ' {}';
    return `\n${entries.map(([k, x]) => `${pad}${keyStr(k)}:${formatBlock(x, indent + 2, style === 'block' ? 'auto' : style)}`).join('\n')}`;
  }
  if (Array.isArray(v)) {
    const long = formatInline(v).length > (v.every((x) => typeof x === 'string') ? 80 : 110);
    if (style === 'block' || (style === 'auto' && (v.some(isPlainObject) || v.every((x) => typeof x === 'string')) && long) || multiline(v)) {
      if (!v.length) return ' []';
      return `\n${v
        .map((x) => {
          if (typeof x === 'string' && x.includes('\n')) {
            const lines = x.replace(/\n$/, '').split('\n');
            return `${pad}- ${x.endsWith('\n') ? '|' : '|-'}\n${lines.map((l) => (l ? `${pad}  ${l}` : '')).join('\n')}`;
          }
          return `${pad}- ${formatInline(x)}`;
        })
        .join('\n')}`;
    }
    return ` ${formatInline(v)}`;
  }
  return ` ${scalarStr(v)}`;
}

export class YamlEditError extends Error {}

export class SongDoc {
  readonly text: string;
  readonly doc: Document.Parsed;

  constructor(text: string) {
    this.text = text;
    this.doc = parseDocument(text, { uniqueKeys: false, prettyErrors: false });
  }

  get errors(): string[] {
    return this.doc.errors.map((e) => e.message);
  }

  get(path: YPath): unknown {
    const v = this.doc.getIn(path);
    return v && typeof v === 'object' && 'toJSON' in (v as object) ? (v as { toJSON(): unknown }).toJSON() : v;
  }

  node(path: YPath): AnyNode | undefined {
    if (!path.length) return (this.doc.contents ?? undefined) as AnyNode | undefined;
    return this.doc.getIn(path, true) as AnyNode | undefined;
  }

  has(path: YPath): boolean {
    return this.doc.hasIn(path);
  }

  /** Raw source text of a scalar (e.g. a grid as written). */
  source(path: YPath): string | undefined {
    const n = this.node(path);
    return isScalar(n) && typeof n.value === 'string' ? n.value : undefined;
  }

  // ---- helpers -------------------------------------------------------------
  private lineStart(pos: number): number {
    return this.text.lastIndexOf('\n', pos - 1) + 1;
  }

  private lineEnd(pos: number): number {
    const i = this.text.indexOf('\n', pos);
    return i < 0 ? this.text.length : i;
  }

  private col(pos: number): number {
    return pos - this.lineStart(pos);
  }

  private splice(start: number, end: number, insert: string): SongDoc {
    const text = this.text.slice(0, start) + insert + this.text.slice(end);
    const next = new SongDoc(text);
    if (next.errors.length && !this.errors.length) throw new YamlEditError(`edit produced invalid YAML: ${next.errors[0]}`);
    return next;
  }

  private pairOf(map: YAMLMap, key: string | number): Pair | undefined {
    return map.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === String(key)) as Pair | undefined;
  }

  /** End of a pair (after its value / trailing comment), at a line end for block maps. */
  private pairEnd(p: Pair): number {
    const v = p.value as AnyNode | null;
    const k = p.key as AnyNode;
    const end = v?.range ? Math.max(v.range[2], v.range[1]) : (k.range?.[2] ?? 0);
    return end;
  }

  private colonAfter(keyNode: AnyNode): number {
    const i = this.text.indexOf(':', keyNode.range![1]);
    if (i < 0) throw new YamlEditError('no ":" after key');
    return i;
  }

  // ---- set -----------------------------------------------------------------
  set(path: YPath, value: unknown, style: Style = 'auto'): SongDoc {
    if (value === undefined) return this.delete(path);
    // deepest existing collection on the path
    let i = 0;
    let cur: AnyNode | undefined = this.node([]);
    while (i < path.length - 1) {
      const next = this.childOf(cur, path[i]);
      if (!next || !(isMap(next) || isSeq(next))) break;
      cur = next;
      i++;
    }
    // build the missing part of the tree as a plain value
    let val: unknown = value;
    for (let j = path.length - 1; j > i; j--) val = { [String(path[j])]: val };
    return this.setChild(cur, path.slice(0, i), path[i], val, style);
  }

  private childOf(parent: AnyNode | undefined, key: string | number): AnyNode | undefined {
    if (isMap(parent)) return (this.pairOf(parent, key)?.value ?? undefined) as AnyNode | undefined;
    if (isSeq(parent) && typeof key === 'number') return parent.items[key] as AnyNode | undefined;
    return undefined;
  }

  private setChild(parent: AnyNode | undefined, parentPath: YPath, key: string | number, value: unknown, style: Style): SongDoc {
    if (!parent || parent === (this.doc.contents as AnyNode) && !isMap(parent)) {
      if (parent && !isMap(parent) && !(isScalar(parent) && parent.value === null)) throw new YamlEditError('the song file is not a mapping');
      // empty document
      const body = `${keyStr(key)}:${formatBlock(value, 0, style)}\n`;
      const prefix = this.text.trim() ? `${this.text.replace(/\s*$/, '')}\n` : '';
      return new SongDoc(prefix + body);
    }
    if (isMap(parent)) {
      const pair = this.pairOf(parent, key);
      if (pair) return this.replacePairValue(parent, pair, value, style);
      return this.insertPair(parent, key, value, style);
    }
    if (isSeq(parent)) {
      if (typeof key !== 'number') throw new YamlEditError(`${parentPath.join('.')} is a list`);
      const item = parent.items[key] as AnyNode | undefined;
      if (!item?.range) {
        if (key === parent.items.length) return this.seqInsert(parentPath, key, value);
        throw new YamlEditError('list index out of range');
      }
      return this.splice(item.range[0], item.range[1], formatInline(value));
    }
    // scalar (e.g. "mix:" without value, or "bass: bass") → becomes a map
    const pp = parentPath.slice(0, -1);
    const pk = parentPath[parentPath.length - 1];
    const cur = this.get(parentPath);
    const base = isPlainObject(cur) ? cur : {};
    return this.set([...pp, pk], { ...base, [String(key)]: value }, style === 'auto' && pp.length === 0 ? 'block' : style);
  }

  private replacePairValue(map: YAMLMap, pair: Pair, value: unknown, style: Style): SongDoc {
    const keyNode = pair.key as AnyNode;
    const node = pair.value as AnyNode | null;
    if (map.flow) {
      const rep = formatInline(value);
      if (node?.range && node.range[1] > node.range[0]) return this.splice(node.range[0], node.range[1], rep);
      const colon = this.colonAfter(keyNode);
      return this.splice(colon + 1, node?.range ? node.range[1] : colon + 1, ` ${rep}`);
    }
    const indent = this.col(keyNode.range![0]);
    const empty = !node?.range || node.range[1] <= node.range[0] || (isScalar(node) && node.value === null && !String(node.source ?? '').length);
    const oldBlock = !!node && ((isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')) || ((isMap(node) || isSeq(node)) && !node.flow));
    let st = style;
    if (st === 'auto' && node && (isMap(node) || isSeq(node)) && isPlainObject(value) === isMap(node)) st = node.flow ? 'flow' : 'auto';
    const rep = formatBlock(value, indent, st);
    const repInline = !rep.includes('\n');
    if (!empty && !oldBlock && repInline) return this.splice(node!.range![0], node!.range![1], rep.slice(1));
    const colon = this.colonAfter(keyNode);
    let end = empty ? colon + 1 : oldBlock ? node!.range![1] : node!.range![2];
    if (end > colon + 1 && this.text[end - 1] === '\n') end--;
    return this.splice(colon + 1, Math.max(end, colon + 1), rep);
  }

  private insertPair(map: YAMLMap, key: string | number, value: unknown, style: Style): SongDoc {
    const items = map.items as Pair[];
    if (map.flow) {
      const rep = `${keyStr(key)}: ${formatInline(value)}`;
      if (!items.length) {
        const r = (map as AnyNode).range!;
        return this.splice(r[0], r[1], `{ ${rep} }`);
      }
      const last = items[items.length - 1];
      const lv = (last.value as AnyNode | null)?.range;
      const at = lv && lv[1] > lv[0] ? lv[1] : (last.key as AnyNode).range![1];
      return this.splice(at, at, `, ${rep}`);
    }
    if (!items.length) throw new YamlEditError('empty block map');
    const first = items[0].key as AnyNode;
    const indent = this.col(first.range![0]);
    const end = this.pairEnd(items[items.length - 1]);
    let at: number;
    let prefix = '';
    if (this.text[end - 1] === '\n') at = end;
    else {
      at = this.lineEnd(end);
      if (at >= this.text.length) prefix = '\n';
      else at += 1;
    }
    const line = `${prefix}${' '.repeat(indent)}${keyStr(key)}:${formatBlock(value, indent, style)}\n`;
    return this.splice(at, at, line);
  }

  // ---- delete ----------------------------------------------------------------
  delete(path: YPath): SongDoc {
    if (!path.length) throw new YamlEditError('cannot delete the document');
    const parentPath = path.slice(0, -1);
    const key = path[path.length - 1];
    const parent = this.node(parentPath);
    if (isSeq(parent) && typeof key === 'number') return this.seqDelete(parentPath, key);
    if (!isMap(parent)) return this;
    const pair = this.pairOf(parent, key);
    if (!pair) return this;
    const items = parent.items as Pair[];
    const idx = items.indexOf(pair);
    const kr = (pair.key as AnyNode).range!;
    if (parent.flow) {
      if (items.length === 1) {
        const r = (parent as AnyNode).range!;
        return this.splice(r[0], r[1], '{}');
      }
      if (idx < items.length - 1) return this.splice(kr[0], (items[idx + 1].key as AnyNode).range![0], '');
      const prev = items[idx - 1];
      const pv = (prev.value as AnyNode | null)?.range;
      const from = pv && pv[1] > pv[0] ? pv[1] : (prev.key as AnyNode).range![1];
      const vr = (pair.value as AnyNode | null)?.range;
      return this.splice(from, vr ? vr[1] : kr[1], '');
    }
    if (items.length === 1 && parentPath.length) return this.set(parentPath, {}, 'flow');
    const start = this.lineStart(kr[0]);
    let end = this.pairEnd(pair);
    if (this.text[end - 1] !== '\n') end = Math.min(this.text.length, this.lineEnd(end) + 1);
    return this.splice(start, end, '');
  }

  renameKey(mapPath: YPath, oldKey: string, newKey: string): SongDoc {
    const map = this.node(mapPath);
    if (!isMap(map)) throw new YamlEditError(`${mapPath.join('.')} is not a mapping`);
    const pair = this.pairOf(map, oldKey);
    if (!pair) throw new YamlEditError(`no "${oldKey}" in ${mapPath.join('.') || 'the song'}`);
    if (this.pairOf(map, newKey)) throw new YamlEditError(`"${newKey}" already exists`);
    const r = (pair.key as AnyNode).range!;
    return this.splice(r[0], r[1], keyStr(newKey));
  }

  // ---- lists ---------------------------------------------------------------
  private seqInfo(path: YPath): YAMLSeq | null {
    const n = this.node(path);
    return isSeq(n) ? n : null;
  }

  /** One list item written over several lines ("- key: value" + more keys below it). */
  private blockItem(value: Record<string, unknown>, indent: number): string {
    const pad = ' '.repeat(indent);
    const entries = Object.entries(value).filter(([, x]) => x !== undefined);
    return `${entries.map(([k, x], i) => `${pad}${i === 0 ? '- ' : '  '}${keyStr(k)}:${formatBlock(x, indent + 2)}`).join('\n')}\n`;
  }

  /** Insert a list item. `block`: a mapping is written over several lines when it would be a long line. */
  seqInsert(path: YPath, index: number, value: unknown, block = false): SongDoc {
    const seq = this.seqInfo(path);
    if (!seq) {
      const cur = this.get(path);
      const arr = Array.isArray(cur) ? [...cur] : cur === undefined || cur === null ? [] : [cur];
      arr.splice(index, 0, value);
      return this.set(path, arr, path.length === 1 ? 'block' : 'auto');
    }
    if (seq.flow || !seq.items.length) {
      const arr = (this.get(path) as unknown[]) ?? [];
      arr.splice(index, 0, value);
      return this.replaceSeq(path, seq, arr);
    }
    const items = seq.items as AnyNode[];
    const firstLine = this.lineStart(items[0].range![0]);
    const dash = this.text.indexOf('-', firstLine);
    const indent = dash - firstLine;
    const long = block && isPlainObject(value) && Object.keys(value).length > 0 && (formatInline(value).length + indent > 100 || multiline(value));
    const line = long ? this.blockItem(value as Record<string, unknown>, indent) : `${' '.repeat(indent)}- ${formatInline(value)}\n`;
    if (index < items.length) {
      const at = this.lineStart(items[index].range![0]);
      return this.splice(at, at, line);
    }
    const last = items[items.length - 1];
    let end = Math.max(last.range![1], last.range![2]);
    let prefix = '';
    if (this.text[end - 1] !== '\n') {
      end = this.lineEnd(end);
      if (end >= this.text.length) prefix = '\n';
      else end += 1;
    }
    return this.splice(end, end, prefix + line);
  }

  private itemSpans(seq: YAMLSeq): [number, number][] {
    const items = seq.items as AnyNode[];
    return items.map((it, i) => {
      const start = this.lineStart(it.range![0]);
      let end: number;
      if (i < items.length - 1) end = this.lineStart(items[i + 1].range![0]);
      else {
        end = Math.max(it.range![1], it.range![2]);
        if (this.text[end - 1] !== '\n') end = Math.min(this.text.length, this.lineEnd(end) + 1);
      }
      return [start, end];
    });
  }

  private replaceSeq(path: YPath, seq: YAMLSeq, arr: unknown[]): SongDoc {
    const r = (seq as AnyNode).range!;
    if (seq.flow) return this.splice(r[0], r[1], formatInline(arr));
    return this.set(path, arr, 'block');
  }

  seqDelete(path: YPath, index: number): SongDoc {
    const seq = this.seqInfo(path);
    if (!seq || index < 0 || index >= seq.items.length) return this;
    if (seq.flow || seq.items.length === 1) {
      const arr = (this.get(path) as unknown[]) ?? [];
      arr.splice(index, 1);
      return this.replaceSeq(path, seq, arr);
    }
    const [s, e] = this.itemSpans(seq)[index];
    return this.splice(s, e, '');
  }

  seqMove(path: YPath, from: number, to: number): SongDoc {
    const seq = this.seqInfo(path);
    if (!seq || from === to || from < 0 || to < 0 || from >= seq.items.length || to >= seq.items.length) return this;
    if (seq.flow) {
      const arr = (this.get(path) as unknown[]) ?? [];
      const [x] = arr.splice(from, 1);
      arr.splice(to, 0, x);
      return this.replaceSeq(path, seq, arr);
    }
    const spans = this.itemSpans(seq);
    const texts = spans.map(([s, e]) => {
      const t = this.text.slice(s, e);
      return t.endsWith('\n') ? t : `${t}\n`;
    });
    const [x] = texts.splice(from, 1);
    texts.splice(to, 0, x);
    const start = spans[0][0];
    const end = spans[spans.length - 1][1];
    let joined = texts.join('');
    if (!this.text.slice(start, end).endsWith('\n')) joined = joined.replace(/\n$/, '');
    return this.splice(start, end, joined);
  }
}
