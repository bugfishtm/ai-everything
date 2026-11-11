import fsp from 'node:fs/promises';
import path from 'node:path';
import busboy from 'busboy';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AREAS, CHAT_AREA, getArea } from './areas.js';
import { config, PERMISSION_MODES, type PermissionMode } from './config.js';
import { exec, q, q1 } from './db.js';
import { checkpoint, diffStat, gitInit, history, restore } from './git.js';
import { hooks } from './hooks.js';
import { signToken, verifyToken } from './lib/crypto.js';
import { HttpError, intParam, notFound, parse, wildcard } from './lib/http.js';
import { isProbablyText, mimeFor } from './lib/mime.js';
import { type SysUser, ensureSysUser, runAsChecked } from './lib/system.js';
import {
  listTree,
  relOf,
  resolveIn,
  userCopyTree,
  userMkdir,
  userMove,
  userReadFile,
  userReadStream,
  userRemove,
  userStat,
  userWriteFile,
  userWriteStream,
  userZip,
} from './lib/userfs.js';
import { normalizeVersion, versioningOf, writeVersionFiles, type Versioning } from './releases.js';
import { publicTool, toolsForArea } from './tools.js';
import type { AuthUser } from './users.js';
import { publish } from './ws.js';

export interface ProjectSettings {
  /** AI for new chats in this project: 'claude' or an ACP agent id (empty = the user's default) */
  provider?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  previewPath?: string;
  /** numbered releases (releases.ts) — changed through /projects/:id/versioning, not by PATCH */
  versioning?: Versioning;
  /** shown first in the project lists */
  pinned?: boolean;
  /** hidden from the project lists unless "archived" is shown */
  archived?: boolean;
}

export interface ProjectRow {
  id: number;
  owner_id: number;
  name: string;
  area: string;
  description: string | null;
  settings: ProjectSettings | null;
  created_at: Date;
  updated_at: Date;
  last_opened_at: Date | null;
}

export function projectDir(p: { owner_id: number; id: number }): string {
  return path.join(config.projectsDir, String(p.owner_id), String(p.id));
}

export function projectSettings(p: ProjectRow): Required<Pick<ProjectSettings, 'permissionMode'>> & ProjectSettings {
  const s = (p.settings ?? {}) as ProjectSettings;
  return {
    ...s,
    permissionMode: s.permissionMode && PERMISSION_MODES.includes(s.permissionMode) ? s.permissionMode : config.defaultPermissionMode,
    previewPath: s.previewPath || getArea(p.area)?.previewPath || 'index.html',
  };
}

export function publicProject(p: ProjectRow) {
  const v = versioningOf(p);
  return {
    id: p.id,
    name: p.name,
    area: p.area,
    description: p.description ?? '',
    settings: projectSettings(p),
    /** the version the project is at — null when it is not versioned */
    version: v.enabled ? v.version : null,
    pinned: !!p.settings?.pinned,
    archived: !!p.settings?.archived,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    lastOpenedAt: p.last_opened_at,
    busy: hooks.isProjectBusy(p.id),
  };
}

export async function getProjectRow(id: number): Promise<ProjectRow | null> {
  return q1<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
}

export async function loadOwnedProject(user: AuthUser, id: number): Promise<{ project: ProjectRow; su: SysUser; dir: string }> {
  const project = await getProjectRow(id);
  if (!project || project.owner_id !== user.id) throw notFound('Project not found');
  const su = await ensureSysUser(user.id);
  return { project, su, dir: projectDir(project) };
}

export function authorOf(user: AuthUser): { name: string; email: string } {
  return { name: user.display_name || user.username, email: user.email };
}

export function notifyProjectChanged(projectId: number): void {
  publish(`project:${projectId}`, { t: 'project.changed', projectId });
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60) || 'project'
  );
}

// ---------------------------------------------------------------------------
// Serving user files (raw view, preview) — content is read as the owner
// ---------------------------------------------------------------------------
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export const PREVIEW_CSP =
  'sandbox allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads allow-orientation-lock';
export const STRICT_CSP =
  "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; font-src 'self' data:";

