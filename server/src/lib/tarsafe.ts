/**
 * Safe tar extraction for archives produced by untrusted users (published websites).
 *
 * The Studio extracts as root, so the archive is treated as hostile input:
 *  - only regular files and directories are created, everything else (symlinks,
 *    hard links, devices, FIFOs …) is skipped;
 *  - names are validated (no absolute paths, no "..", no control characters) and
 *    every write happens below a destination folder that this function creates
 *    fresh — it never contains symlinks, so nothing can redirect a write;
 *  - files are opened with O_CREAT|O_EXCL ("wx") and get fixed modes (0644/0755);
 *  - total size and file count are limited (TarLimitError).
 * Understands ustar, GNU (long names "L") and pax ("x") headers.
 */
import type { FileHandle } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface ExtractOptions {
  maxBytes: number;
  maxFiles: number;
  /** relative POSIX path (no leading "./") → keep it? Folders are asked too (isDir). */
  filter?: (rel: string, isDir: boolean) => boolean;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
}

export class TarLimitError extends Error {}

const BLOCK = 512;

function parseNumber(h: Buffer, off: number, len: number): number {
  if (h[off] & 0x80) {
    // GNU base-256 (sizes > 8 GB)
    let v = h[off] & 0x7f;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + h[i];
    return v;
  }
  const s = h.toString('latin1', off, off + len).replace(/\0[^]*$/, '').trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function cString(b: Buffer, off: number, len: number): string {
  const end = b.indexOf(0, off);
  return b.toString('utf8', off, end >= off && end < off + len ? end : off + len);
}

function checksumOk(h: Buffer): boolean {
  const stored = parseNumber(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === stored;
}

function isZeroBlock(h: Buffer): boolean {
  for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) return false;
  return true;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number.parseInt(data.toString('latin1', i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > data.length) break;
    const rec = data.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** "./a/b" → "a/b", "./" → "" (the root itself); null when the name is unsafe. */
export function safeRelPath(name: string): string | null {
  if (!name || name.length > 4096) return null;
  if (/[\x00-\x1f\x7f\\]/.test(name)) return null;
  if (name.startsWith('/')) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || Buffer.byteLength(p) > 255)) return null;
  return parts.join('/');
}

type Sink =
  | { kind: 'file'; fh: FileHandle }
  | { kind: 'meta'; type: 'pax' | 'longname' | 'ignore'; chunks: Buffer[]; size: number }
  | { kind: 'skip' };

/**
 * Extract a tar stream into `dest`, which must not exist yet (it is created with 0755).
 * Rejects (and leaves a partial `dest` for the caller to remove) on invalid input or limits.
 */
export async function extractTarSafely(src: Readable, dest: string, opts: ExtractOptions): Promise<ExtractResult> {
  const root = path.resolve(dest);
  await fsp.mkdir(root, { mode: 0o755 });
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0 };
  const dirs = new Set<string>(['']);

  const ensureDir = async (rel: string): Promise<void> => {
    if (dirs.has(rel)) return;
    const slash = rel.lastIndexOf('/');
    await ensureDir(slash < 0 ? '' : rel.slice(0, slash));
    const abs = path.join(root, rel);
    try {
      await fsp.mkdir(abs, { mode: 0o755 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!(await fsp.lstat(abs)).isDirectory()) throw new Error(`"${rel}" is both a file and a folder`);
    }
    dirs.add(rel);
  };

  let buf: Buffer = Buffer.alloc(0);
  // (asserted types: the entry helpers below change these, which TypeScript cannot see)
  let state = 'header' as 'header' | 'data' | 'pad' | 'end';
  let remaining = 0;
  let pad = 0;
  let sink = { kind: 'skip' } as Sink;
  let paxNext: Record<string, string> | null = null;
  let longNameNext: string | null = null;
  let zeroBlocks = 0;

  const startEntry = async (h: Buffer): Promise<void> => {
    const flag = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    let name = cString(h, 0, 100);
    // POSIX ustar ("ustar\0") has a name prefix field; old GNU headers ("ustar ") use those bytes for other things
    if (h.toString('latin1', 257, 263) === 'ustar\0') {
      const prefix = cString(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longNameNext !== null) name = longNameNext;
    if (paxNext?.path) name = paxNext.path;
    let size = parseNumber(h, 124, 12);
    if (paxNext?.size && /^\d+$/.test(paxNext.size)) size = Number(paxNext.size);
    paxNext = null;
    longNameNext = null;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid tar entry size');
    remaining = size;
    pad = (BLOCK - (size % BLOCK)) % BLOCK;

    if (flag === 'x' || flag === 'L' || flag === 'g' || flag === 'K') {
      if (size > 1024 * 1024) throw new Error('tar header record too large');
      sink = { kind: 'meta', type: flag === 'x' ? 'pax' : flag === 'L' ? 'longname' : 'ignore', chunks: [], size: 0 };
      return;
    }
    if (flag === '5') {
      const rel = safeRelPath(name);
      if (rel && (!opts.filter || opts.filter(rel, true))) await ensureDir(rel);
      sink = { kind: 'skip' };
      return;
    }
    if (flag === '0' || flag === '7') {
      const rel = safeRelPath(name);
      if (!rel || (opts.filter && !opts.filter(rel, false))) {
        result.skipped++;
        sink = { kind: 'skip' };
        return;
      }
      if (result.files + 1 > opts.maxFiles) throw new TarLimitError(`more than ${opts.maxFiles} files`);
      if (result.bytes + size > opts.maxBytes) throw new TarLimitError(`larger than ${Math.round(opts.maxBytes / 1048576)} MB`);
      const slash = rel.lastIndexOf('/');
      await ensureDir(slash < 0 ? '' : rel.slice(0, slash));
      if (dirs.has(rel)) {
        result.skipped++;
        sink = { kind: 'skip' };
        return;
      }
      let fh: FileHandle;
      try {
        fh = await fsp.open(path.join(root, rel), 'wx', 0o644);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        result.skipped++; // duplicate entry: the first one wins
        sink = { kind: 'skip' };
        return;
      }
      result.files++;
      result.bytes += size;
      sink = { kind: 'file', fh };
      return;
    }
    // hard/symbolic links, devices, FIFOs, sparse/multivolume parts …
    result.skipped++;
    sink = { kind: 'skip' };
  };

  const endEntry = async (): Promise<void> => {
    const s = sink;
    sink = { kind: 'skip' };
    if (s.kind === 'file') await s.fh.close();
    else if (s.kind === 'meta') {
      const data = Buffer.concat(s.chunks);
      if (s.type === 'pax') paxNext = parsePax(data);
      else if (s.type === 'longname') longNameNext = cString(data, 0, data.length);
    }
  };

  try {
    for await (const chunk of src as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (state === 'end') {
          buf = Buffer.alloc(0);
          break;
        }
        if (state === 'header') {
          if (buf.length < BLOCK) break;
          const h = buf.subarray(0, BLOCK);
          buf = buf.subarray(BLOCK);
          if (isZeroBlock(h)) {
            if (++zeroBlocks >= 2) state = 'end';
            continue;
          }
          zeroBlocks = 0;
          if (!checksumOk(h)) throw new Error('not a valid tar stream');
          await startEntry(h);
          state = 'data';
          continue;
        }
        if (state === 'data') {
          if (remaining > 0) {
            if (!buf.length) break;
            const n = Math.min(remaining, buf.length);
            const piece = buf.subarray(0, n);
            buf = buf.subarray(n);
            remaining -= n;
            if (sink.kind === 'file') await sink.fh.write(piece);
            else if (sink.kind === 'meta') sink.chunks.push(Buffer.from(piece));
            continue;
          }
          await endEntry();
          state = 'pad';
          continue;
        }
        // padding up to the next 512-byte block
        if (pad > 0) {
          if (!buf.length) break;
          const n = Math.min(pad, buf.length);
          buf = buf.subarray(n);
          pad -= n;
          continue;
        }
        state = 'header';
      }
    }
    if (state === 'data' && remaining > 0) throw new Error('the archive ended in the middle of a file');
    if (state === 'data') await endEntry();
    return result;
  } finally {
    if (sink.kind === 'file') await sink.fh.close().catch(() => {});
  }
}
