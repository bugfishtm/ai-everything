/**
 * Packs — expansion content for the Studio software (DAW, 3D tool, …) and for
 * Claude: instruments, samples, loops, drum kits, presets, models, materials,
 * textures … described by a text manifest (pack.json) that the AI can read.
 *
 * Where packs live (searched in this order, first match wins):
 *   <project>/packs/<id>            project-local packs (work in progress)
 *   PACKS_DIR/users/<uid>/<id>      personal packs   (root:u<uid> 0750, read-only for the owner)
 *   PACKS_DIR/global/<id>           Global Space     (root 0755, readable by everyone)
 *   /opt/studio/packs/<id>          system packs shipped with the image
 * Studio software finds them through STUDIO_PACKS_PATH (same order).
 * Spec: packs/README.md
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { HttpError, notFound, parse, wildcard } from './lib/http.js';
import { ensureSysUser, isolation, nobodyCommand, run, type SysUser } from './lib/system.js';
import { regularFileIn, relOf, resolveAnyIn, resolveIn, userReadFile, userStat, userTarInto } from './lib/userfs.js';
import { TarLimitError } from './lib/tarsafe.js';
import { loadOwnedProject, STRICT_CSP } from './projects.js';
import type { AuthUser } from './users.js';
import { getUser } from './users.js';
import { sendToUser, broadcast } from './ws.js';

export const PACK_TYPES = ['music', '3d', 'image', 'video', 'general'] as const;
export type PackType = (typeof PACK_TYPES)[number];
export type PackScope = 'system' | 'global' | 'user';

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'use lowercase letters, digits, "." "_" "-" (max 64 chars)');

export const itemSchema = z.looseObject({
  id: slug,
  kind: z.string().min(1).max(40),
  name: z.string().max(200).optional(),
  file: z.string().max(1024).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().max(60)).max(40).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type PackItem = z.infer<typeof itemSchema>;

export const manifestSchema = z.looseObject({
  id: slug,
  name: z.string().min(1).max(160),
  version: z.string().max(40).optional(),
  type: z.enum(PACK_TYPES),
  description: z.string().max(8000).optional(),
  author: z.string().max(200).optional(),
  license: z.string().max(100).optional(),
  homepage: z.string().max(500).optional(),
  tags: z.array(z.string().max(60)).max(40).optional(),
  /** Studio tools the pack is made for, e.g. ["studio-daw"] */
  software: z.array(z.string().max(60)).max(20).optional(),
  /** markdown file with usage notes for humans and Claude */
  docs: z.string().max(300).optional(),
  /** inline list, or a path to a JSON file holding the list (large packs) */
  items: z.union([z.array(itemSchema).max(100_000), z.string().max(300)]),
});
export type PackManifest = z.infer<typeof manifestSchema>;

/** manifest without the item list (extra fields of future software are kept) */
export interface ManifestInfo {
  id: string;
  name: string;
  version?: string;
  type: PackType;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  tags?: string[];
  software?: string[];
  docs?: string;
  [extra: string]: unknown;
}

interface PackMeta {
  /** read by the Studio tools: plugin code of a "global" pack only runs when trusted */
  scope?: 'user' | 'global';
  hasCode?: boolean;
  trusted?: boolean;
  reviewedBy?: string;
  ownerId?: number;
  ownerName?: string;
  installedAt?: string;
  publishedAt?: string | null;
  publishedBy?: string;
  source?: string;
  sizeBytes?: number;
  fileCount?: number;
}
type MediaInfo = { duration?: number; sampleRate?: number; channels?: number; width?: number; height?: number };

export interface PackInfo {
  id: string;
  scope: PackScope;
  ownerId: number | null;
  dir: string;
  manifest: ManifestInfo;
  items: PackItem[];
  index: Record<string, MediaInfo>;
  meta: PackMeta;
  sizeBytes: number;
  fileCount: number;
}

const META = '.studio-meta.json';
const INDEX = '.studio-index.json';
const globalDir = () => path.join(config.packsDir, 'global');
const usersDir = () => path.join(config.packsDir, 'users');
const stagingDir = () => path.join(config.packsDir, '.staging');