export async function sendUserFile(
  req: Request,
  res: Response,
  su: SysUser,
  abs: string,
  opts: { download?: boolean; mode?: 'strict' | 'preview'; cacheControl?: string } = {},
): Promise<void> {
  const st = await userStat(su, abs);
  if (!st || !st.isFile) throw notFound('File not found');
  res.setHeader('Content-Type', mimeFor(abs));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());
  res.setHeader('Cache-Control', opts.cacheControl ?? 'private, no-cache');
  if (opts.mode === 'preview') {
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Content-Security-Policy', STRICT_CSP);
  }
  if (opts.download) res.setHeader('Content-Disposition', contentDisposition('attachment', path.basename(abs)));
  const range = parseRange(req.headers.range, st.size);
  if (range === 'invalid') {
    res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
    res.end();
    return;
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else {
    res.setHeader('Content-Length', String(st.size));
  }
  if (req.method === 'HEAD' || st.size === 0) {
    res.end();
    return;
  }
  const child = userReadStream(su, abs, range ?? undefined);
  child.on('error', () => res.destroy());
  child.stdout!.pipe(res);
  res.on('close', () => child.kill());
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------
function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

async function readTemplate(rel: string): Promise<string> {
  try {
    return await fsp.readFile(path.join(config.templatesDir, rel), 'utf8');
  } catch {
    return '';
  }
}

async function scaffoldProject(su: SysUser, user: AuthUser, p: ProjectRow): Promise<void> {
  const dir = projectDir(p);
  const area = getArea(p.area)!;
  await runAsChecked(su, 'mkdir', ['--', dir]);
  for (const t of ['_base', area.id]) {
    const src = path.join(config.templatesDir, t, 'files');
    if (await fsp.stat(src).catch(() => null)) await userCopyTree(su, src, dir);
  }
  const vars = {
    PROJECT_NAME: p.name,
    AREA_NAME: area.name,
    AREA_ID: area.id,
    DESCRIPTION: p.description || '(no description yet)',
    PREVIEW_PATH: projectSettings(p).previewPath ?? 'index.html',
  };
  const guide = render(await readTemplate(path.join(area.id, 'GUIDE.md')), vars);
  const base = await readTemplate(path.join('_base', 'CLAUDE.md'));
  const claudeMd = render(base || '# {{PROJECT_NAME}}\n\n{{AREA_GUIDE}}\n', { ...vars, AREA_GUIDE: guide.trim() });
  await userWriteFile(su, path.join(dir, 'CLAUDE.md'), claudeMd);
  await userWriteFile(
    su,
    path.join(dir, '.studio', 'project.json'),
    JSON.stringify({ name: p.name, area: p.area, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
  const v = versioningOf(p);
  if (v.enabled) await writeVersionFiles(su, dir, v.version);
  await gitInit(su, dir, authorOf(user));
}

// ---------------------------------------------------------------------------
// Trash: deleted projects are kept for TRASH_DAYS days
// ---------------------------------------------------------------------------
async function moveToTrash(su: SysUser, dir: string, id: number): Promise<void> {
  const trash = path.join(su.projectsRoot, '.trash');
  await userMkdir(su, trash);
  await userMove(su, dir, path.join(trash, `${id}-${Date.now()}`));
}

export async function purgeTrash(): Promise<void> {
  const users = await q<{ id: number }>('SELECT id FROM users');
  const cutoff = Date.now() - config.limits.trashDays * 86400_000;
  for (const u of users) {
    const su = await ensureSysUser(u.id);
    const trash = path.join(su.projectsRoot, '.trash');
    const names = await fsp.readdir(trash).catch(() => [] as string[]);
    for (const n of names) {
      const ts = Number(n.split('-')[1]);
      if (ts && ts < cutoff) await userRemove(su, path.join(trash, n)).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const projectsRouter = Router();

const settingsSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(/^([a-z0-9][a-z0-9_-]{0,47})?$/, 'unknown AI'),
    model: z.string().trim().max(128),
    effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
    permissionMode: z.enum(['bypass', 'acceptEdits', 'ask', 'plan']),
    previewPath: z.string().trim().max(512),
    pinned: z.boolean(),
    archived: z.boolean(),
  })
  .partial();

projectsRouter.get('/areas', async (req, res) => {
  const counts = await q<{ area: string; n: number }>(
    'SELECT area, COUNT(*) AS n FROM projects WHERE owner_id = ? GROUP BY area',
    [req.user!.id],
  );
  res.json({
    areas: AREAS.map((a) => ({
      ...a,
      projectCount: Number(counts.find((c) => c.area === a.id)?.n ?? 0),
      tools: toolsForArea(a.id).map(publicTool),
    })),
  });
});

projectsRouter.get('/projects', async (req, res) => {
  const area = typeof req.query.area === 'string' ? req.query.area : '';
  // the hidden Chat project (casual conversations) is not a project to the user
  const rows = area
    ? await q<ProjectRow>('SELECT * FROM projects WHERE owner_id = ? AND area = ? ORDER BY COALESCE(last_opened_at, created_at) DESC', [req.user!.id, area])
    : await q<ProjectRow>(
        `SELECT * FROM projects WHERE owner_id = ? AND area <> '${CHAT_AREA.id}' ORDER BY COALESCE(last_opened_at, created_at) DESC`,
        [req.user!.id],
      );
  // what the project lists show next to a name: chats, and whether it is online somewhere
  const extras = new Map<number, { chats: number; site: boolean; servers: number; releases: number }>();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const count = async (sql: string) => new Map((await q<{ project_id: number; n: number }>(sql, ids)).map((r) => [r.project_id, Number(r.n)]));
    const [chats, sites, servers, releases] = await Promise.all([
      count(`SELECT project_id, COUNT(*) AS n FROM chats WHERE project_id IN (${marks}) GROUP BY project_id`),
      count(`SELECT project_id, COUNT(*) AS n FROM sites WHERE project_id IN (${marks}) GROUP BY project_id`),
      count(`SELECT project_id, COUNT(*) AS n FROM services WHERE project_id IN (${marks}) GROUP BY project_id`),
      count(`SELECT project_id, COUNT(*) AS n FROM project_releases WHERE project_id IN (${marks}) GROUP BY project_id`),
    ]);
    for (const id of ids) extras.set(id, { chats: chats.get(id) ?? 0, site: (sites.get(id) ?? 0) > 0, servers: servers.get(id) ?? 0, releases: releases.get(id) ?? 0 });
  }
  res.json({ projects: rows.map((r) => ({ ...publicProject(r), ...(extras.get(r.id) ?? { chats: 0, site: false, servers: 0, releases: 0 }) })) });
});

/** The user's Chat project (created on first use) — holds the casual conversations. */
const chatHomeLocks = new Map<number, Promise<ProjectRow>>();
async function chatHome(user: AuthUser): Promise<ProjectRow> {
  const found = await q1<ProjectRow>(`SELECT * FROM projects WHERE owner_id = ? AND area = '${CHAT_AREA.id}' ORDER BY id LIMIT 1`, [user.id]);
  if (found) return found;
  let pending = chatHomeLocks.get(user.id);
  if (!pending) {
    pending = (async () => {
      const su = await ensureSysUser(user.id);
      const { insertId } = await exec('INSERT INTO projects (owner_id, name, area, description, settings) VALUES (?, ?, ?, ?, ?)', [
        user.id,
        'Chat',
        CHAT_AREA.id,
        'Casual conversations with Claude',
        JSON.stringify({}),
      ]);
      const p = (await getProjectRow(insertId))!;
      try {
        await scaffoldProject(su, user, p);
      } catch (err) {
        await exec('DELETE FROM projects WHERE id = ?', [insertId]);
        throw new HttpError(500, `Could not prepare the chat folder: ${(err as Error).message}`);
      }
      return p;
    })().finally(() => chatHomeLocks.delete(user.id));
    chatHomeLocks.set(user.id, pending);
  }
  return pending;
}

projectsRouter.get('/chat/home', async (req, res) => {
  const p = await chatHome(req.user!);
  res.json({ project: { ...publicProject(p), dir: projectDir(p) }, area: CHAT_AREA });
});

projectsRouter.post('/projects', async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(128),
      area: z.string().refine((a) => AREAS.some((x) => x.id === a), 'unknown area'),
      description: z.string().trim().max(4000).optional(),
      /** start the project with numbered releases (VERSION, CHANGELOG.md, the Versions tab) */
      versioning: z.object({ enabled: z.boolean(), version: z.string().trim().max(64).optional() }).optional(),
    }),
    req.body,
  );
  const user = req.user!;
  const su = await ensureSysUser(user.id);
  const settings: ProjectSettings = {};
  if (body.versioning?.enabled) settings.versioning = { enabled: true, version: normalizeVersion(body.versioning.version || '0.1.0') };
  const { insertId } = await exec('INSERT INTO projects (owner_id, name, area, description, settings) VALUES (?, ?, ?, ?, ?)', [
    user.id,
    body.name,
    body.area,
    body.description ?? null,
    JSON.stringify(settings),
  ]);
  const p = (await getProjectRow(insertId))!;
  try {
    await scaffoldProject(su, user, p);
  } catch (err) {
    await exec('DELETE FROM projects WHERE id = ?', [insertId]);
    throw new HttpError(500, `Could not create project folder: ${(err as Error).message}`);
  }
  res.status(201).json({ project: publicProject(p) });
});

