/**
 * File operations on user data. Reads of metadata (tree listing) use lstat as
 * root and never follow symlinks; every read of file *contents* and every
 * write runs as the owning user (see system.ts), so a symlink planted inside a
 * project can never make the server read or write somewhere it shouldn't.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { HttpError } from './http.js';
import { type SysUser, runAs, runAsChecked, spawnAs } from './system.js';
import { extractTarSafely, type ExtractOptions, type ExtractResult } from './tarsafe.js';

/** Resolve a user-supplied relative path inside `root`; rejects anything escaping it. */
export function resolveIn(root: string, rel: string | undefined | null): string {
  const raw = (rel ?? '').toString();
  if (raw.includes('\0')) throw new HttpError(400, 'invalid path');
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'path escapes the project');
  return abs;
}

/** Accepts absolute paths (must be inside root) or root-relative paths. */
export function resolveAnyIn(root: string, p: string): string {
  if (path.isAbsolute(p)) {
    const abs = path.resolve(p);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, `path is outside the project: ${p}`);
    return abs;
  }
  return resolveIn(root, p);
}

export function relOf(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Tree listing (metadata only, lstat, no symlink following)
// ---------------------------------------------------------------------------
export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link';
  size?: number;
  mtime?: number;
  children?: TreeNode[];
  /** directory not expanded (heavy or too deep) — load lazily */
  lazy?: boolean;
}

const HEAVY_DIRS = new Set([
  'node_modules', '.git', '.gradle', '.venv', 'venv', '__pycache__', '.cache', '.idea', '.vs',
  'obj', 'build', 'target', '.next', '.parcel-cache', '.turbo',
]);

export async function listTree(root: string, rel = '', maxDepth = 8, maxEntries = 4000): Promise<{ node: TreeNode; truncated: boolean }> {
  const start = resolveIn(root, rel);
  let count = 0;
  let truncated = false;

  async function walk(abs: string, depth: number): Promise<TreeNode[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      if (e.name === '.git' && e.isDirectory()) continue; // history is shown in the History tab
      count++;
      const childAbs = path.join(abs, e.name);
      const p = relOf(root, childAbs);
      if (e.isSymbolicLink()) {
        out.push({ name: e.name, path: p, type: 'link' });
      } else if (e.isDirectory()) {
        if (HEAVY_DIRS.has(e.name) || depth >= maxDepth) out.push({ name: e.name, path: p, type: 'dir', lazy: true });
        else out.push({ name: e.name, path: p, type: 'dir', children: await walk(childAbs, depth + 1) });
      } else if (e.isFile()) {
        let size: number | undefined;
        let mtime: number | undefined;
        try {
          const st = await fsp.lstat(childAbs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* vanished */
        }
        out.push({ name: e.name, path: p, type: 'file', size, mtime });
      }
    }
    return out;
  }

  const st = await fsp.lstat(start).catch(() => null);
  if (!st || !st.isDirectory()) throw new HttpError(404, 'directory not found');
  // lstat only looks at the last part of the path: a link further up ("l -> /", then l/data/home)
  // would make this listing — done as root — walk any folder of the server
  const realRoot = await fsp.realpath(root).catch(() => root);
  const realStart = await fsp.realpath(start).catch(() => null);
  if (!realStart || (realStart !== realRoot && !realStart.startsWith(realRoot + path.sep))) throw new HttpError(404, 'directory not found');
  const children = await walk(start, rel ? 1 : 0);
  return {
    node: { name: rel ? path.basename(start) : '', path: rel ? relOf(root, start) : '', type: 'dir', children },
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Content operations (run as the owning user)
// ---------------------------------------------------------------------------
export interface UStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
  isFile: boolean;
}

export async function userStat(su: SysUser, abs: string): Promise<UStat | null> {
  const r = await runAs(su, 'stat', ['-L', '-c', '%s %Y %F', '--', abs], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const m = /^(\d+) (\d+) (.+)$/.exec(r.stdout.trim());
  if (!m) return null;
  return {
    size: Number(m[1]),
    mtimeMs: Number(m[2]) * 1000,
    isDir: m[3] === 'directory',
    isFile: m[3].includes('regular'),
  };
}

/** Reads up to maxBytes; `tooLarge` is set when the file is bigger. */
export async function userReadFile(su: SysUser, abs: string, maxBytes: number): Promise<{ data: Buffer; tooLarge: boolean }> {
  const r = await runAs(su, 'head', ['-c', String(maxBytes + 1), '--', abs], { timeoutMs: 30_000, maxOutput: maxBytes + 2 });
  if (r.code !== 0) throw new HttpError(404, r.stderr.includes('Permission') ? 'permission denied' : 'file not readable');
  const tooLarge = r.stdoutBuf.length > maxBytes;
  return { data: tooLarge ? r.stdoutBuf.subarray(0, maxBytes) : r.stdoutBuf, tooLarge };
}

/** Stream a file (optionally a byte range) as the user. Pipe child.stdout. */
export function userReadStream(su: SysUser, abs: string, range?: { start: number; end: number }): ChildProcess {
  if (range) {
    return spawnAs(su, 'dd', [
      `if=${abs}`, 'bs=65536', 'iflag=skip_bytes,count_bytes', `skip=${range.start}`,
      `count=${range.end - range.start + 1}`, 'status=none',
    ]);
  }
  return spawnAs(su, 'cat', ['--', abs]);
}

export async function userWriteFile(su: SysUser, abs: string, data: Buffer | string): Promise<void> {
  await runAsChecked(su, 'sh', ['-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', abs], {
    input: data,
    timeoutMs: 120_000,
  });
}

/** Returns a child whose stdin receives the file content. */
export function userWriteStream(su: SysUser, abs: string): { child: ChildProcess; done: Promise<void> } {
  const child = spawnAs(su, 'sh', ['-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', abs], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `write failed (${code})`))));
  });
  return { child, done };
}