function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    const i = err.issues[0];
    return `pack.json ${i?.path?.join('.') || ''}: ${i?.message}`;
  }
  return (err as Error).message;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        files++;
        bytes += (await fsp.stat(abs).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Parse + validate the manifest of a pack folder (trusted, server-controlled folders only). */
export async function readPack(dir: string): Promise<{ manifest: PackManifest; items: PackItem[] }> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(dir, 'pack.json'), 'utf8');
  } catch {
    throw new HttpError(400, 'pack.json not found in this folder');
  }
  let manifest: PackManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new HttpError(400, err instanceof SyntaxError ? `pack.json is not valid JSON: ${err.message}` : zodMessage(err));
  }
  let items: PackItem[];
  if (Array.isArray(manifest.items)) items = manifest.items;
  else {
    const list = await readJson<unknown>(resolveIn(dir, manifest.items));
    const r = z.array(itemSchema).safeParse(list);
    if (!r.success) throw new HttpError(400, `${manifest.items}: ${zodMessage(r.error)}`);
    items = r.data;
  }
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const it of items) {
    if (seen.has(it.id)) throw new HttpError(400, `duplicate item id "${it.id}"`);
    seen.add(it.id);
    if (it.file) {
      const abs = resolveIn(dir, it.file);
      if (!fs.existsSync(abs)) missing.push(it.file);
    }
  }
  if (missing.length) throw new HttpError(400, `files listed in pack.json are missing: ${[...new Set(missing)].slice(0, 10).join(', ')}`);
  return { manifest, items };
}

async function loadPack(dir: string, scope: PackScope, ownerId: number | null): Promise<PackInfo | null> {
  try {
    const { manifest, items } = await readPack(dir);
    if (manifest.id !== path.basename(dir)) throw new Error(`folder name must equal the pack id "${manifest.id}"`);
    const meta = (await readJson<PackMeta>(path.join(dir, META))) ?? {};
    const index = (await readJson<Record<string, MediaInfo>>(path.join(dir, INDEX))) ?? {};
    const size = meta.sizeBytes !== undefined ? { bytes: meta.sizeBytes, files: meta.fileCount ?? 0 } : await dirSize(dir);
    const { items: _items, ...rest } = manifest;
    return {
      id: manifest.id,
      scope,
      ownerId: meta.ownerId ?? ownerId,
      dir,
      manifest: rest as ManifestInfo,
      items,
      index,
      meta,
      sizeBytes: size.bytes,
      fileCount: size.files,
    };
  } catch (err) {
    console.warn(`[packs] skipping ${dir}: ${(err as Error).message}`);
    return null;
  }
}

async function scan(root: string, scope: PackScope, ownerId: number | null): Promise<PackInfo[]> {
  const out: PackInfo[] = [];
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = await loadPack(path.join(root, e.name), scope, ownerId);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

let systemPacks: PackInfo[] = [];
let globalPacks: PackInfo[] = [];
const personal = new Map<number, PackInfo[]>();

export async function reloadPacks(which: 'all' | 'global' | number = 'all'): Promise<void> {
  if (which === 'all') {
    systemPacks = await scan(config.systemPacksDir, 'system', null);
    personal.clear();
    for (const e of await fsp.readdir(usersDir(), { withFileTypes: true }).catch(() => [])) {
      const uid = Number(e.name);
      if (e.isDirectory() && uid > 0) personal.set(uid, await scan(path.join(usersDir(), e.name), 'user', uid));
    }
  }
  if (which === 'all' || which === 'global') globalPacks = await scan(globalDir(), 'global', null);
  if (typeof which === 'number') personal.set(which, await scan(path.join(usersDir(), String(which)), 'user', which));
  if (which === 'all') {
    const n = systemPacks.length + globalPacks.length + [...personal.values()].reduce((s, l) => s + l.length, 0);
    console.log(`[packs] ${systemPacks.length} system, ${globalPacks.length} global, ${n - systemPacks.length - globalPacks.length} personal pack(s)`);
  }
}

/** Packs a user can use; personal shadows global shadows system (same order as STUDIO_PACKS_PATH). */
export function visiblePacks(userId: number): PackInfo[] {
  const byId = new Map<string, PackInfo>();
  for (const p of [...systemPacks, ...globalPacks, ...(personal.get(userId) ?? [])]) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => a.manifest.type.localeCompare(b.manifest.type) || a.manifest.name.localeCompare(b.manifest.name));
}