projectsRouter.get('/projects/:id', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  await exec('UPDATE projects SET last_opened_at = UTC_TIMESTAMP(3) WHERE id = ?', [project.id]);
  const area = getArea(project.area);
  res.json({
    project: { ...publicProject(project), dir: projectDir(project) },
    area,
    tools: toolsForArea(project.area).map(publicTool),
  });
});

projectsRouter.patch('/projects/:id', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(128).optional(),
      description: z.string().trim().max(4000).optional(),
      settings: settingsSchema.optional(),
    }),
    req.body,
  );
  const settings = { ...(project.settings ?? {}), ...(body.settings ?? {}) };
  await exec('UPDATE projects SET name = ?, description = ?, settings = ? WHERE id = ?', [
    body.name ?? project.name,
    body.description ?? project.description,
    JSON.stringify(settings),
    project.id,
  ]);
  res.json({ project: publicProject((await getProjectRow(project.id))!) });
});

projectsRouter.delete('/projects/:id', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  await hooks.stopProject(project.id);
  await hooks.projectDeleted(project.id);
  if (await fsp.lstat(dir).catch(() => null)) await moveToTrash(su, dir, project.id);
  await exec('DELETE FROM projects WHERE id = ?', [project.id]);
  res.json({ ok: true });
});

// ---- files -------------------------------------------------------------------
projectsRouter.get('/projects/:id/tree', async (req, res) => {
  const { dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const { node, truncated } = await listTree(dir, rel, rel ? 3 : 8);
  res.json({ tree: node, truncated });
});

const TEXT_LIMIT = 5 * 1024 * 1024;

projectsRouter.get('/projects/:id/file', async (req, res) => {
  const { su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const rel = String(req.query.path ?? '');
  const abs = resolveIn(dir, rel);
  const st = await userStat(su, abs);
  if (!st || !st.isFile) throw notFound('File not found');
  const mime = mimeFor(abs);
  const base = { path: relOf(dir, abs), size: st.size, mtime: st.mtimeMs, mime };
  if (st.size > TEXT_LIMIT) {
    res.json({ ...base, binary: !/^text\/|json|xml|javascript|svg/.test(mime), tooLarge: true });
    return;
  }
  const { data } = await userReadFile(su, abs, TEXT_LIMIT);
  if (!isProbablyText(data)) {
    res.json({ ...base, binary: true });
    return;
  }
  res.json({ ...base, binary: false, text: data.toString('utf8') });
});

projectsRouter.put('/projects/:id/file', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ path: z.string().min(1).max(1024), content: z.string().max(TEXT_LIMIT) }), req.body);
  const abs = resolveIn(dir, body.path);
  if (abs === dir) throw new HttpError(400, 'invalid file path');
  await userWriteFile(su, abs, body.content);
  notifyProjectChanged(project.id);
  const st = await userStat(su, abs);
  res.json({ ok: true, size: st?.size, mtime: st?.mtimeMs });
});