export async function userMkdir(su: SysUser, abs: string): Promise<void> {
  await runAsChecked(su, 'mkdir', ['-p', '--', abs], { timeoutMs: 15_000 });
}

export async function userRemove(su: SysUser, abs: string): Promise<void> {
  await runAsChecked(su, 'rm', ['-rf', '--', abs], { timeoutMs: 300_000 });
}

export async function userMove(su: SysUser, from: string, to: string): Promise<void> {
  if (await fsp.lstat(to).catch(() => null)) throw new HttpError(409, 'target already exists');
  await runAsChecked(su, 'sh', ['-c', 'mkdir -p -- "$(dirname -- "$2")" && mv -T -- "$1" "$2"', 'sh', from, to], {
    timeoutMs: 120_000,
  });
}

/** Copy a world-readable directory (templates) into a user directory. */
export async function userCopyTree(su: SysUser, srcDir: string, destDir: string): Promise<void> {
  await runAsChecked(su, 'sh', ['-c', 'mkdir -p -- "$2" && cp -R -- "$1"/. "$2"/', 'sh', srcDir, destDir], {
    timeoutMs: 120_000,
  });
}

/** tar stream (stdout) of paths relative to `cwd`, symlinks dereferenced. */
export function userTarCreate(su: SysUser, cwd: string, rels: string[]): ChildProcess {
  return spawnAs(su, 'tar', ['-C', cwd, '-chf', '-', '--', ...rels], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Copies files of a user into a folder of the Studio (`dest` must not exist yet). The tar stream
 * comes from a process that runs as the user, so it is not trusted: the Studio writes it with
 * its own extractor — plain files and folders only, no links, no devices, inside `dest`.
 */
export async function userTarInto(su: SysUser, cwd: string, rels: string[], dest: string, opts: ExtractOptions): Promise<ExtractResult> {
  const child = userTarCreate(su, cwd, rels);
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 20_000) stderr += d.toString('utf8');
  });
  const exited = new Promise<number>((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
  let result: ExtractResult;
  try {
    result = await extractTarSafely(child.stdout!, dest, opts);
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    throw err;
  }
  const code = await exited;
  // 1 = "some files changed while reading": fine
  if (code !== 0 && code !== 1) throw new Error(stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `reading the files failed (tar exit ${code})`);
  return result;
}

/** A file below `root` that is safe to send as the Studio itself: a regular file, reached without leaving `root` through a link. */
export async function regularFileIn(root: string, abs: string): Promise<string | null> {
  try {
    const realRoot = await fsp.realpath(root);
    const real = await fsp.realpath(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return (await fsp.lstat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** tar extraction (stdin) into a user directory. */
export function userTarExtract(su: SysUser, destDir: string): ChildProcess {
  return spawnAs(
    su,
    'sh',
    ['-c', 'mkdir -p -- "$1" && exec tar -C "$1" -xf - --no-same-owner --no-same-permissions', 'sh', destDir],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

/** zip stream (stdout) of a directory, without dependency/build caches. */
export function userZip(su: SysUser, dir: string, includeGit = false): ChildProcess {
  const excludes = [
    'node_modules/*', '*/node_modules/*', '.gradle/*', '*/.gradle/*', '.venv/*', '*/.venv/*', '__pycache__/*',
    '*/__pycache__/*',
  ];
  if (!includeGit) excludes.push('.git/*');
  return spawnAs(su, 'sh', ['-c', 'cd -- "$1" && shift && exec zip -q -r -y - . -x "$@"', 'sh', dir, ...excludes], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Wait for a child process to exit successfully. */
export function waitChild(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed (${code}): ${err.trim()}`))));
  });
}