function getPack(user: AuthUser, scope: string, id: string): PackInfo {
  const list = scope === 'system' ? systemPacks : scope === 'global' ? globalPacks : scope === 'user' ? (personal.get(user.id) ?? []) : [];
  const p = list.find((x) => x.id === id);
  if (!p) throw notFound('Pack not found');
  return p;
}

/** STUDIO_PACKS_PATH for a user's processes. */
export function packsPathFor(su: SysUser, projectDir?: string): string {
  return [projectDir ? path.join(projectDir, 'packs') : null, path.join(usersDir(), String(su.userId)), globalDir(), config.systemPacksDir]
    .filter(Boolean)
    .join(':');
}

export function kindCounts(items: PackItem[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
  return c;
}

export function packSummary(p: PackInfo, ownerName?: string) {
  return {
    id: p.id,
    scope: p.scope,
    name: p.manifest.name,
    type: p.manifest.type,
    version: p.manifest.version ?? null,
    description: p.manifest.description ?? '',
    author: p.manifest.author ?? null,
    license: p.manifest.license ?? null,
    tags: p.manifest.tags ?? [],
    software: p.manifest.software ?? [],
    itemCount: p.items.length,
    kinds: kindCounts(p.items),
    sizeBytes: p.sizeBytes,
    fileCount: p.fileCount,
    owner: p.ownerId ? { id: p.ownerId, name: ownerName ?? p.meta.ownerName ?? null } : null,
    installedAt: p.meta.installedAt ?? null,
    publishedAt: p.meta.publishedAt ?? null,
    hasDocs: !!p.manifest.docs,
    hasCode: p.scope === 'system' ? packHasCode(p.items) : !!p.meta.hasCode,
    trusted: p.scope !== 'global' || !!p.meta.trusted,
    reviewedBy: p.meta.reviewedBy ?? null,
  };
}

const CODE_FILE = /\.(py|js|mjs|cjs|sh)$/i;
function packHasCode(items: PackItem[]): boolean {
  return items.some((it) => it.kind === 'plugin' || (it.file && CODE_FILE.test(it.file)));
}
async function dirHasCode(dir: string): Promise<boolean> {
  let found = false;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (found) return;
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (CODE_FILE.test(e.name)) found = true;
    }
  };
  await walk(dir);
  return found;
}