projectsRouter.post('/projects/:id/fs/mkdir', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ path: z.string().min(1).max(1024) }), req.body);
  await userMkdir(su, resolveIn(dir, body.path));
  notifyProjectChanged(project.id);
  res.json({ ok: true });
});

projectsRouter.post('/projects/:id/fs/move', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) }), req.body);
  const from = resolveIn(dir, body.from);
  const to = resolveIn(dir, body.to);
  if (from === dir || to === dir) throw new HttpError(400, 'cannot move the project root');
  await userMove(su, from, to);
  notifyProjectChanged(project.id);
  res.json({ ok: true });
});

projectsRouter.post('/projects/:id/fs/delete', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ path: z.string().min(1).max(1024) }), req.body);
  const abs = resolveIn(dir, body.path);
  if (abs === dir) throw new HttpError(400, 'cannot delete the project root');
  await userRemove(su, abs);
  notifyProjectChanged(project.id);
  res.json({ ok: true });
});

projectsRouter.post('/projects/:id/upload', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const baseRel = typeof req.query.dir === 'string' ? req.query.dir : '';
  resolveIn(dir, baseRel);
  const limit = config.limits.uploadMb * 1024 * 1024;
  const saved: string[] = [];
  const errors: string[] = [];
  await new Promise<void>((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, preservePath: true, limits: { fileSize: limit, files: 2000 } });
    } catch (err) {
      reject(new HttpError(400, (err as Error).message));
      return;
    }
    const pending: Promise<void>[] = [];
    const writing = new Map<import('node:child_process').ChildProcess, string>();
    // the browser went away mid-upload: busboy would wait for the rest for ever
    req.on('close', () => {
      if (req.complete) return;
      for (const [child, target] of writing) {
        child.kill();
        void userRemove(su, target).catch(() => {});
      }
      writing.clear();
      reject(new HttpError(400, 'The upload was interrupted'));
    });
    bb.on('file', (_field, stream, info) => {
      let target: string;
      try {
        target = resolveIn(dir, path.posix.join(baseRel, (info.filename ?? "").replace(/\\/g, '/')));
        if (target === dir) throw new Error('empty name');
      } catch {
        errors.push(`${info.filename}: invalid name`);
        stream.resume();
        return;
      }
      const { child, done } = userWriteStream(su, target);
      writing.set(child, target);
      void done.then(
        () => writing.delete(child),
        () => writing.delete(child),
      );
      let tooBig = false;
      stream.on('limit', () => (tooBig = true));
      child.stdin!.on('error', () => stream.resume());
      stream.pipe(child.stdin!);
      pending.push(
        done
          .then(async () => {
            if (tooBig) {
              await userRemove(su, target);
              errors.push(`${info.filename}: larger than ${config.limits.uploadMb} MB`);
            } else saved.push(relOf(dir, target));
          })
          .catch((e: Error) => {
            errors.push(`${info.filename}: ${e.message}`);
          }),
      );
    });
    bb.on('error', (e) => reject(new HttpError(400, (e as Error).message)));
    bb.on('close', () => {
      Promise.all(pending).then(() => resolve(), reject);
    });
    req.pipe(bb);
  });
  notifyProjectChanged(project.id);
  res.json({ saved, errors });
});

