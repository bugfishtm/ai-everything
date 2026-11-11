/**
 * Asset library: every user has a private library; assets can be published to
 * the Global Space where everybody (and every Claude) can find and reuse them.
 *
 * Files live in LIBRARY_DIR/assets/<id>/files (root-owned, never writable by
 * user processes); thumb.png next to it. Metadata lives in MySQL.
 * Copies between projects and the library stream through tar: the user side
 * runs as the user (dereferencing symlinks), the library side as the server.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import busboy from 'busboy';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { shortId } from './lib/crypto.js';
import { HttpError, notFound, parse, wildcard } from './lib/http.js';
import { ASSET_KINDS, type AssetKind, kindForFile, pickMainFile } from './lib/mime.js';
import { nobodyCommand, type SysUser, which } from './lib/system.js';
import { regularFileIn, relOf, resolveAnyIn, resolveIn, userStat, userTarCreate, userTarExtract, userTarInto, waitChild } from './lib/userfs.js';
import { TarLimitError } from './lib/tarsafe.js';
import { loadOwnedProject, notifyProjectChanged, type ProjectRow, STRICT_CSP } from './projects.js';
import type { AuthUser } from './users.js';

export interface AssetFile {
  path: string;
  size: number;
}

export interface AssetRow {
  id: string;
  owner_id: number;
  name: string;
  kind: AssetKind;
  area: string | null;
  description: string | null;
  tags: string;
  visibility: 'private' | 'global';
  main_file: string | null;
  files: AssetFile[];
  size_bytes: number;
  has_thumb: number;
  source_project_id: number | null;
  license: string | null;
  import_count: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  owner_username?: string;
  owner_name?: string;
}

export function assetRoot(id: string): string {
  if (!/^ast_[a-z0-9]{6,20}$/.test(id)) throw new HttpError(400, 'invalid asset id');
  return path.join(config.libraryDir, 'assets', id);
}
const filesDir = (id: string) => path.join(assetRoot(id), 'files');
const thumbFile = (id: string) => path.join(assetRoot(id), 'thumb.png');

export function publicAsset(a: AssetRow) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    area: a.area,
    description: a.description ?? '',
    tags: a.tags ? a.tags.split(',').filter(Boolean) : [],
    visibility: a.visibility,
    mainFile: a.main_file,
    files: a.files,
    sizeBytes: Number(a.size_bytes),
    hasThumb: !!a.has_thumb,
    license: a.license,
    importCount: a.import_count,
    owner: { id: a.owner_id, username: a.owner_username, name: a.owner_name },
    sourceProjectId: a.source_project_id,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    publishedAt: a.published_at,
  };
}

const SELECT = `SELECT a.*, u.username AS owner_username, u.display_name AS owner_name
                  FROM assets a JOIN users u ON u.id = a.owner_id`;

export function normalizeTags(tags: string[] | string | undefined): string {
  const list = Array.isArray(tags) ? tags : (tags ?? '').split(',');
  return [...new Set(list.map((t) => t.trim().toLowerCase().replace(/[^a-z0-9 _.+-]/g, '').slice(0, 40)).filter(Boolean))]
    .slice(0, 20)
    .join(',');
}

export interface SearchOpts {
  q?: string;
  kind?: string;
  scope?: 'mine' | 'global' | 'all';
  limit?: number;
  offset?: number;
}

export async function searchAssets(user: AuthUser, o: SearchOpts): Promise<{ items: AssetRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = o.scope ?? 'all';
  if (scope === 'mine') {
    where.push('a.owner_id = ?');
    params.push(user.id);
  } else if (scope === 'global') {
    where.push("a.visibility = 'global'");
  } else {
    where.push("(a.owner_id = ? OR a.visibility = 'global')");
    params.push(user.id);
  }
  if (o.kind && ASSET_KINDS.includes(o.kind as AssetKind)) {
    where.push('a.kind = ?');
    params.push(o.kind);
  }
  for (const word of (o.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const like = `%${word.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    where.push('(LOWER(a.name) LIKE ? OR LOWER(a.description) LIKE ? OR a.tags LIKE ? OR a.id = ?)');
    params.push(like, like, like, word);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(o.limit ?? 48, 1), 200);
  const offset = Math.max(o.offset ?? 0, 0);
  const order = scope === 'global' ? 'COALESCE(a.published_at, a.created_at) DESC' : 'a.created_at DESC';
  const items = await q<AssetRow>(`${SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const total = await q1<{ n: number }>(`SELECT COUNT(*) AS n FROM assets a ${w}`, params);
  return { items, total: Number(total?.n ?? 0) };
}

export async function getAsset(id: string): Promise<AssetRow | null> {
  assetRoot(id);
  return q1<AssetRow>(`${SELECT} WHERE a.id = ?`, [id]);
}

export async function getVisibleAsset(user: AuthUser, id: string): Promise<AssetRow> {
  const a = await getAsset(id);
  if (!a || (a.owner_id !== user.id && a.visibility !== 'global' && user.role !== 'admin')) throw notFound('Asset not found');
  return a;
}

async function getOwnAsset(user: AuthUser, id: string, adminOk = true): Promise<AssetRow> {
  const a = await getAsset(id);
  if (!a || (a.owner_id !== user.id && !(adminOk && user.role === 'admin'))) throw notFound('Asset not found');
  return a;
}

async function walkFiles(root: string): Promise<AssetFile[]> {
  const out: AssetFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        await fsp.unlink(abs);
      } else if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        out.push({ path: relOf(root, abs), size: (await fsp.stat(abs)).size });
      }
      if (out.length > 5000) throw new HttpError(400, 'too many files for one asset (max 5000)');
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Thumbnails — generated by sandboxed converters reading from a pipe
// ---------------------------------------------------------------------------
const IMAGE_CODERS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif', '.bmp': 'bmp' };

async function makeThumb(id: string, main: string | null): Promise<boolean> {
  if (!main) return false;
  const src = path.join(filesDir(id), main);
  const ext = path.extname(main).toLowerCase();
  const kind = kindForFile(main);
  let cmd: [string, string[]] | null = null;
  if (IMAGE_CODERS[ext] && (await which('convert'))) {
    cmd = nobodyCommand('convert', [`${IMAGE_CODERS[ext]}:-[0]`, '-thumbnail', '512x512>', '-strip', 'png:-']);
  } else if ((kind === 'audio' || kind === 'video') && (await which('ffmpeg'))) {
    const filter = kind === 'audio' ? ['-filter_complex', 'showwavespic=s=640x240:colors=0xa78bfa'] : ['-vf', 'thumbnail,scale=512:-2'];
    cmd = nobodyCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...filter, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']);
  }
  if (!cmd) return false;
  const child = spawn(cmd[0], cmd[1], { stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (d: Buffer) => {
    size += d.length;
    if (size < 10 * 1024 * 1024) chunks.push(d);
  });
  child.stdin.on('error', () => {});
  fs.createReadStream(src).on('error', () => child.kill()).pipe(child.stdin);
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c ?? 1));
  });
  clearTimeout(timer);
  const png = Buffer.concat(chunks);
  if (code !== 0 || png.length < 100) return false;
  await fsp.writeFile(thumbFile(id), png);
  await exec('UPDATE assets SET has_thumb = 1 WHERE id = ?', [id]);
  return true;
}

// ---------------------------------------------------------------------------
// Creating assets
// ---------------------------------------------------------------------------
interface AssetMeta {
  name: string;
  kind?: string;
  description?: string;
  tags?: string[] | string;
  main?: string;
  license?: string;
}

async function finalizeAsset(
  owner: AuthUser,
  id: string,
  meta: AssetMeta,
  source: { projectId?: number; area?: string | null },
): Promise<AssetRow> {
  const files = await walkFiles(filesDir(id));
  if (!files.length) {
    await fsp.rm(assetRoot(id), { recursive: true, force: true });
    throw new HttpError(400, 'no files to add');
  }
  const picked = pickMainFile(files.map((f) => f.path));
  const main = meta.main && files.some((f) => f.path === meta.main) ? meta.main : picked.main;
  const kind = (meta.kind && ASSET_KINDS.includes(meta.kind as AssetKind) ? meta.kind : main ? kindForFile(main) : picked.kind) as AssetKind;
  await exec(
    `INSERT INTO assets (id, owner_id, name, kind, area, description, tags, main_file, files, size_bytes, source_project_id, license)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, owner.id, meta.name.slice(0, 160), kind, source.area ?? null, meta.description ?? null, normalizeTags(meta.tags),
      main, JSON.stringify(files), files.reduce((s, f) => s + f.size, 0), source.projectId ?? null, meta.license ?? null,
    ],
  );
  await makeThumb(id, main).catch((err) => console.warn(`[library] thumbnail for ${id} failed: ${err.message}`));
  return (await getAsset(id))!;
}

/** Copy files/folders of a project into a new library asset. */
export async function createAssetFromProject(
  owner: AuthUser,
  project: ProjectRow,
  su: SysUser,
  dir: string,
  paths: string[],
  meta: AssetMeta,
): Promise<AssetRow> {
  if (!paths.length) throw new HttpError(400, 'choose at least one file or folder');
  const abs = paths.map((p) => resolveAnyIn(dir, p));
  if (abs.some((a) => a === dir)) throw new HttpError(400, 'cannot add the whole project root as one asset — pick folders/files');
  for (const a of abs) if (!(await userStat(su, a))) throw new HttpError(404, `not found: ${relOf(dir, a)}`);
  // common parent keeps the relative structure (e.g. model.gltf + textures/)
  let base = path.dirname(abs[0]);
  for (const a of abs) while (!(a + path.sep).startsWith(base + path.sep)) base = path.dirname(base);
  if (abs.length === 1) {
    const st = await userStat(su, abs[0]);
    if (st?.isDir) base = abs[0];
  }
  const members = abs.map((a) => (a === base ? '.' : path.relative(base, a)));

  const id = shortId('ast');
  await fsp.mkdir(assetRoot(id), { recursive: true });
  try {
    // (never `tar -x` as root on a stream a user process wrote: links and device files would survive)
    await userTarInto(su, base, members, filesDir(id), { maxBytes: Math.max(config.limits.uploadMb, 2048) * 1024 * 1024, maxFiles: 50_000 });
  } catch (err) {
    await fsp.rm(assetRoot(id), { recursive: true, force: true });
    if (err instanceof TarLimitError) throw new HttpError(413, 'These files are too large for one library asset');
    throw new HttpError(400, (err as Error).message);
  }
  return finalizeAsset(owner, id, meta, { projectId: project.id, area: project.area });
}