/** Short pack list for Claude's system prompt. */
export function packsPrompt(userId: number, areaKinds: string[]): string {
  const preferred = new Set(areaKinds);
  const list = visiblePacks(userId).sort((a, b) => Number(preferred.has(b.manifest.type)) - Number(preferred.has(a.manifest.type)));
  if (!list.length) return '(no packs installed yet)';
  const lines = list.slice(0, 30).map((p) => {
    const kinds = Object.entries(kindCounts(p.items))
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    const where = p.scope === 'user' ? 'yours' : p.scope;
    return `- \`${p.id}\` — ${p.manifest.name} [${p.manifest.type}, ${where}; ${kinds}]${p.manifest.description ? `: ${p.manifest.description.split('\n')[0].slice(0, 140)}` : ''}`;
  });
  if (list.length > 30) lines.push(`- … ${list.length - 30} more: \`studio packs list\``);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Media index: durations, sample rates, sizes — so the AI can choose material
// ---------------------------------------------------------------------------
const MEDIA = /\.(wav|mp3|ogg|oga|flac|aif|aiff|m4a|opus|mp4|webm|mov|png|jpg|jpeg|webp|gif)$/i;

async function probe(file: string): Promise<MediaInfo | null> {
  const [cmd, args] = nobodyCommand('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,sample_rate,channels,width,height:format=duration', '-of', 'json', file]);
  const r = await run(cmd, args, { timeoutMs: 15_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { streams?: Record<string, unknown>[]; format?: { duration?: string } };
    const s = j.streams?.[0] ?? {};
    const info: MediaInfo = {};
    const dur = Number(j.format?.duration);
    if (Number.isFinite(dur) && s.codec_type === 'audio') info.duration = Math.round(dur * 1000) / 1000;
    if (s.sample_rate) info.sampleRate = Number(s.sample_rate);
    if (s.channels) info.channels = Number(s.channels);
    if (s.width) info.width = Number(s.width);
    if (s.height) info.height = Number(s.height);
    if (Number.isFinite(dur) && s.codec_type === 'video' && !/\.(png|jpe?g|webp|gif)$/i.test(file)) info.duration = Math.round(dur * 1000) / 1000;
    return info;
  } catch {
    return null;
  }
}

async function buildIndex(dir: string, items: PackItem[]): Promise<Record<string, MediaInfo>> {
  const out: Record<string, MediaInfo> = {};
  const todo = items.filter((it) => it.file && MEDIA.test(it.file)).slice(0, 2000);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const it = todo[i++];
      const info = await probe(resolveIn(dir, it.file!));
      if (info && Object.keys(info).length) out[it.id] = info;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// ---------------------------------------------------------------------------
// Install / publish / unpublish / delete
// ---------------------------------------------------------------------------
async function setPerms(dir: string, owner: { gid: number } | null): Promise<void> {
  if (!isolation()) return;
  if (owner) {
    await run('chown', ['-R', `0:${owner.gid}`, dir]);
    await run('chmod', ['-R', 'u=rwX,g=rX,o=', dir]);
  } else {
    await run('chown', ['-R', '0:0', dir]);
    await run('chmod', ['-R', 'u=rwX,go=rX', dir]);
  }
  await fsp.chmod(dir, owner ? 0o750 : 0o755);
}

/** Atomically put `staged` at `target` (replacing an older version). */
async function swapInto(staged: string, target: string): Promise<void> {
  const old = path.join(stagingDir(), `old-${randomBytes(6).toString('hex')}`);
  const hadOld = fs.existsSync(target);
  if (hadOld) await fsp.rename(target, old);
  await fsp.rename(staged, target);
  if (hadOld) await fsp.rm(old, { recursive: true, force: true });
}

const nameCache = new Map<number, string>();
async function ownerName(id: number): Promise<string | undefined> {
  if (!nameCache.has(id)) {
    const u = await getUser(id);
    if (u) nameCache.set(id, u.display_name || u.username);
  }
  return nameCache.get(id);
}

/** Copy a pack folder from a project into the user's personal packs. */
export async function installPackFromProject(user: AuthUser, su: SysUser, projectDir: string, rel: string, source: string): Promise<PackInfo> {
  const abs = resolveAnyIn(projectDir, rel);
  const st = await userStat(su, abs);
  if (!st?.isDir) throw new HttpError(400, 'choose the pack folder (the folder that contains pack.json)');
  // validate the manifest before copying anything
  const { data } = await userReadFile(su, path.join(abs, 'pack.json'), 4 * 1024 * 1024).catch(() => {
    throw new HttpError(400, `no pack.json in ${relOf(projectDir, abs) || 'the project root'}`);
  });
  let manifest: PackManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(data.toString('utf8')));
  } catch (err) {
    throw new HttpError(400, err instanceof SyntaxError ? `pack.json is not valid JSON: ${err.message}` : zodMessage(err));
  }
  const clash = [...systemPacks, ...globalPacks].find((p) => p.id === manifest.id);
  if (clash) {
    throw new HttpError(
      409,
      clash.scope === 'global' && clash.ownerId === user.id
        ? `"${manifest.id}" is published in the Global Space — unpublish it first, or change the id`
        : `the pack id "${manifest.id}" is already used by a ${clash.scope} pack — choose another id`,
    );
  }

  const staged = path.join(stagingDir(), `new-${randomBytes(6).toString('hex')}`);
  await fsp.mkdir(stagingDir(), { recursive: true });
  try {
    try {
      // (never `tar -x` as root on a stream a user process wrote: links and device files would survive)
      await userTarInto(su, abs, ['.'], staged, { maxBytes: config.limits.packMb * 1024 * 1024, maxFiles: 200_000 });
    } catch (err) {
      if (err instanceof TarLimitError) throw new HttpError(413, `pack is larger than ${config.limits.packMb} MB (or has too many files)`);
      throw new HttpError(400, `the pack folder could not be read: ${(err as Error).message}`);
    }
    for (const f of [META, INDEX]) await fsp.rm(path.join(staged, f), { force: true });
    const { items } = await readPack(staged);
    const size = await dirSize(staged);
    if (size.bytes > config.limits.packMb * 1024 * 1024) throw new HttpError(413, `pack is larger than ${config.limits.packMb} MB`);
    const index = await buildIndex(staged, items);
    const meta: PackMeta = {
      scope: 'user',
      hasCode: packHasCode(items) || (await dirHasCode(staged)),
      ownerId: user.id,
      ownerName: user.display_name || user.username,
      installedAt: new Date().toISOString(),
      publishedAt: null,
      source,
      sizeBytes: size.bytes,
      fileCount: size.files,
    };
    await fsp.writeFile(path.join(staged, META), JSON.stringify(meta, null, 2));
    await fsp.writeFile(path.join(staged, INDEX), JSON.stringify(index));
    await setPerms(staged, su);
    const target = path.join(usersDir(), String(user.id), manifest.id);
    await swapInto(staged, target);
  } catch (err) {
    await fsp.rm(staged, { recursive: true, force: true });
    throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
  }
  await reloadPacks(user.id);
  sendToUser(user.id, { t: 'packs.changed' });
  return getPack(user, 'user', manifest.id);
}