projectsRouter.get('/projects/:id/raw/*path', async (req, res) => {
  const { su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const abs = resolveIn(dir, wildcard(req.params.path));
  await sendUserFile(req, res, su, abs, { download: req.query.download === '1' });
});

projectsRouter.get('/projects/:id/download', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const abs = resolveIn(dir, rel);
  const st = await userStat(su, abs);
  if (!st) throw notFound();
  if (st.isFile) {
    await sendUserFile(req, res, su, abs, { download: true });
    return;
  }
  const name = `${rel ? path.basename(abs) : slugify(project.name)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition('attachment', name));
  const child = userZip(su, abs, req.query.git === '1');
  child.on('error', () => res.destroy());
  child.on('close', (code) => {
    if (code !== 0 && code !== 12) res.destroy();
  });
  child.stdout!.pipe(res);
  res.on('close', () => child.kill());
});

// ---- preview -------------------------------------------------------------------
projectsRouter.post('/projects/:id/preview', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ path: z.string().max(512).optional() }), req.body ?? {});
  const entry = (body.path || projectSettings(project).previewPath || 'index.html').replace(/^\/+/, '');
  const token = signToken({ p: project.id, u: project.owner_id }, 12 * 3600);
  res.json({ base: `/preview/${token}/`, url: `/preview/${token}/${entry.split('/').map(encodeURIComponent).join('/')}` });
});

export const previewRouter = Router();

previewRouter.get('/preview/:token{/*path}', async (req, res) => {
  const data = verifyToken<{ p: number; u: number }>(String(req.params.token));
  if (!data) throw new HttpError(403, 'Preview link expired — reopen the preview');
  const project = await getProjectRow(Number(data.p));
  if (!project || project.owner_id !== Number(data.u)) throw notFound();
  const su = await ensureSysUser(project.owner_id);
  const dir = projectDir(project);
  let abs = resolveIn(dir, wildcard(req.params.path));
  const st = await userStat(su, abs);
  if (st?.isDir) {
    if (!req.originalUrl.split('?')[0].endsWith('/')) {
      res.redirect(301, req.originalUrl.replace(/(\?|$)/, '/$1'));
      return;
    }
    abs = path.join(abs, 'index.html');
  }
  await sendUserFile(req, res, su, abs, { mode: 'preview' });
});

// ---- history -----------------------------------------------------------------
projectsRouter.get('/projects/:id/history', async (req, res) => {
  const { su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  res.json({ commits: await history(su, dir, 200) });
});

projectsRouter.get('/projects/:id/history/:sha', async (req, res) => {
  const { su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  res.json({ stat: await diffStat(su, dir, String(req.params.sha)) });
});

projectsRouter.post('/projects/:id/history/restore', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  if (hooks.isProjectBusy(project.id)) throw new HttpError(409, 'Claude is working in this project — stop it first');
  const body = parse(z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }), req.body);
  const r = await restore(su, dir, body.sha, authorOf(req.user!));
  notifyProjectChanged(project.id);
  res.json({ ok: true, commit: r });
});

projectsRouter.post('/projects/:id/checkpoint', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ message: z.string().trim().max(200).optional() }), req.body ?? {});
  const r = await checkpoint(su, dir, body.message || 'Manual checkpoint', authorOf(req.user!));
  notifyProjectChanged(project.id);
  res.json({ ok: true, commit: r });
});