/** Copy an asset into a project folder (as the project owner). */
export async function importAsset(
  asset: AssetRow,
  su: SysUser,
  dir: string,
  dest?: string,
): Promise<{ dest: string; files: string[] }> {
  const slug = asset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
  const target = dest ? resolveAnyIn(dir, dest) : resolveIn(dir, `assets/library/${slug}-${asset.id.slice(4)}`);
  if (target === dir) throw new HttpError(400, 'choose a sub folder as destination');
  const producer = spawn('tar', ['-C', filesDir(asset.id), '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const consumer = userTarExtract(su, target);
  producer.stdout.pipe(consumer.stdin!);
  await Promise.all([waitChild(producer, 'reading library files'), waitChild(consumer, 'writing project files')]);
  await exec('UPDATE assets SET import_count = import_count + 1 WHERE id = ?', [asset.id]);
  const rel = relOf(dir, target);
  return { dest: rel, files: asset.files.map((f) => `${rel}/${f.path}`) };
}

async function deleteAsset(a: AssetRow): Promise<void> {
  await exec('DELETE FROM assets WHERE id = ?', [a.id]);
  await fsp.rm(assetRoot(a.id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Routes (website)
// ---------------------------------------------------------------------------
export const libraryRouter = Router();

const metaSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.string().optional(),
  description: z.string().trim().max(4000).optional(),
  tags: z.union([z.array(z.string().max(60)).max(30), z.string().max(1000)]).optional(),
  main: z.string().max(1024).optional(),
  license: z.string().trim().max(64).optional(),
});

libraryRouter.get('/library', async (req, res) => {
  const scope = (['mine', 'global', 'all'] as const).find((s) => s === req.query.scope) ?? 'mine';
  const { items, total } = await searchAssets(req.user!, {
    q: typeof req.query.q === 'string' ? req.query.q : '',
    kind: typeof req.query.kind === 'string' ? req.query.kind : '',
    scope,
    limit: Number(req.query.limit) || 48,
    offset: Number(req.query.offset) || 0,
  });
  res.json({ items: items.map(publicAsset), total });
});

libraryRouter.get('/library/:id', async (req, res) => {
  res.json({ asset: publicAsset(await getVisibleAsset(req.user!, String(req.params.id))) });
});

libraryRouter.patch('/library/:id', async (req, res) => {
  const a = await getOwnAsset(req.user!, String(req.params.id));
  const body = parse(metaSchema.partial(), req.body);
  await exec('UPDATE assets SET name = ?, kind = ?, description = ?, tags = ?, main_file = ?, license = ? WHERE id = ?', [
    body.name ?? a.name,
    body.kind && ASSET_KINDS.includes(body.kind as AssetKind) ? body.kind : a.kind,
    body.description ?? a.description,
    body.tags !== undefined ? normalizeTags(body.tags) : a.tags,
    body.main && a.files.some((f) => f.path === body.main) ? body.main : a.main_file,
    body.license ?? a.license,
    a.id,
  ]);
  res.json({ asset: publicAsset((await getAsset(a.id))!) });
});

libraryRouter.delete('/library/:id', async (req, res) => {
  await deleteAsset(await getOwnAsset(req.user!, String(req.params.id)));
  res.json({ ok: true });
});

libraryRouter.post('/library/:id/publish', async (req, res) => {
  const a = await getOwnAsset(req.user!, String(req.params.id), false);
  await exec("UPDATE assets SET visibility = 'global', published_at = COALESCE(published_at, UTC_TIMESTAMP(3)) WHERE id = ?", [a.id]);
  res.json({ asset: publicAsset((await getAsset(a.id))!) });
});

libraryRouter.post('/library/:id/unpublish', async (req, res) => {
  const a = await getOwnAsset(req.user!, String(req.params.id));
  await exec("UPDATE assets SET visibility = 'private', published_at = NULL WHERE id = ?", [a.id]);
  res.json({ asset: publicAsset((await getAsset(a.id))!) });
});

libraryRouter.post('/library/from-project', async (req, res) => {
  const body = parse(metaSchema.extend({ projectId: z.number().int().positive(), paths: z.array(z.string().max(1024)).min(1).max(200) }), req.body);
  const { project, su, dir } = await loadOwnedProject(req.user!, body.projectId);
  const asset = await createAssetFromProject(req.user!, project, su, dir, body.paths, body);
  res.status(201).json({ asset: publicAsset(asset) });
});

libraryRouter.post('/library/upload', async (req, res) => {
  const id = shortId('ast');
  const root = filesDir(id);
  await fsp.mkdir(root, { recursive: true });
  const fields: Record<string, string> = {};
  const limit = config.limits.uploadMb * 1024 * 1024;
  try {
    await new Promise<void>((resolve, reject) => {
      const bb = busboy({ headers: req.headers, preservePath: true, limits: { fileSize: limit, files: 2000 } });
      const pending: Promise<void>[] = [];
      bb.on('field', (name, val) => (fields[name] = val));
      bb.on('file', (_f, stream, info) => {
        let target: string;
        try {
          target = resolveIn(root, (info.filename ?? "").replace(/\\/g, '/'));
          if (target === root) throw new Error('empty name');
        } catch {
          stream.resume();
          return;
        }
        pending.push(
          (async () => {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await new Promise<void>((res2, rej2) => {
              const out = fs.createWriteStream(target, { flags: 'wx' });
              stream.on('limit', () => rej2(new HttpError(413, `${info.filename} is larger than ${config.limits.uploadMb} MB`)));
              out.on('error', rej2);
              out.on('finish', () => res2());
              stream.pipe(out);
            });
          })(),
        );
      });
      bb.on('error', reject);
      bb.on('close', () => Promise.all(pending).then(() => resolve(), reject));
      req.pipe(bb);
    });
    const meta = parse(metaSchema, {
      name: fields.name,
      kind: fields.kind || undefined,
      description: fields.description || undefined,
      tags: fields.tags || undefined,
      license: fields.license || undefined,
    });
    const asset = await finalizeAsset(req.user!, id, meta, { area: fields.area || null });
    res.status(201).json({ asset: publicAsset(asset) });
  } catch (err) {
    await fsp.rm(assetRoot(id), { recursive: true, force: true });
    throw err;
  }
});

libraryRouter.post('/library/:id/import', async (req, res) => {
  const a = await getVisibleAsset(req.user!, String(req.params.id));
  const body = parse(z.object({ projectId: z.number().int().positive(), dest: z.string().max(1024).optional() }), req.body);
  const { project, su, dir } = await loadOwnedProject(req.user!, body.projectId);
  const r = await importAsset(a, su, dir, body.dest);
  notifyProjectChanged(project.id);
  res.json(r);
});

function serveLibraryFile(_req: Request, res: express.Response, abs: string, download = false): Promise<void> {
  return new Promise((resolve, reject) => {
    res.sendFile(
      abs,
      {
        dotfiles: 'allow',
        headers: {
          'Content-Security-Policy': STRICT_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=300',
          ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(abs).replace(/[^\w.-]/g, '_')}"` } : {}),
        },
      },
      (err) => {
        if (err && !res.headersSent) reject(notFound('File not found'));
        else resolve();
      },
    );
  });
}

libraryRouter.get('/library/:id/file/*path', async (req, res) => {
  const a = await getVisibleAsset(req.user!, String(req.params.id));
  const file = await regularFileIn(filesDir(a.id), resolveIn(filesDir(a.id), wildcard(req.params.path)));
  if (!file) throw notFound('File not found');
  await serveLibraryFile(req, res, file, req.query.download === '1');
});

libraryRouter.get('/library/:id/thumb', async (req, res) => {
  const a = await getVisibleAsset(req.user!, String(req.params.id));
  if (!a.has_thumb) throw notFound();
  await serveLibraryFile(req, res, thumbFile(a.id));
});

libraryRouter.put('/library/:id/thumb', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '6mb' }), async (req, res) => {
  const a = await getOwnAsset(req.user!, String(req.params.id));
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length < 100) throw new HttpError(400, 'send the image as the request body');
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) throw new HttpError(400, 'thumbnail must be a PNG, JPEG or WebP image');
  await fsp.writeFile(thumbFile(a.id), buf);
  await exec('UPDATE assets SET has_thumb = 1 WHERE id = ?', [a.id]);
  res.json({ ok: true });
});

libraryRouter.get('/library/:id/download', async (req, res) => {
  const a = await getVisibleAsset(req.user!, String(req.params.id));
  const name = `${a.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || a.id}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  const child = spawn('zip', ['-q', '-r', '-', '.'], { cwd: filesDir(a.id), stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => res.destroy());
  child.stdout.pipe(res);
  res.on('close', () => child.kill());
});

/** Used by the account dashboard */
export async function libraryStats(userId: number): Promise<{ mine: number; published: number; global: number }> {
  const r = await q1<{ mine: number; published: number; global: number }>(
    `SELECT SUM(owner_id = ?) AS mine, SUM(owner_id = ? AND visibility = 'global') AS published,
            SUM(visibility = 'global') AS global FROM assets`,
    [userId, userId],
  );
  return { mine: Number(r?.mine ?? 0), published: Number(r?.published ?? 0), global: Number(r?.global ?? 0) };
}