async function copyTree(src: string, dest: string): Promise<void> {
  const r = await run('cp', ['-a', '--', src, dest], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(r.stderr || 'copy failed');
}

export async function publishPack(user: AuthUser, id: string): Promise<PackInfo> {
  const p = getPack(user, 'user', id);
  const existing = globalPacks.find((g) => g.id === id);
  if (existing && existing.ownerId !== user.id) throw new HttpError(409, `the Global Space already has a pack "${id}" by someone else`);
  const staged = path.join(stagingDir(), `pub-${randomBytes(6).toString('hex')}`);
  await copyTree(p.dir, staged);
  // code published by an admin counts as reviewed; anybody else's code waits for a review
  const byAdmin = user.role === 'admin';
  const meta: PackMeta = {
    ...p.meta,
    scope: 'global',
    trusted: byAdmin,
    reviewedBy: byAdmin ? user.display_name || user.username : undefined,
    publishedAt: new Date().toISOString(),
    publishedBy: user.display_name || user.username,
  };
  await fsp.writeFile(path.join(staged, META), JSON.stringify(meta, null, 2));
  await setPerms(staged, null);
  await swapInto(staged, path.join(globalDir(), id));
  await fsp.rm(p.dir, { recursive: true, force: true });
  await reloadPacks('global');
  await reloadPacks(user.id);
  broadcast({ t: 'packs.changed' });
  return getPack(user, 'global', id);
}

export async function unpublishPack(user: AuthUser, id: string): Promise<void> {
  const p = getPack(user, 'global', id);
  if (p.ownerId !== user.id && user.role !== 'admin') throw new HttpError(403, 'only the owner or an admin can unpublish this pack');
  if (!p.ownerId) throw new HttpError(400, 'this pack has no owner — delete it instead');
  const su = await ensureSysUser(p.ownerId);
  const staged = path.join(stagingDir(), `unpub-${randomBytes(6).toString('hex')}`);
  await copyTree(p.dir, staged);
  await fsp.writeFile(path.join(staged, META), JSON.stringify({ ...p.meta, scope: 'user', trusted: undefined, reviewedBy: undefined, publishedAt: null }, null, 2));
  await setPerms(staged, su);
  await swapInto(staged, path.join(usersDir(), String(p.ownerId), id));
  await fsp.rm(p.dir, { recursive: true, force: true });
  await reloadPacks('global');
  await reloadPacks(p.ownerId);
  broadcast({ t: 'packs.changed' });
}

export async function deletePack(user: AuthUser, scope: string, id: string): Promise<void> {
  const p = getPack(user, scope, id);
  if (p.scope === 'system') throw new HttpError(403, 'system packs are part of the image');
  if (p.scope === 'global' && p.ownerId !== user.id && user.role !== 'admin') throw new HttpError(403, 'only the owner or an admin can delete this pack');
  await fsp.rm(p.dir, { recursive: true, force: true });
  await reloadPacks(p.scope === 'global' ? 'global' : user.id);
  broadcast({ t: 'packs.changed' });
}

// ---------------------------------------------------------------------------
// Routes (website)
// ---------------------------------------------------------------------------
export const packsRouter = Router();

packsRouter.get('/packs', async (req, res) => {
  const list = visiblePacks(req.user!.id);
  res.json({
    packs: await Promise.all(list.map(async (p) => packSummary(p, p.ownerId ? await ownerName(p.ownerId) : undefined))),
    shadowed: [...systemPacks, ...globalPacks].filter((p) => !list.includes(p)).map((p) => ({ id: p.id, scope: p.scope })),
  });
});

packsRouter.get('/packs/:scope/:id', async (req, res) => {
  const p = getPack(req.user!, String(req.params.scope), String(req.params.id));
  let docs: string | null = null;
  if (p.manifest.docs) {
    const file = await regularFileIn(p.dir, resolveIn(p.dir, p.manifest.docs));
    const st = file ? await fsp.stat(file).catch(() => null) : null;
    if (file && st && st.size <= 2 * 1024 * 1024) docs = await fsp.readFile(file, 'utf8').then((t) => t.slice(0, 200_000)).catch(() => null);
  }
  res.json({
    pack: packSummary(p, p.ownerId ? await ownerName(p.ownerId) : undefined),
    manifest: p.manifest,
    items: p.items.map((it) => ({ ...it, media: p.index[it.id] })),
    docs,
  });
});

async function sendPackFile(_req: Request, res: Response, abs: string, download: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    res.sendFile(
      abs,
      {
        dotfiles: 'deny',
        headers: {
          'Content-Security-Policy': STRICT_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=600',
          ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(abs).replace(/[^\w.-]/g, '_')}"` } : {}),
        },
      },
      (err) => (err && !res.headersSent ? reject(notFound('File not found')) : resolve()),
    ),
  );
}

packsRouter.get('/packs/:scope/:id/file/*path', async (req, res) => {
  const p = getPack(req.user!, String(req.params.scope), String(req.params.id));
  const file = await regularFileIn(p.dir, resolveIn(p.dir, wildcard(req.params.path)));
  if (!file) throw notFound('File not found');
  await sendPackFile(req, res, file, req.query.download === '1');
});

packsRouter.get('/packs/:scope/:id/download', async (req, res) => {
  const p = getPack(req.user!, String(req.params.scope), String(req.params.id));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${p.id}${p.manifest.version ? `-${p.manifest.version}` : ''}.zip"`);
  // -y: a link is stored as a link, never followed
  const child = spawn('zip', ['-q', '-r', '-y', '-', '.', '-x', META, INDEX], { cwd: p.dir, stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => res.destroy());
  child.stdout.pipe(res);
  res.on('close', () => child.kill());
});

packsRouter.post('/packs/install', async (req, res) => {
  const body = parse(z.object({ projectId: z.number().int().positive(), path: z.string().min(1).max(1024) }), req.body);
  const { project, su, dir } = await loadOwnedProject(req.user!, body.projectId);
  const p = await installPackFromProject(req.user!, su, dir, body.path, `project #${project.id} ${body.path}`);
  res.status(201).json({ pack: packSummary(p) });
});

packsRouter.post('/packs/user/:id/publish', async (req, res) => {
  const p = await publishPack(req.user!, String(req.params.id));
  res.json({ pack: packSummary(p) });
});

packsRouter.post('/packs/global/:id/unpublish', async (req, res) => {
  await unpublishPack(req.user!, String(req.params.id));
  res.json({ ok: true });
});

/** Admins review plugin code of global packs before it may run in other users' sessions. */
packsRouter.post('/packs/global/:id/trust', async (req, res) => {
  if (req.user!.role !== 'admin') throw new HttpError(403, 'Admins only');
  const body = parse(z.object({ trusted: z.boolean() }), req.body);
  const p = getPack(req.user!, 'global', String(req.params.id));
  const meta: PackMeta = { ...p.meta, scope: 'global', trusted: body.trusted, reviewedBy: body.trusted ? req.user!.display_name || req.user!.username : undefined };
  await fsp.writeFile(path.join(p.dir, META), JSON.stringify(meta, null, 2));
  await fsp.chmod(path.join(p.dir, META), 0o644).catch(() => {});
  await reloadPacks('global');
  broadcast({ t: 'packs.changed' });
  res.json({ pack: packSummary(getPack(req.user!, 'global', p.id)) });
});

packsRouter.delete('/packs/:scope/:id', async (req, res) => {
  await deletePack(req.user!, String(req.params.scope), String(req.params.id));
  res.json({ ok: true });
});
